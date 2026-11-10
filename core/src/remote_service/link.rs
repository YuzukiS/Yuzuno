//! One SSH connection to one remote session (YN-83 S1 PR4a).
//!
//! The Workspace's registry (registry.rs) starts each Link, for
//! `/api/machine-live`; this module never retries or reconnects by itself.
//!
//! [`Link::start`] spawns exactly one session, when its caller asks, from an
//! immutable machine snapshot (target and root, validated again here), the
//! caller's generation and the program built into this Core. One background
//! task then owns the OpenSSH child and its three pipes: it boots (design v4
//! A2), checks the hello (A3), watches the data root once, pings every 10 s,
//! publishes each checked load, and ends with one [`Terminal`]. It never
//! spawns again. The Terminal says whether the exit was proven clean, whether
//! the caller may back off and start anew, or whether it must stop.
//!
//! Bounded throughout (design v4 A8): 65 s from spawn to a valid hello, 10 s
//! for each write, 30 s without a complete frame, 10 s for a close, 2 s for
//! the exit once stdout ends and 2 s after SIGKILL; lines of 256 KiB, 64 KiB
//! of login noise, the first 8 KiB of stderr. Reading, writing, stderr and
//! the deadlines run apart, so a write that cannot go through never holds up
//! a read, a close or the exit. A child that is still not reaped is handed,
//! with sole ownership, to a reaper that waits until a real wait returns;
//! only that opens its [`ReapGate`].
//!
//! Every Snapshot and Terminal carries the generation it was started with,
//! so a caller can drop what an older generation says late. The remote's
//! values are only shown: none enters a command, a path or admission.
#![cfg_attr(not(test), allow(dead_code))]

use super::package;
use super::protocol::{self, After, BootLine, Bye, Code, Exit, Facts, Frame, Hello, Load, Stderr};
use crate::remote::{validate_machine, RemoteMachine};
use anyhow::{bail, Result};
use serde_json::{json, Value};
use std::process::Stdio;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::process::Child;
use tokio::sync::{mpsc, oneshot, watch};
use tokio::task::JoinHandle;
use tokio::time::{sleep_until, timeout, MissedTickBehavior};

/// The longest line either way (jobs/remote.rs REPLY_LIMIT, program.py FRAME_LIMIT).
pub(crate) const FRAME_LIMIT: usize = 256 * 1024;
/// Unmarked lines before `ready`, together (remote.rs keeps 64 KiB of output too).
const NOISE_LIMIT: usize = 64 * 1024;
/// stderr kept for the classification, as jobs/remote.rs keeps 8192 bytes.
const STDERR_HEAD: usize = 8 * 1024;
/// boot.py's MAX_LINE.
const FIRST_LINE_LIMIT: usize = 4096;
/// Frames waiting for the writer. S1 sends one every 10 s, so the queue is
/// full only while a write is stuck, which the writer's own limit ends.
const WRITE_QUEUE: usize = 8;
const READ_QUEUE: usize = 16;

#[derive(Clone, Copy, Debug)]
pub(crate) struct Limits {
    /// From spawn to a valid hello.
    pub handshake: Duration,
    /// Each write: the first line, the upload, watch, ping, close.
    pub write: Duration,
    pub ping: Duration,
    /// Without a complete frame, once online.
    pub silence: Duration,
    /// For bye and the end of stdout once close is sent.
    pub close: Duration,
    /// For the exit once stdout has ended.
    pub exit_wait: Duration,
    /// For the exit after SIGKILL.
    pub kill_wait: Duration,
}

impl Limits {
    /// Design v4 A8.
    pub(crate) const PRODUCTION: Limits = Limits {
        handshake: Duration::from_secs(65),
        write: Duration::from_secs(10),
        ping: Duration::from_secs(10),
        silence: Duration::from_secs(30),
        close: Duration::from_secs(10),
        exit_wait: Duration::from_secs(2),
        kill_wait: Duration::from_secs(2),
    };
}

pub(crate) struct Options {
    /// OpenSSH, or a program with its argument conventions.
    pub ssh: String,
    pub limits: Limits,
    /// Tests: every wait for the child first waits until this is true, as
    /// for a child that cannot be reaped.
    #[cfg(test)]
    pub hold_wait: Option<watch::Receiver<bool>>,
}

