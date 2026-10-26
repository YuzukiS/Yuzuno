//! A small transport around the official Codex app-server JSON-RPC protocol.
//! Native items and server requests remain intact; no unified harness protocol.
use anyhow::{anyhow, Context, Result};
use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    process::Stdio,
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc,
    },
};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    net::TcpStream,
    process::{Child, Command},
    sync::{mpsc, oneshot, watch, Mutex},
    time::{timeout, Duration, Instant},
};
use tokio_tungstenite::{tungstenite::Message, MaybeTlsStream, WebSocketStream};

use crate::backlog::EventSender;

type Reply = oneshot::Sender<Result<Value>>;

/// The server may already have accepted the operation. Retrying it is not safe
/// until the caller has reconciled the original thread.
#[derive(Clone, Debug)]
pub struct OutcomeUnknown(pub String);

impl std::fmt::Display for OutcomeUnknown {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}
impl std::error::Error for OutcomeUnknown {}

/// Preserve the native error code/data. Recovery decisions must not treat an
/// arbitrary transport, permission, or protocol failure as a missing session.
#[derive(Clone, Debug)]
pub struct RpcError {
    pub code: i64,
    pub message: String,
    pub data: Option<Value>,
}

impl std::fmt::Display for RpcError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}
impl std::error::Error for RpcError {}

impl RpcError {
    /// Another client holds this thread's native writer lock. Measured with
    /// Codex 0.162.1 (resume rejected while a shared daemon owned the thread).
    pub fn reports_active_writer(&self, thread_id: &str) -> bool {
        self.message == format!("thread {thread_id} already has an active writer")
    }

    pub fn confirms_missing_rollout(&self, thread_id: &str) -> bool {
        // Measured against Codex 0.162.1 in two independent stdio processes.
        // `thread not loaded` and other -32600 errors are deliberately excluded.
        self.code == -32600
            && self.message == format!("no rollout found for thread id {thread_id}")
            && self.data.is_none()
    }
}

pub struct Rpc {
    tx: mpsc::Sender<Value>,
    pending: Arc<Mutex<HashMap<u64, Reply>>>,
    next: AtomicU64,
    shutdown: watch::Sender<bool>,
    stopped: watch::Receiver<bool>,
    /// The local app-server's process, for Machine Load (machine_load). None
    /// for a remote runtime: its tunnel is not the Agent's work.
    pid: Option<u32>,
}

/// One native request, including its late response. Waiting again does not
/// submit again. Used for an attach whose timeout must keep accepted work alive.
pub(crate) struct PendingReply {
    id: u64,
    rx: oneshot::Receiver<Result<Value>>,
    /// Shared with what `wait` handed out, never changed (T-140).
    result: Option<Result<Arc<Value>>>,
}

impl PendingReply {
    /// Receives the reply once and keeps it; a timeout leaves it to wait for
    /// again.
    async fn receive(&mut self, limit: Duration) -> Result<()> {
        if self.result.is_none() {
            self.result = Some(match timeout(limit, &mut self.rx).await {
                Ok(Ok(result)) => result.map(Arc::new),
                Ok(Err(_)) => Err(OutcomeUnknown("Codex 连接在请求期间结束；操作结果尚未确认".into()).into()),
                Err(_) => return Err(OutcomeUnknown("Codex 请求超时；操作结果尚未确认，请勿重复发送原任务".into()).into()),
            });
        }
        Ok(())
    }

    /// The reply, kept for waiting again: an attach that is checked again
    /// after a failed or interrupted write finishes from it. Each wait shares
    /// it, unchanged; a resumed Thread's history is not copied (T-140).
    pub(crate) async fn wait(&mut self, limit: Duration) -> Result<Arc<Value>> {
        self.receive(limit).await?;
        match self.result.as_ref().unwrap() {
            Ok(value) => Ok(Arc::clone(value)),
            Err(error) => Err(if let Some(error) = error.downcast_ref::<RpcError>() {
                error.clone().into()
            } else if let Some(error) = error.downcast_ref::<OutcomeUnknown>() {
                error.clone().into()
            } else {
                anyhow!(error.to_string())
            }),
        }
    }

    /// The reply, handed over whole to a caller that will not wait for it
    /// again; a resumed or read Thread's history is not copied (T-140).
    /// Only a reply `wait` already shared, and still shared, is copied.
    pub(crate) async fn into_result(mut self, limit: Duration) -> Result<Value> {
        self.receive(limit).await?;
        self.result.take().unwrap().map(Arc::unwrap_or_clone)
    }
}

impl Rpc {
    pub async fn spawn(
        program: &str,
        extra_args: &[String],
        events: impl Into<EventSender>,
    ) -> Result<Arc<Self>> {
        Self::spawn_in(program, extra_args, events, None).await
    }

    pub(crate) async fn spawn_in(
        program: &str,
        extra_args: &[String],
        events: impl Into<EventSender>,
        cwd: Option<&std::path::Path>,
    ) -> Result<Arc<Self>> {
        let events = events.into();
        let mut command = Command::new(program);
        if let Some(cwd) = cwd {
            command.current_dir(cwd);
        }
        let mut child = command
            .args(extra_args)
            .args(["app-server", "--stdio"])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .kill_on_drop(true)
            .spawn()
            .context("Could not start Codex: install the official Codex CLI on the Core host and sign in to it")?;
        let mut stdin = child.stdin.take().context("Codex stdin 不可用")?;
        let stdout = child.stdout.take().context("Codex stdout 不可用")?;
        let (tx, mut rx) = mpsc::channel::<Value>(256);
        let (shutdown, mut shutdown_rx) = watch::channel(false);
        let (stopped_tx, stopped) = watch::channel(false);
        let pending: Arc<Mutex<HashMap<u64, Reply>>> = Arc::new(Mutex::new(HashMap::new()));
        let rpc = Arc::new(Self {
            tx,
            pending: pending.clone(),
            next: AtomicU64::new(1),
            shutdown,
            stopped,
            pid: child.id(),
        });
        tokio::spawn(async move {
            let write = async {
                while let Some(msg) = rx.recv().await {
                    let mut bytes = serde_json::to_vec(&msg)?;
                    bytes.push(b'\n');
                    stdin.write_all(&bytes).await?;
                    stdin.flush().await?;
                }
                Result::<()>::Ok(())
            };
            let read = async {
                let mut reader = BufReader::new(stdout);
                while let Some((message, bytes)) = read_message(&mut reader).await.context("Codex 返回了无法解析的协议消息")? {
                    dispatch(message, bytes, &pending, &events).await?;
                }
                Result::<()>::Ok(())
            };
            let outcome = tokio::select! {
                r=write=>r, r=read=>r,
                _=shutdown_rx.changed()=>Ok(()),
            };
            let _ = child.kill().await;
            let _ = child.wait().await;
            let reason = outcome
                .err()
                .map(|e| e.to_string())
                .unwrap_or_else(|| "Codex 连接已结束".into());
            disconnected(reason, &pending, &events).await;
            let _ = stopped_tx.send(true);
        });
        Ok(rpc)
    }