impl Default for Options {
    fn default() -> Self {
        Options {
            ssh: "ssh".into(),
            limits: Limits::PRODUCTION,
            #[cfg(test)]
            hold_wait: None,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Phase {
    Connecting,
    Online,
    /// Ending: Core asked the session to close, or a write failed and
    /// nothing more can be sent; what is left is read before the exit.
    Closing,
    Ended,
}

/// A value and when its line was read, on this Core's monotonic clock.
#[derive(Debug)]
pub(crate) struct Stamped<T> {
    pub value: T,
    pub received: Instant,
}

/// How old, at `now`, is a reading that was `age` old when sent and arrived
/// at `received`. Only this Core's clock: never the remote's wall clock.
pub(crate) fn age_at(received: Instant, age: Duration, now: Instant) -> Duration {
    now.saturating_duration_since(received).saturating_add(age)
}

/// The latest state, one value at a time: a slow reader never holds up the
/// session and loads never queue.
#[derive(Clone, Debug)]
pub(crate) struct Snapshot {
    pub generation: u64,
    pub phase: Phase,
    pub hello: Option<Arc<Stamped<Hello>>>,
    pub load: Option<Arc<Stamped<Load>>>,
    /// The last complete frame; part of a line never counts.
    pub last_frame: Option<Instant>,
    pub terminal: Option<Arc<Terminal>>,
}

/// What Core saw end the session first.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Ended {
    /// stdout ended after Core asked the session to close.
    Closed,
    /// stdout ended without Core asking.
    RemoteEnded,
    HandshakeTimeout,
    Silent,
    WriteStalled,
    /// A write failed (the remote closed its stdin); what came before the
    /// end of stdout and the exit decide.
    WriteFailed,
    /// The output broke the protocol, or came from another version.
    Invalid,
    CloseTimeout,
    /// The caller closed, or dropped the Link, before the hello.
    Cancelled,
    /// OpenSSH could not be started; nothing ran anywhere.
    NotStarted,
}

#[derive(Debug)]
pub(crate) struct Terminal {
    pub generation: u64,
    pub after: After,
    /// Why it cannot go on; None only when the exit was proven clean.
    pub code: Option<Code>,
    pub ended: Ended,
    pub exit: Exit,
    pub bye: Option<Bye>,
    /// The boot step asked for the program and Core queued it for writing
    /// (the write itself may still have failed).
    pub uploaded: bool,
    pub reap: ReapGate,
}

/// Opens once the session's OpenSSH child has been reaped by a wait that
/// returned: never on a kill, a timeout or a dropped task. Only this module
/// makes one, and only the child's owner holds what opens it. A caller keeps
/// it per machine, apart from any generation or fingerprint, and starts no
/// new session there while it is closed.
#[derive(Clone, Debug)]
pub(crate) struct ReapGate(watch::Receiver<bool>);

impl ReapGate {
    pub(crate) fn is_reaped(&self) -> bool {
        *self.0.borrow()
    }

    /// Returns once reaped; never, if the child was dropped unreaped.
    pub(crate) async fn reaped(&self) {
        let mut gate = self.0.clone();
        if gate.wait_for(|reaped| *reaped).await.is_err() {
            std::future::pending::<()>().await;
        }
    }
}

/// The child, with the only sender of its gate.
struct Owned {
    child: Child,
    reaped: watch::Sender<bool>,
    #[cfg(test)]
    hold: Option<watch::Receiver<bool>>,
}

impl Owned {
    async fn wait(&mut self) -> std::io::Result<std::process::ExitStatus> {
        #[cfg(test)]
        {
            if let Some(hold) = &mut self.hold {
                if hold.wait_for(|open| *open).await.is_err() {
                    std::future::pending::<()>().await;
                }
            }
        }
        let status = self.child.wait().await?;
        self.reaped.send_replace(true);
        Ok(status)
    }
}

pub(crate) struct Link {
    generation: u64,
    state: watch::Receiver<Snapshot>,
    close: Option<oneshot::Sender<()>>,
    reap: ReapGate,
}

impl Link {
    /// Spawns one session on `machine` over its own SSH connection (never a
    /// shared one), with the fixed boot code as the only remote command.
    /// Inside a Tokio runtime only. A machine that does not validate starts
    /// nothing. Dropping the Link closes the session as `close` does.
    pub(crate) fn start(machine: &RemoteMachine, generation: u64, options: Options) -> Result<Link> {
        validate_machine(machine)?;
        let nonce = uuid::Uuid::new_v4().simple().to_string();
        let root = machine.root().to_owned();
        let first = line(&json!({"v": 1, "nonce": nonce, "digest": package::digest(), "root": root}));
        if first.len() > FIRST_LINE_LIMIT {
            bail!("the first line is over {FIRST_LINE_LIMIT} bytes");
        }
        let (reaped, gate) = watch::channel(false);
        let reap = ReapGate(gate);
        let (state, receiver) = watch::channel(Snapshot {
            generation,
            phase: Phase::Connecting,
            hello: None,
            load: None,
            last_frame: None,
            terminal: None,
        });
        let (close, closing) = oneshot::channel();
        let link = Link { generation, state: receiver, close: Some(close), reap: reap.clone() };
        let spawned = package::boot_command_with(&options.ssh, machine)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true)
            .spawn();
        let mut child = match spawned {
            Ok(child) => child,
            Err(_) => {
                reaped.send_replace(true);
                let terminal = Terminal {
                    generation,
                    after: After::Stop,
                    code: Some(Code::SshFailed),
                    ended: Ended::NotStarted,
                    exit: Exit::NoChild,
                    bye: None,
                    uploaded: false,
                    reap,
                };
                state.send_modify(|now| {
                    now.phase = Phase::Ended;
                    now.terminal = Some(Arc::new(terminal));
                });
                return Ok(link);
            }
        };
        let pipes = (child.stdin.take(), child.stdout.take(), child.stderr.take());
        let owned = Owned {
            child,
            reaped,
            #[cfg(test)]
            hold: options.hold_wait,
        };
        let limits = options.limits;
        let stderr = Arc::new(Mutex::new(Stderr::default()));
        let (Some(stdin), Some(stdout), Some(error)) = pipes else {
            // Piped stdio always has all three; still, never lose the child.
            let drained = tokio::spawn(async {});
            tokio::spawn(async move {
                let exit = settle(owned, drained, limits, Then::Kill).await;
                let terminal = Terminal {
                    generation,
                    after: After::Stop,
                    code: Some(Code::UncleanExit),
                    ended: Ended::RemoteEnded,
                    exit,
                    bye: None,
                    uploaded: false,
                    reap,
                };
                state.send_modify(|now| {
                    now.phase = Phase::Ended;
                    now.terminal = Some(Arc::new(terminal));
                });
            });
            return Ok(link);
        };
        let stderr_task = tokio::spawn(drain_stderr(error, stderr.clone()));
        let (lines_in, lines) = mpsc::channel(READ_QUEUE);
        let reader = tokio::spawn(read_lines(stdout, lines_in));
        let (frames, queued) = mpsc::channel(WRITE_QUEUE);
        let (wrote, written) = oneshot::channel();
        let writer = tokio::spawn(async move {
            let _ = wrote.send(write_frames(stdin, queued, limits.write).await);
        });
        let driver = Driver {
            generation,
            limits,
            nonce,
            root,
            state,
            closing,
            close_asked: false,
            child: owned,
            frames: Some(frames),
            written,
            write_ended: false,
            lines,
            reader,
            writer,
            stderr,
            stderr_task,
            reap,
            stdout_seen: false,
            uploaded: false,
            refused: None,
            bye: None,
            eof: false,
            detected: None,
            ended: None,
            drain_by: None,
            last_frame: Instant::now(),
            next_id: 0,
        };
        tokio::spawn(driver.run(first));
        Ok(link)
    }

    pub(crate) fn generation(&self) -> u64 {
        self.generation
    }

    pub(crate) fn snapshot(&self) -> Snapshot {
        self.state.borrow().clone()
    }

    pub(crate) fn subscribe(&self) -> watch::Receiver<Snapshot> {
        self.state.clone()
    }

    pub(crate) fn reap_gate(&self) -> ReapGate {
        self.reap.clone()
    }

    /// Asks the session to end: a close frame once online, so that its exit
    /// can still be proven clean, or SIGKILL while it boots. Once is enough.
    pub(crate) fn close(&mut self) {
        if let Some(close) = self.close.take() {
            let _ = close.send(());
        }
    }

    /// A Link with no session behind it, whose state, close and gate a test
    /// drives (registry_tests.rs).
    #[cfg(test)]
    pub(crate) fn fake(generation: u64) -> (Link, FakeLink) {
        let (reaped, gate) = watch::channel(false);
        let (state, receiver) = watch::channel(Snapshot {
            generation,
            phase: Phase::Connecting,
            hello: None,
            load: None,
            last_frame: None,
            terminal: None,
        });
        let (close, closing) = oneshot::channel();
        let reap = ReapGate(gate);
        let link = Link { generation, state: receiver, close: Some(close), reap: reap.clone() };
        (link, FakeLink { state, closing, reaped, reap })
    }

    pub(crate) async fn ended(&mut self) -> Arc<Terminal> {
        if let Ok(now) = self.state.wait_for(|now| now.terminal.is_some()).await {
            if let Some(terminal) = &now.terminal {
                return terminal.clone();
            }
        }
        std::future::pending().await
    }
}

/// What a test holds of a fake Link: its state, the close it was asked for
/// (or the Link dropped) and the sender that opens its gate.
#[cfg(test)]
pub(crate) struct FakeLink {
    pub state: watch::Sender<Snapshot>,
    pub closing: oneshot::Receiver<()>,
    pub reaped: watch::Sender<bool>,
    pub reap: ReapGate,
}

/// After the session's output is done with: wait for the exit (stdout
/// ended), or kill at once.
enum Then {
    Wait,
    Kill,
}

struct Driver {
    generation: u64,
    limits: Limits,
    nonce: String,
    root: String,
    state: watch::Sender<Snapshot>,
    closing: oneshot::Receiver<()>,
    close_asked: bool,
    child: Owned,
    frames: Option<mpsc::Sender<Vec<u8>>>,
    written: oneshot::Receiver<WriteEnd>,
    write_ended: bool,
    lines: mpsc::Receiver<Read>,
    reader: JoinHandle<()>,
    writer: JoinHandle<()>,
    stderr: Arc<Mutex<Stderr>>,
    stderr_task: JoinHandle<()>,
    reap: ReapGate,
    // What was seen.
    stdout_seen: bool,
    uploaded: bool,
    refused: Option<Code>,
    bye: Option<Bye>,
    eof: bool,
    detected: Option<Code>,
    ended: Option<Ended>,
    /// Set once a write failed: nothing more is sent, and what is left is
    /// read, by the same rules, until stdout ends or this passes.
    drain_by: Option<Instant>,
    last_frame: Instant,
    next_id: u64,
}

impl Driver {
    async fn run(mut self, first: Vec<u8>) {
        let then = self.talk(first).await;
        // The writer and reader end here: stdin closes, nothing more is read.
        self.frames = None;
        self.writer.abort();
        self.reader.abort();
        let exit = settle(self.child, self.stderr_task, self.limits, then).await;
        let stderr = self.stderr.lock().map(|head| head.clone()).unwrap_or_default();
        let (after, code) = protocol::classify(&Facts {
            detected: self.detected,
            exit,
            stdout_seen: self.stdout_seen,
            refused: self.refused,
            bye_clean: self.bye.as_ref().is_some_and(|bye| bye.clean),
            eof: self.eof,
            stderr: &stderr,
        });
        let terminal = Arc::new(Terminal {
            generation: self.generation,
            after,
            code,
            ended: self.ended.unwrap_or(Ended::RemoteEnded),
            exit,
            bye: self.bye,
            uploaded: self.uploaded,
            reap: self.reap,
        });
        self.state.send_modify(|now| {
            now.phase = Phase::Ended;
            now.terminal = Some(terminal);
        });
    }