    /// The child owns only an SSH tunnel, never the remote detached app-server.
    pub(crate) fn websocket(
        mut socket: WebSocketStream<MaybeTlsStream<TcpStream>>,
        mut tunnel: Child,
        events: impl Into<EventSender>,
    ) -> Arc<Self> {
        let events = events.into();
        let (tx, mut rx) = mpsc::channel::<Value>(256);
        let (shutdown, mut shutdown_rx) = watch::channel(false);
        let (stopped_tx, stopped) = watch::channel(false);
        let pending = Arc::new(Mutex::new(HashMap::new()));
        let rpc = Arc::new(Self {
            tx,
            pending: pending.clone(),
            next: AtomicU64::new(1),
            shutdown,
            stopped,
            pid: None,
        });
        tokio::spawn(async move {
            let connection = async {
                let mut heartbeat = tokio::time::interval(Duration::from_secs(20));
                let mut last_received = Instant::now();
                loop {
                    tokio::select! {
                        outgoing=rx.recv()=>match outgoing {
                            Some(value)=>{
                                timeout(Duration::from_secs(20), socket.send(Message::Text(serde_json::to_string(&value)?.into())))
                                    .await.context("远程消息发送超时")??;
                            },
                            None=>break,
                        },
                        incoming=socket.next()=>match incoming {
                            Some(Ok(message))=>{
                                last_received=Instant::now();
                                match message {
                                    Message::Text(text)=>{
                                        let bytes = text.len();
                                        dispatch(parse_message(text.to_string()).await.context("远程 Codex 返回了无法解析的协议消息")?, bytes, &pending, &events).await?
                                    },
                                    Message::Ping(data)=>{
                                        timeout(Duration::from_secs(20), socket.send(Message::Pong(data))).await??;
                                    },
                                    Message::Close(_)=>break,
                                    Message::Pong(_)=>{},
                                    _=>return Err(anyhow!("远程 Codex 返回了非文字协议帧")),
                                }
                            },
                            Some(Err(error))=>return Err(error.into()),
                            None=>break,
                        },
                        _=heartbeat.tick()=>{
                            if last_received.elapsed()>Duration::from_secs(60) {
                                return Err(anyhow!("远程连接心跳超时"));
                            }
                            timeout(Duration::from_secs(20), socket.send(Message::Ping(Vec::new().into()))).await??;
                        },
                        status=tunnel.wait()=>return Err(anyhow!("SSH 隧道已结束：{}", status?)),
                    }
                }
                Result::<()>::Ok(())
            };
            let outcome = tokio::select! {
                result=connection=>result,
                _=shutdown_rx.changed()=>Ok(()),
            };
            // Dropping the socket and killing this local SSH process only
            // detaches the client. Native turns continue on the remote host.
            drop(socket);
            let _ = tunnel.kill().await;
            let _ = tunnel.wait().await;
            disconnected(
                outcome
                    .err()
                    .map(|e| e.to_string())
                    .unwrap_or_else(|| "远程连接已断开；Runtime 保留".into()),
                &pending,
                &events,
            )
            .await;
            let _ = stopped_tx.send(true);
        });
        rpc
    }

    /// The local app-server's process ID while it was started by this Rpc.
    pub(crate) fn pid(&self) -> Option<u32> {
        self.pid
    }

    pub(crate) fn is_running(&self) -> bool {
        !*self.stopped.borrow()
    }

    /// Non-blocking detach. Remote runtimes are intentionally not terminated.
    pub fn close(&self) {
        let _ = self.shutdown.send(true);
    }

    /// Wait until the owned local process/tunnel has exited. For SSH this only
    /// confirms tunnel shutdown; the remote helper separately stops its runtime.
    pub async fn close_and_wait(&self) -> Result<()> {
        self.close();
        let mut stopped = self.stopped.clone();
        timeout(Duration::from_secs(5), stopped.wait_for(|done| *done))
            .await.context("Runtime 尚未退出；Agent 未关闭，请稍后重试")?
            .context("无法确认 Runtime 退出；Agent 未关闭")?;
        Ok(())
    }

    pub async fn initialize(&self) -> Result<()> {
        // Named permission profiles use the native experimental `permissions`
        // field. Unknown server requests still fail closed in Workspace.
        self.request("initialize",json!({"clientInfo":{"name":"yuzuno_v2","title":"Yuzuno","version":"0.1.0"},"capabilities":{"experimentalApi":true}})).await?;
        self.send(json!({"method":"initialized"})).await
    }

    pub async fn send(&self, value: Value) -> Result<()> {
        self.tx.send(value).await.context("Codex 连接已关闭")
    }

    /// Used while a request/generation guard is held. Never waits for capacity.
    pub fn try_send(&self, value: Value) -> Result<()> {
        self.tx
            .try_send(value)
            .context("Codex 连接已关闭或发送队列已满；回答未提交")
    }

    pub async fn request(&self, method: &str, params: Value) -> Result<Value> {
        self.request_within(method, params, Duration::from_secs(45)).await
    }

    /// For operations whose native work scales with history, such as a fork.
    pub async fn request_within(&self, method: &str, params: Value, limit: Duration) -> Result<Value> {
        let reply = self.begin_request(method, params).await?;
        let id = reply.id;
        let result = reply.into_result(limit).await;
        self.pending.lock().await.remove(&id);
        result
    }

    pub(crate) async fn begin_request(&self, method: &str, params: Value) -> Result<PendingReply> {
        let id = self.next.fetch_add(1, Ordering::Relaxed);
        let (tx, rx) = oneshot::channel();
        self.pending.lock().await.insert(id, tx);
        if let Err(e) = self
            .send(json!({"id":id,"method":method,"params":params}))
            .await
        {
            self.pending.lock().await.remove(&id);
            return Err(e);
        }
        Ok(PendingReply { id, rx, result: None })
    }
}

/// Native messages can be megabytes (a resumed Thread's whole history, a large
/// command output); those are parsed on the blocking pool, not on an async
/// worker. Small ones, almost all of them, are parsed in place.
/// A native message longer than this is parsed only while holding LARGE:
/// one at a time in this Core, so the values they parse into (their largest
/// part) never add up. Its line is read without LARGE, so a line still
/// arriving (a slow remote, a process stalled mid-line) never holds up
/// another connection's.
pub(crate) const LARGE_MESSAGE: usize = 1 << 20;
static LARGE: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

/// The next line of `reader`, parsed, with its length; None at its end. As
/// `lines()` read them (a final line without a newline counts), but a long
/// one is parsed only once it holds LARGE.
pub(crate) async fn read_message<R: tokio::io::AsyncBufRead + Unpin>(reader: &mut R) -> Result<Option<(Value, usize)>> {
    let mut line = Vec::new();
    loop {
        let buf = reader.fill_buf().await?;
        if buf.is_empty() {
            break;
        }
        let (take, end) = match buf.iter().position(|b| *b == b'\n') {
            Some(at) => (at + 1, true),
            None => (buf.len(), false),
        };
        line.extend_from_slice(&buf[..take]);
        reader.consume(take);
        if end {
            break;
        }
    }
    if line.is_empty() {
        return Ok(None);
    }
    if line.last() == Some(&b'\n') {
        line.pop();
        if line.last() == Some(&b'\r') {
            line.pop();
        }
    }
    let bytes = line.len();
    let large = if bytes > LARGE_MESSAGE { Some(LARGE.lock().await) } else { None };
    let message = parse_message(String::from_utf8(line).context("协议消息不是 UTF-8")?).await?;
    drop(large);
    Ok(Some((message, bytes)))
}

pub(crate) async fn parse_message(text: String) -> Result<Value> {
    const LARGE: usize = 64 * 1024;
    if text.len() < LARGE {
        return Ok(serde_json::from_str(&text)?);
    }
    crate::db::blocking(move || Ok(serde_json::from_str(&text)?)).await
}

async fn dispatch(
    mut message: Value,
    bytes: usize,
    pending: &Mutex<HashMap<u64, Reply>>,
    events: &EventSender,
) -> Result<()> {
    if message.get("method").is_some() {
        events.send_sized(message, bytes).await.context("事件接收端已关闭")?;
    } else if let Some(id) = message["id"].as_u64() {
        if let Some(reply) = pending.lock().await.remove(&id) {
            let result = if let Some(error) = message.get("error") {
                match (error["code"].as_i64(), error["message"].as_str()) {
                    (Some(code), Some(message)) => Err(RpcError {
                        code,
                        message: message.into(),
                        data: error.get("data").filter(|v| !v.is_null()).cloned(),
                    }
                    .into()),
                    _ => Err(anyhow!("Codex 返回了无法识别的错误对象")),
                }
            } else {
                Ok(message.get_mut("result").map(Value::take).unwrap_or(Value::Null))
            };
            let _ = reply.send(result);
        }
    }
    Ok(())
}

async fn disconnected(
    reason: String,
    pending: &Mutex<HashMap<u64, Reply>>,
    events: &EventSender,
) {
    for (_, reply) in pending.lock().await.drain() {
        let _ = reply.send(Err(
            OutcomeUnknown(format!("{reason}；请求结果尚未确认")).into()
        ));
    }
    let _ = events
        .send(json!({"method":"yuzuno/disconnected","params":{"message":reason}}))
        .await;
}