    /// The boot and the session, until its output is done with.
    async fn talk(&mut self, first: Vec<u8>) -> Then {
        let mut deadline = Instant::now() + self.limits.handshake;
        self.send(first);
        let mut needed = false;
        let mut ready = false;
        let mut noise = 0usize;
        let (hello, at) = loop {
            tokio::select! {
                read = self.lines.recv() => match read {
                    Some(Read::Line(line, at)) => {
                        self.stdout_seen = true;
                        if ready {
                            // The line right after ready, and nothing else, is the hello.
                            match protocol::hello(&line, package::digest()) {
                                Ok(hello) => break (hello, at),
                                Err(code) => return self.invalid(code),
                            }
                        }
                        if self.refused.is_some() {
                            // Refused: only the exit is left to see.
                            continue;
                        }
                        match protocol::boot_line(&line, &self.nonce) {
                            BootLine::Noise => {
                                noise += line.len() + 1;
                                if noise > NOISE_LIMIT {
                                    return self.invalid(Code::Protocol);
                                }
                            }
                            BootLine::Need if !needed => {
                                needed = true;
                                self.uploaded = self.send(upload());
                            }
                            BootLine::Ready => ready = true,
                            BootLine::Refused(code) => self.refused = Some(code),
                            // A second need, or a marked line the boot step never writes.
                            BootLine::Need | BootLine::Invalid => return self.invalid(Code::Protocol),
                        }
                    }
                    other => return self.stdout_ended(other),
                },
                _ = sleep_until(deadline.into()) => return self.end(Ended::HandshakeTimeout, Then::Kill),
                end = &mut self.written, if !self.write_ended => {
                    self.write_ended = true;
                    if matches!(end, Ok(WriteEnd::Stalled)) {
                        return self.end(Ended::WriteStalled, Then::Kill);
                    }
                    deadline = deadline.min(self.cannot_write());
                }
                _ = &mut self.closing, if !self.close_asked => {
                    self.close_asked = true;
                    return self.end(Ended::Cancelled, Then::Kill);
                }
            }
        };
        self.last_frame = at;
        let hello = Arc::new(Stamped { value: hello, received: at });
        let phase = if self.drain_by.is_some() { Phase::Closing } else { Phase::Online };
        self.state.send_modify(|now| {
            now.phase = phase;
            now.hello = Some(hello);
            now.last_frame = Some(at);
        });
        // The one watch of this session: S1 watches the data root only, and
        // a new root is a new session.
        let id = self.id();
        let watch = json!({"id": id, "op": "watch", "args": {"paths": [{"role": "root", "path": self.root}]}});
        self.send(line(&watch));
        let start = Instant::now() + self.limits.ping;
        let mut ping = tokio::time::interval_at(start.into(), self.limits.ping);
        ping.set_missed_tick_behavior(MissedTickBehavior::Delay);
        // Once set (asked to close, or a write failed) no ping goes out and the
        // session must end by then.
        let mut close_by: Option<Instant> = self.drain_by;
        loop {
            let silent_at = self.last_frame + self.limits.silence;
            tokio::select! {
                read = self.lines.recv() => match read {
                    Some(Read::Line(line, at)) => {
                        self.last_frame = at;
                        if self.bye.is_some() {
                            // bye is the last frame.
                            return self.invalid(Code::Protocol);
                        }
                        match protocol::frame(&line) {
                            Ok(Frame::Load(load)) => {
                                let load = Arc::new(Stamped { value: load, received: at });
                                self.state.send_modify(|now| {
                                    now.load = Some(load);
                                    now.last_frame = Some(at);
                                });
                            }
                            Ok(Frame::Bye(bye)) => {
                                self.bye = Some(bye);
                                self.state.send_modify(|now| now.last_frame = Some(at));
                            }
                            Ok(Frame::Reply | Frame::Other) => self.state.send_modify(|now| now.last_frame = Some(at)),
                            Err(code) => return self.invalid(code),
                        }
                    }
                    other => return self.stdout_ended(other),
                },
                _ = ping.tick(), if close_by.is_none() => {
                    let id = self.id();
                    self.send(line(&json!({"id": id, "op": "ping"})));
                }
                _ = sleep_until(silent_at.into()) => return self.end(Ended::Silent, Then::Kill),
                end = &mut self.written, if !self.write_ended => {
                    self.write_ended = true;
                    if matches!(end, Ok(WriteEnd::Stalled)) {
                        return self.end(Ended::WriteStalled, Then::Kill);
                    }
                    let until = self.cannot_write();
                    close_by = Some(close_by.map_or(until, |by| by.min(until)));
                }
                _ = &mut self.closing, if !self.close_asked => {
                    self.close_asked = true;
                    // Already ending after a failed write: nothing to send.
                    if close_by.is_none() {
                        close_by = Some(Instant::now() + self.limits.close);
                        self.state.send_modify(|now| now.phase = Phase::Closing);
                        let id = self.id();
                        self.send(line(&json!({"id": id, "op": "close"})));
                    }
                }
                _ = sleep_until(close_by.unwrap_or(silent_at).into()), if close_by.is_some() => {
                    return self.end(Ended::CloseTimeout, Then::Kill);
                }
            }
        }
    }

    /// A write failed (EPIPE or another error): nothing more can be sent.
    /// Reading goes on with the same checks for at most the exit wait, so a
    /// refusal or a bye still counts. Returns when it must have ended.
    fn cannot_write(&mut self) -> Instant {
        self.ended.get_or_insert(Ended::WriteFailed);
        self.frames = None;
        self.state.send_modify(|now| now.phase = Phase::Closing);
        let until = Instant::now() + self.limits.exit_wait;
        *self.drain_by.get_or_insert(until)
    }

    fn stdout_ended(&mut self, read: Option<Read>) -> Then {
        match read {
            Some(Read::Eof { partial }) => {
                self.stdout_seen |= partial;
                if partial && self.bye.is_some() {
                    // bye is the last frame: not even the start of another may follow.
                    return self.invalid(Code::Protocol);
                }
                self.eof = true;
                let ended = if self.close_asked { Ended::Closed } else { Ended::RemoteEnded };
                self.end(ended, Then::Wait)
            }
            Some(Read::Oversize) => {
                self.stdout_seen = true;
                self.invalid(Code::Protocol)
            }
            // A read error, or a reader gone: stdout is not known to have ended.
            _ => self.end(Ended::RemoteEnded, Then::Kill),
        }
    }

    fn invalid(&mut self, code: Code) -> Then {
        self.detected.get_or_insert(code);
        self.end(Ended::Invalid, Then::Kill)
    }