#[cfg(all(test, unix))]
mod transport_tests {
    use super::*;
    use tokio::net::TcpListener;

    #[tokio::test]
    async fn websocket_preserves_native_requests_and_marks_lost_reply_unknown() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.unwrap();
            let mut socket = tokio_tungstenite::accept_async(stream).await.unwrap();
            let mut calls = 0;
            while let Some(Ok(message)) = socket.next().await {
                if let Message::Text(text) = message {
                    let value: Value = serde_json::from_str(&text).unwrap();
                    if value["method"] == "first" {
                        calls += 1;
                        socket.send(Message::Text(json!({"method":"item/commandExecution/requestApproval","id":0,"params":{"threadId":"remote"}}).to_string().into())).await.unwrap();
                        socket.send(Message::Text(json!({"id":value["id"],"error":{"code":-32600,"message":"native denied","data":{"reason":"original"}}}).to_string().into())).await.unwrap();
                    } else if value["method"] == "second" {
                        calls += 1;
                        break; // accepted a request, deliberately lose its reply
                    }
                }
            }
            calls
        });
        let (socket, _) = tokio_tungstenite::connect_async(format!("ws://{address}"))
            .await
            .unwrap();
        let tunnel = Command::new("sleep")
            .arg("60")
            .kill_on_drop(true)
            .spawn()
            .unwrap();
        let (events, mut rx) = mpsc::channel(10);
        let rpc = Rpc::websocket(socket, tunnel, events);
        let error = rpc.request("first", json!({})).await.unwrap_err();
        let native = error.downcast_ref::<RpcError>().unwrap();
        assert_eq!(native.code, -32600);
        assert_eq!(native.data, Some(json!({"reason":"original"})));
        let approval = rx.recv().await.unwrap();
        assert_eq!(approval["id"], 0);
        assert_eq!(approval["method"], "item/commandExecution/requestApproval");
        let error = rpc.request("second", json!({})).await.unwrap_err();
        assert!(error.downcast_ref::<OutcomeUnknown>().is_some());
        assert_eq!(rx.recv().await.unwrap()["method"], "yuzuno/disconnected");
        assert_eq!(
            server.await.unwrap(),
            2,
            "transport never retries a native operation"
        );
    }

    #[tokio::test]
    async fn request_within_drops_a_reply_after_its_timeout_and_answers_the_next_request() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.unwrap();
            let mut socket = tokio_tungstenite::accept_async(stream).await.unwrap();
            let mut calls = Vec::new();
            while let Some(Ok(message)) = socket.next().await {
                if let Message::Text(text) = message {
                    let value: Value = serde_json::from_str(&text).unwrap();
                    calls.push(value["method"].as_str().unwrap().to_owned());
                    if value["method"] == "slow" {
                        tokio::time::sleep(Duration::from_millis(300)).await;
                    }
                    socket.send(Message::Text(json!({"id":value["id"],"result":{"method":value["method"]}}).to_string().into())).await.unwrap();
                    if value["method"] == "fast" { break; }
                }
            }
            calls
        });
        let (socket, _) = tokio_tungstenite::connect_async(format!("ws://{address}")).await.unwrap();
        let tunnel = Command::new("sleep").arg("60").kill_on_drop(true).spawn().unwrap();
        let (events, _rx) = mpsc::channel(10);
        let rpc = Rpc::websocket(socket, tunnel, events);
        let error = rpc.request_within("slow", json!({}), Duration::from_millis(50)).await.unwrap_err();
        assert!(error.downcast_ref::<OutcomeUnknown>().is_some());
        assert!(rpc.pending.lock().await.is_empty(), "the timed-out request is no longer waited for");
        // Its reply arrives late, finds no receiver and is dropped.
        tokio::time::sleep(Duration::from_millis(400)).await;
        assert_eq!(rpc.request("fast", json!({})).await.unwrap(), json!({"method":"fast"}));
        assert!(rpc.pending.lock().await.is_empty());
        assert_eq!(server.await.unwrap(), ["slow", "fast"], "nothing is sent again");
    }

    #[tokio::test]
    async fn close_drops_ssh_transport_and_not_the_remote_listener() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.unwrap();
            let mut socket = tokio_tungstenite::accept_async(stream).await.unwrap();
            while let Some(Ok(_)) = socket.next().await {}
            // A new connection to the same runtime is still accepted.
            let (stream, _) = listener.accept().await.unwrap();
            tokio_tungstenite::accept_async(stream).await.unwrap()
        });
        let (socket, _) = tokio_tungstenite::connect_async(format!("ws://{address}"))
            .await
            .unwrap();
        let tunnel = Command::new("sleep")
            .arg("60")
            .kill_on_drop(true)
            .spawn()
            .unwrap();
        let pid = tunnel.id().unwrap();
        let (events, mut rx) = mpsc::channel(10);
        let rpc = Rpc::websocket(socket, tunnel, events);
        rpc.close();
        timeout(Duration::from_secs(3), async {
            assert_eq!(rx.recv().await.unwrap()["method"], "yuzuno/disconnected");
        })
        .await
        .unwrap();
        assert!(!std::path::Path::new(&format!("/proc/{pid}")).exists());
        let (_connection, _) = tokio_tungstenite::connect_async(format!("ws://{address}"))
            .await
            .unwrap();
        server.await.unwrap();
    }
}