    fn end(&mut self, ended: Ended, then: Then) -> Then {
        self.ended.get_or_insert(ended);
        then
    }

    fn id(&mut self) -> u64 {
        self.next_id += 1;
        self.next_id
    }

    /// Queues a frame for the writer; false once writing has failed. The
    /// queue is full only while a write is stuck, which ends the session
    /// soon; a frame left out is whole, so the stream stays intact.
    fn send(&mut self, frame: Vec<u8>) -> bool {
        self.frames.as_ref().is_some_and(|frames| frames.try_send(frame).is_ok())
    }
}

fn line(value: &Value) -> Vec<u8> {
    let mut bytes = value.to_string().into_bytes();
    bytes.push(b'\n');
    bytes
}

/// The answer to `need`: the length on its own line, then the program.
fn upload() -> Vec<u8> {
    let bytes = package::bytes();
    let mut upload = format!("{}\n", bytes.len()).into_bytes();
    upload.extend_from_slice(bytes);
    upload
}

/// Waits for the exit (only after stdout ended), then SIGKILL and waits
/// again; a child still not reaped goes to `reap` with its stderr drain.
async fn settle(mut child: Owned, stderr: JoinHandle<()>, limits: Limits, then: Then) -> Exit {
    let mut status = None;
    if matches!(then, Then::Wait) {
        status = timeout(limits.exit_wait, child.wait()).await.ok().and_then(Result::ok);
    }
    if status.is_none() {
        let _ = child.child.start_kill();
        status = timeout(limits.kill_wait, child.wait()).await.ok().and_then(Result::ok);
    }
    match status {
        Some(status) => {
            finish(stderr, limits.exit_wait).await;
            status.code().map_or(Exit::Signal, Exit::Code)
        }
        None => {
            tokio::spawn(reap(child, stderr, limits.exit_wait));
            Exit::Unknown
        }
    }
}

/// Holds the child until a wait returns, however long that takes.
async fn reap(mut child: Owned, stderr: JoinHandle<()>, wait: Duration) {
    while child.wait().await.is_err() {
        tokio::time::sleep(Duration::from_secs(1)).await;
    }
    finish(stderr, wait).await;
}

/// stderr is drained until it ends; once the child is gone, for `wait` more
/// at most (a process it left behind may still hold the pipe).
async fn finish(mut task: JoinHandle<()>, wait: Duration) {
    if timeout(wait, &mut task).await.is_err() {
        task.abort();
    }
}

pub(super) async fn drain_stderr<R: AsyncRead + Unpin>(mut input: R, head: Arc<Mutex<Stderr>>) {
    let mut chunk = vec![0u8; 8192];
    loop {
        match input.read(&mut chunk).await {
            Ok(0) => {
                if let Ok(mut head) = head.lock() {
                    head.complete = true;
                }
                return;
            }
            Ok(count) => {
                if let Ok(mut head) = head.lock() {
                    let keep = count.min(STDERR_HEAD.saturating_sub(head.head.len()));
                    head.head.extend_from_slice(&chunk[..keep]);
                    head.truncated |= keep < count;
                }
            }
            Err(error) if error.kind() == std::io::ErrorKind::Interrupted => {}
            Err(_) => return,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum WriteEnd {
    /// The queue closed and stdin was shut.
    Done,
    /// One write did not go through within its limit.
    Stalled,
    /// EPIPE: the other end closed stdin.
    Closed,
    Failed,
}

pub(super) async fn write_frames<W: AsyncWrite + Unpin>(mut out: W, mut frames: mpsc::Receiver<Vec<u8>>, limit: Duration) -> WriteEnd {
    while let Some(frame) = frames.recv().await {
        match timeout(limit, async {
            out.write_all(&frame).await?;
            out.flush().await
        })
        .await
        {
            Err(_) => return WriteEnd::Stalled,
            Ok(Err(error)) if error.kind() == std::io::ErrorKind::BrokenPipe => return WriteEnd::Closed,
            Ok(Err(_)) => return WriteEnd::Failed,
            Ok(Ok(())) => {}
        }
    }
    let _ = timeout(limit, out.shutdown()).await;
    WriteEnd::Done
}

#[derive(Debug)]
pub(super) enum Read {
    /// A complete line, without its newline, and when it was read.
    Line(Vec<u8>, Instant),
    /// stdout ended; `partial` when a line was left without its newline.
    Eof { partial: bool },
    /// A line longer than FRAME_LIMIT.
    Oversize,
    Failed,
}

async fn read_lines<R: AsyncRead + Unpin>(input: R, lines: mpsc::Sender<Read>) {
    let mut reader = LineReader::new(input, FRAME_LIMIT);
    loop {
        let read = reader.next().await;
        let more = matches!(read, Read::Line(..));
        if lines.send(read).await.is_err() || !more {
            return;
        }
    }
}

/// Lines of at most `limit` bytes from a buffer of exactly `limit + 1`.
pub(super) struct LineReader<R> {
    input: R,
    pub(super) buffer: Box<[u8]>,
    start: usize,
    end: usize,
    scanned: usize,
}

impl<R: AsyncRead + Unpin> LineReader<R> {
    pub(super) fn new(input: R, limit: usize) -> Self {
        LineReader { input, buffer: vec![0; limit + 1].into_boxed_slice(), start: 0, end: 0, scanned: 0 }
    }

    pub(super) async fn next(&mut self) -> Read {
        loop {
            if let Some(found) = self.buffer[self.scanned..self.end].iter().position(|byte| *byte == b'\n') {
                let at = self.scanned + found;
                let line = self.buffer[self.start..at].to_vec();
                self.start = at + 1;
                self.scanned = self.start;
                return Read::Line(line, Instant::now());
            }
            self.scanned = self.end;
            if self.start > 0 {
                self.buffer.copy_within(self.start..self.end, 0);
                self.end -= self.start;
                self.scanned = self.end;
                self.start = 0;
            }
            if self.end == self.buffer.len() {
                return Read::Oversize;
            }
            match self.input.read(&mut self.buffer[self.end..]).await {
                Ok(0) => return Read::Eof { partial: self.end > 0 },
                Ok(count) => self.end += count,
                Err(error) if error.kind() == std::io::ErrorKind::Interrupted => {}
                Err(_) => return Read::Failed,
            }
        }
    }
}