#[cfg(test)]
mod reply_tests {
    use super::*;

    /// A long line still arriving on one connection does not hold up a long
    /// line that has arrived on another (LARGE is taken for the parse only).
    #[tokio::test]
    async fn a_long_line_still_arriving_holds_up_no_other_connection() {
        use tokio::io::AsyncWriteExt;
        let long = format!("{{\"text\":\"{}\"}}", "x".repeat(LARGE_MESSAGE + 1024));
        let (mut slow_writer, slow_reader) = tokio::io::duplex(64 << 10);
        let slow = tokio::spawn(async move {
            let mut reader = tokio::io::BufReader::new(slow_reader);
            read_message(&mut reader).await
        });
        // More than LARGE_MESSAGE of a line, and no newline yet.
        slow_writer.write_all(&long.as_bytes()[..LARGE_MESSAGE + 512]).await.unwrap();
        let (mut writer, reader) = tokio::io::duplex(64 << 10);
        let whole = format!("{long}\n");
        let writing = tokio::spawn(async move { writer.write_all(whole.as_bytes()).await.unwrap(); writer });
        let mut reader = tokio::io::BufReader::new(reader);
        let (message, bytes) = tokio::time::timeout(Duration::from_secs(10), read_message(&mut reader)).await
            .expect("not held up by the line still arriving").unwrap().unwrap();
        assert_eq!(bytes, long.len());
        assert_eq!(message["text"].as_str().map(str::len), Some(LARGE_MESSAGE + 1024));
        drop(writing.await.unwrap());
        slow_writer.write_all(&long.as_bytes()[LARGE_MESSAGE + 512..]).await.unwrap();
        slow_writer.write_all(b"\n").await.unwrap();
        let (message, _) = slow.await.unwrap().unwrap().unwrap();
        assert_eq!(message["text"].as_str().map(str::len), Some(LARGE_MESSAGE + 1024));
    }

    fn pending() -> (Reply, PendingReply) {
        let (tx, rx) = oneshot::channel();
        (tx, PendingReply { id: 1, rx, result: None })
    }

    #[tokio::test]
    async fn a_reply_handed_over_is_the_reply_received() {
        let (tx, reply) = pending();
        let history = json!({"thread":{"id":"t","turns":[{"id":"turn-1","items":[{"id":"item-1","text":"x"}]}]}});
        tx.send(Ok(history.clone())).unwrap();
        assert_eq!(reply.into_result(Duration::from_secs(1)).await.unwrap(), history);
    }

    #[tokio::test]
    async fn a_reply_handed_over_keeps_its_error() {
        let (tx, reply) = pending();
        drop(tx);
        let error = reply.into_result(Duration::from_secs(1)).await.unwrap_err();
        assert!(error.downcast_ref::<OutcomeUnknown>().is_some(), "{error:#}");

        let (_tx, reply) = pending();
        let error = reply.into_result(Duration::from_millis(10)).await.unwrap_err();
        assert!(error.downcast_ref::<OutcomeUnknown>().is_some(), "{error:#}");

        let (tx, reply) = pending();
        tx.send(Err(RpcError { code: -32600, message: "denied".into(), data: Some(json!({"reason":"r"})) }.into())).unwrap();
        let error = reply.into_result(Duration::from_secs(1)).await.unwrap_err();
        let native = error.downcast_ref::<RpcError>().unwrap();
        assert_eq!((native.code, native.message.as_str(), &native.data), (-32600, "denied", &Some(json!({"reason":"r"}))));

        let (tx, reply) = pending();
        tx.send(Err(anyhow!("Codex 返回了无法识别的错误对象"))).unwrap();
        let error = reply.into_result(Duration::from_secs(1)).await.unwrap_err();
        assert_eq!(error.to_string(), "Codex 返回了无法识别的错误对象");
    }

    /// An attach keeps its reply: waited for again after a timeout it gets the
    /// late reply, and again after that the same one, with nothing sent again.
    #[tokio::test]
    async fn an_attach_reply_is_kept_for_waiting_again() {
        let (tx, mut reply) = pending();
        let error = reply.wait(Duration::from_millis(10)).await.unwrap_err();
        assert!(error.downcast_ref::<OutcomeUnknown>().is_some(), "{error:#}");
        let resumed = json!({"thread":{"id":"t","turns":[]},"model":"m"});
        tx.send(Ok(resumed.clone())).unwrap();
        assert_eq!(*reply.wait(Duration::from_secs(1)).await.unwrap(), resumed);
        assert_eq!(*reply.wait(Duration::from_secs(1)).await.unwrap(), resumed);
        assert_eq!(**reply.result.as_ref().unwrap().as_ref().unwrap(), resumed);
    }

    /// The text of `value["text"]`, where it lives: a moved Value keeps it,
    /// a copy has its own.
    fn text_at(value: &Value) -> *const u8 {
        value["text"].as_str().unwrap().as_ptr()
    }

    #[tokio::test]
    async fn a_reply_handed_over_is_moved_not_copied() {
        let (tx, mut reply) = pending();
        tx.send(Ok(json!({"text":"x".repeat(4096)}))).unwrap();
        reply.receive(Duration::from_secs(1)).await.unwrap();
        let received = text_at(reply.result.as_ref().unwrap().as_ref().unwrap());
        let value = reply.into_result(Duration::from_secs(1)).await.unwrap();
        assert_eq!(text_at(&value), received);
    }

    /// Every wait shares the one reply kept, and none changes it.
    #[tokio::test]
    async fn an_attach_reply_is_shared_not_copied() {
        let (tx, mut reply) = pending();
        let resumed = json!({"text":"x".repeat(4096)});
        tx.send(Ok(resumed.clone())).unwrap();
        let first = reply.wait(Duration::from_secs(1)).await.unwrap();
        let second = reply.wait(Duration::from_secs(1)).await.unwrap();
        let kept = reply.result.as_ref().unwrap().as_ref().unwrap();
        assert!(Arc::ptr_eq(&first, kept) && Arc::ptr_eq(&second, kept));
        drop((first, second));
        assert_eq!(Arc::strong_count(reply.result.as_ref().unwrap().as_ref().unwrap()), 1);
        assert_eq!(*reply.wait(Duration::from_secs(1)).await.unwrap(), resumed);
    }

    /// A reply a wait still shares is copied when handed over; the shared
    /// one stays as it was.
    #[tokio::test]
    async fn a_reply_still_shared_is_copied_when_handed_over() {
        let (tx, mut reply) = pending();
        tx.send(Ok(json!({"text":"x".repeat(4096)}))).unwrap();
        let shared = reply.wait(Duration::from_secs(1)).await.unwrap();
        let value = reply.into_result(Duration::from_secs(1)).await.unwrap();
        assert_eq!(value, *shared);
        assert_ne!(text_at(&value), text_at(&shared));
    }
}
