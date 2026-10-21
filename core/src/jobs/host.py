#!/usr/bin/env python3
"""One accepted local attempt. systemd owns process groups; Core owns the queue.

The supervisor is a separate, bounded service, outside the job's OOM boundary.
It records OS evidence before releasing transient units. Never retries a command.
"""
import ctypes
import fcntl
import hashlib
import json
import math
import os
from pathlib import Path
import signal
import selectors
import shutil
import stat
import struct
import subprocess
import sys
import time
import tempfile

PROPERTIES = ('LoadState,Description,ActiveState,SubState,Result,InvocationID,MainPID,'
              'ExecMainCode,ExecMainStatus,ExecMainStartTimestampMonotonic,'
              'ExecMainExitTimestampMonotonic,ControlGroup,FreezerState,MemoryCurrent,'
              'MemoryPeak,CPUUsageNSec,MemoryMax,MemorySwapMax,TasksMax')
SEGMENT = 1024 * 1024
# TasksMax counts threads as well as processes. Keep a finite per-job bound
# with room for Chromium's renderer/utility threads under the existing budgets.
TASKS_MAX = 512
# Declared artifacts: larger files are identified by size and modification
# time only; JSON is parsed whole only up to its own, smaller bound.
HASH_LIMIT = 1024 * 1024 * 1024
JSON_LIMIT = 16 * 1024 * 1024
# What a command reports through its attempt's own files.
USAGE_LIMIT = 1024 * 1024
PROGRESS_LIMIT = 64 * 1024
# Stop at a checkpoint (T-109): a standalone Job that declared `checkpoint`
# writes it under <cwd>/.yuzuno-checkpoints/<attempt>/, created fresh for the
# attempt, and lists it last in manifest.json.
CHECKPOINTS = '.yuzuno-checkpoints'
CHECKPOINT_SIGNALS = {'SIGTERM': signal.SIGTERM, 'SIGINT': signal.SIGINT, 'SIGUSR1': signal.SIGUSR1}
MANIFEST_LIMIT = 1024 * 1024
# Files one checkpoint may list: each is hashed, and listed in the Job's record.
CHECKPOINT_FILES = 1000
# Written when the command of an attempt with a checkpoint has exited.
CHECKPOINT_EXIT = 'checkpoint-exit.json'

def command(args, timeout=8, check=True):
    # All manager commands have small output; never capture the job's stdout.
    result = subprocess.run(args, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                            timeout=timeout, text=True)
    if check and result.returncode:
        raise RuntimeError(result.stderr.strip()[:1000] or 'Command failed')
    return result

def boot_id():
    return Path('/proc/sys/kernel/random/boot_id').read_text().strip()

def atomic(path, data):
    path = Path(path)
    fd, name = tempfile.mkstemp(prefix=path.name + '.', suffix='.new', dir=path.parent)
    tmp = Path(name)
    with os.fdopen(fd, 'w', encoding='utf-8') as f:
        json.dump(data, f, ensure_ascii=False)
        f.flush()
        os.fsync(f.fileno())
    tmp.replace(path)
    fd = os.open(path.parent, os.O_DIRECTORY | os.O_RDONLY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)

def read(path):
    try:
        return json.loads(Path(path).read_text())
    except FileNotFoundError:
        return None

def show(unit):
    result = command(['systemctl', '--user', 'show', unit,
                      '--property=' + PROPERTIES], check=False)
    if result.returncode:
        raise RuntimeError('Cannot query systemd: ' + result.stderr[:500])
    return dict(line.split('=', 1) for line in result.stdout.splitlines() if '=' in line)

def pids_snapshot(group):
    """Read native counters, never infer a limit hit from stderr or a peak."""
    values = {}
    for name in ('max', 'current', 'peak', 'events'):
        try:
            raw = (group / ('pids.' + name)).read_text().strip()
            if name == 'events':
                values[name] = {k: int(v) for k, v in (line.split() for line in raw.splitlines())}
            else:
                values[name] = int(raw) if raw != 'max' else raw
        except (OSError, ValueError):
            # Older kernels may lack peak; a removed/unreadable group is not zero.
            pass
    return values or None

def pids_evidence(spec, folder, state, previous=None):
    proof = read(folder / 'started.json')
    if (not proof or proof.get('attempt') != spec['attempt']
            or proof.get('bootId') != boot_id()
            or proof.get('invocationId') != state.get('InvocationID')):
        return previous
    finished = read(folder / 'finished-pids.json')
    if finished and all(finished.get(k) == proof.get(k) for k in
                        ('jobId', 'attempt', 'bootId', 'invocationId', 'controlGroup')):
        if finished.get('pids'):
            return {'before': proof.get('pids'), 'after': finished['pids'], 'source': 'worker-exit'}
    if state.get('ControlGroup') == proof.get('controlGroup'):
        sample = pids_snapshot(Path('/sys/fs/cgroup') / proof['controlGroup'].lstrip('/'))
        if sample:
            return {'before': proof.get('pids'), 'after': sample, 'source': 'collector-sample'}
    return previous

def terminal_reason(spec, folder, status, state, pids):
    changed = read(folder / 'input-changed.json')
    reason = (changed or {}).get('reason') or state.get('Result')
    if status == 'cancelled' and (read(folder / 'checkpoint.json') or {}).get('ok') is True:
        return "Stopped at the user's request at a verified checkpoint; only the user resumes it"
    if status == 'failed' and state.get('Result') == 'success' and spec.get('artifacts'):
        return artifacts_reason(spec, folder) or reason
    # A successful command may recover from a rejected clone. Cancellation,
    # OOM and timeouts retain their own outcome even if the limit was also hit.
    if (status != 'failed' or read(folder / 'cancel.json')
            or state.get('Result') not in ('exit-code', 'signal', 'core-dump')):
        return reason
    before = ((pids or {}).get('before') or {}).get('events') or {}
    after = ((pids or {}).get('after') or {}).get('events') or {}
    start, end = before.get('max'), after.get('max')
    if isinstance(start, int) and isinstance(end, int) and end > start:
        limit = ((pids or {}).get('after') or {}).get('max')
        bound = f' ({limit} tasks)' if isinstance(limit, int) else ''
        return f'Process/thread limit reached{bound}; pids.events max increased by {end - start} while the command failed'
    return reason

def group_empty(group):
    if not group:
        return True
    path = Path('/sys/fs/cgroup') / group.lstrip('/') / 'cgroup.events'
    try:
        return 'populated 0' in path.read_text().splitlines()
    except FileNotFoundError:
        return True

def unit_empty(state):
    return state.get('MainPID') in ('0', None) and state.get('ActiveState') in ('inactive', 'failed') and group_empty(state.get('ControlGroup'))

def snapshot(spec):
    cwd = Path(spec['cwd']).resolve(strict=True)
    if not cwd.is_dir():
        raise RuntimeError('cwd must be a directory')
    files = set(spec.get('inputs', []))
    # A run's stage leaves out the artifacts its earlier stages declare: they
    # are verified by digest before it starts, and writing them is expected.
    excluded = {str(Path(p).parent.resolve() / Path(p).name) for p in spec.get('guardExclude') or []}
    git = None
    if spec.get('guardGit', True):
        result = command(['git', '-C', str(cwd), 'rev-parse', '--show-toplevel'], check=False)
        if not result.returncode:
            root = Path(result.stdout.strip()).resolve()
            head = command(['git', '-C', str(root), 'rev-parse', 'HEAD']).stdout.strip()
            # No datasets, ignored artifacts, or untracked tree walks.
            args = ['git', '-c', 'core.fsmonitor=false', '-C', str(root), 'status',
                    '--porcelain=v1', '-z', '--untracked-files=no', '--ignore-submodules=all']
            with subprocess.Popen(args, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                                  env={**os.environ, 'GIT_OPTIONAL_LOCKS': '0'}) as process:
                status = bytearray()
                complete = False
                try:
                    with selectors.DefaultSelector() as poll:
                        poll.register(process.stdout, selectors.EVENT_READ)
                        deadline = time.monotonic() + 8
                        while len(status) <= 64 * 1024:
                            left = deadline - time.monotonic()
                            if left <= 0 or not poll.select(left):
                                raise RuntimeError('Git input guard exceeded its eight-second limit')
                            chunk = os.read(process.stdout.fileno(), min(8192, 65537 - len(status)))
                            if not chunk:
                                complete = True
                                break
                            status.extend(chunk)
                finally:
                    if not complete and process.poll() is None:
                        process.kill()
                    try:
                        process.wait(timeout=2)
                    except subprocess.TimeoutExpired:
                        process.kill()
                        process.wait()
                        raise
                if complete and process.returncode:
                    raise RuntimeError("Git status could not verify the input guard")
            status = bytes(status)
            if len(status) > 64 * 1024:
                raise RuntimeError('Git change list exceeds 64 KiB; use explicit inputs and guardGit=false')
            paths = []
            kept = []
            entries = iter(status.split(b'\0'))
            for entry in entries:
                if not entry:
                    continue
                record = [entry]
                moved = b'R' in entry[:2] or b'C' in entry[:2]
                if moved:
                    record.append(next(entries, b''))
                name = os.fsdecode(entry[3:])
                # A rename or copy changes its source too: never left out.
                if not moved and str(root / name) in excluded:
                    continue
                paths.append(name)
                kept.append(b'\0'.join(record))
            files.update(str(root / p) for p in paths)
            # Without exclusions the digest is the one every earlier job recorded.
            listed = b'\0'.join(kept) if excluded else status
            git = {'root': str(root), 'head': head, 'statusSha256': hashlib.sha256(listed).hexdigest()}
    if len(files) > 128:
        raise RuntimeError('At most 128 guarded input files are supported')
    total = 0
    hashes = []
    for name in sorted(files):
        path = Path(name)
        if not path.is_absolute():
            path = cwd / path
        if not path.exists():
            hashes.append({'path': str(path), 'sha256': None})
            continue
        if not path.is_file():
            raise RuntimeError('Guarded inputs must be files: ' + str(path))
        size = path.stat().st_size
        total += size
        if size > 2 * 1024 * 1024 or total > 16 * 1024 * 1024:
            raise RuntimeError('Input guard is bounded to 2 MiB/file and 16 MiB total; large data is not snapshotted')
        with path.open('rb') as f:
            value = f.read(2 * 1024 * 1024 + 1)
        if len(value) > 2 * 1024 * 1024:
            raise RuntimeError('Guarded input grew beyond the size limit')
        hashes.append({'path': str(path), 'sha256': hashlib.sha256(value).hexdigest()})
    value = {'cwd': str(cwd), 'git': git, 'files': hashes,
             'scope': 'Frozen argv/env/resources; optional Git HEAD and changed tracked files plus explicit small inputs. Untracked/ignored data, submodule contents and changes after launch are not frozen.'}
    source = spec.get('checkpointFrom')
    if source:
        # A resumed attempt (T-109). A wrapper from before checkpoints computes
        # no such entry, so it finds the snapshot changed and rejects the
        # attempt before the command starts, instead of running it from scratch.
        value['resumeFrom'] = {key: source.get(key) for key in ('jobId', 'attempt', 'manifestSha256')}
    return value

def check_artifact(cwd, artifact):
    """A declared artifact as it is now: its digest, or why it is not acceptable.

    Structure only (a complete regular file inside cwd, its size, whole JSON or
    JSON lines). Whether its content is scientifically valid is the project's.
    """
    fmt = artifact.get('format') or 'bytes'
    minimum = artifact.get('minBytes', 1)
    entry = {'path': artifact['path'], 'format': fmt, 'minBytes': minimum, 'ok': False}
    try:
        base = Path(cwd).resolve(strict=True)
        path = (base / artifact['path']).resolve(strict=True)
        if path != base and base not in path.parents:
            entry['problem'] = 'resolves outside the working directory'
            return entry
        before = path.stat()
        if not stat.S_ISREG(before.st_mode):
            entry['problem'] = 'not a regular file'
            return entry
        entry.update({'absolutePath': str(path), 'bytes': before.st_size, 'mtimeNs': before.st_mtime_ns})
        if before.st_size < minimum:
            entry['problem'] = f'{before.st_size} bytes, fewer than the required {minimum}'
            return entry
        if before.st_size > HASH_LIMIT:
            entry['sha256'] = None
            entry['hash'] = 'Not hashed: larger than 1 GiB; identified by size and modification time'
            if fmt != 'bytes':
                entry['problem'] = f'larger than 1 GiB, too large to check as {fmt}; declare it as bytes'
                return entry
        else:
            digest = hashlib.sha256()
            whole = bytearray() if fmt == 'json' and before.st_size <= JSON_LIMIT else None
            pending = b''
            lines = 0
            with path.open('rb') as f:
                while True:
                    chunk = f.read(1024 * 1024)
                    if not chunk:
                        break
                    digest.update(chunk)
                    if whole is not None:
                        whole.extend(chunk)
                    if fmt == 'jsonl':
                        parts = (pending + chunk).split(b'\n')
                        pending = parts.pop()
                        if len(pending) > JSON_LIMIT:
                            entry['problem'] = 'a line longer than 16 MiB'
                            return entry
                        for line in parts:
                            if line.strip():
                                json.loads(line)
                                lines += 1
            entry['sha256'] = digest.hexdigest()
            if fmt == 'json':
                if whole is None:
                    entry['problem'] = 'larger than 16 MiB, too large to check as JSON'
                    return entry
                json.loads(bytes(whole))
            if fmt == 'jsonl':
                if pending:
                    entry['problem'] = 'the last line is not terminated: the file may be partly written'
                    return entry
                entry['lines'] = lines
        after = path.stat()
        if (after.st_size, after.st_mtime_ns) != (before.st_size, before.st_mtime_ns):
            entry['problem'] = 'changed while it was being checked'
            return entry
    except FileNotFoundError:
        entry['problem'] = 'missing'
        return entry
    except (ValueError, UnicodeDecodeError, RecursionError) as error:
        entry['problem'] = f'not complete {"JSON" if fmt == "json" else "JSON lines"}: {str(error)[:200]}'
        return entry
    except OSError as error:
        entry['problem'] = f'cannot be read: {error.strerror or error}'
        return entry
    entry['ok'] = True
    return entry

def guard_reason(spec, current):
    """Which frozen inputs changed before launch, by name."""
    frozen = spec['snapshot']
    changed = []
    if (frozen.get('git') or {}).get('head') != (current.get('git') or {}).get('head'):
        changed.append('the Git commit')
    before = {f['path']: f['sha256'] for f in frozen.get('files', [])}
    after = {f['path']: f['sha256'] for f in current.get('files', [])}
    changed += [p for p in sorted(set(before) | set(after)) if before.get(p) != after.get(p)]
    if frozen.get('resumeFrom') != current.get('resumeFrom'):
        changed.append('the checkpoint it resumes from')
    if not changed:
        changed.append('the list of changed tracked files')
    shown = ', '.join(changed[:5]) + (f' and {len(changed) - 5} more' if len(changed) > 5 else '')
    hint = (" If an earlier stage writes a tracked file, declare it as that stage's artifact."
            if spec.get('run') else '')
    return f'Guarded inputs changed while queued ({shown}); command was not started.{hint}'

def same_artifact(recorded, now):
    """The artifact a stage succeeded with is still the one on disk."""
    if not now.get('ok') or now.get('bytes') != recorded.get('bytes'):
        return False
    if recorded.get('sha256'):
        return now.get('sha256') == recorded['sha256']
    return now.get('mtimeNs') == recorded.get('mtimeNs')

def upstream_problem(spec):
    """Why the artifacts this stage depends on are no longer what their stages
    produced: those of every earlier stage it depends on, directly or not,
    when its run recorded them, else those of its direct upstream."""
    for upstream in spec.get('guardChecks') or spec.get('upstream') or []:
        for recorded in upstream.get('artifacts') or []:
            now = check_artifact(upstream['cwd'], recorded)
            if not same_artifact(recorded, now):
                detail = now.get('problem') or 'its content changed'
                return (f"Upstream stage {upstream['stage']} artifact {recorded['path']} is no longer "
                        f"the one it succeeded with ({detail}); command was not started")
    return None

def checked_artifacts(spec, folder):
    """This attempt's artifact verification record, or None if absent or unreadable."""
    try:
        checked = read(folder / 'artifacts.json')
        if (isinstance(checked, dict) and checked.get('attempt') == spec['attempt']
                and isinstance(checked.get('artifacts'), list)
                and all(isinstance(a, dict) for a in checked['artifacts'])):
            return checked['artifacts']
    except (ValueError, OSError, RecursionError):
        pass
    return None

def artifacts_reason(spec, folder):
    """Exit 0 with declared artifacts that did not verify, or None."""
    checked = checked_artifacts(spec, folder)
    if checked is None:
        return 'Exit 0, but artifact verification did not complete'
    problems = [f"{a.get('path')}: {a.get('problem', 'not verified')}" for a in checked if a.get('ok') is not True]
    if problems or len(checked) != len(spec['artifacts']):
        return 'Exit 0, but declared artifacts failed verification: ' + '; '.join(problems)[:1000]
    return None

def read_report(path, limit):
    """At most limit + 1 bytes of a file the command reports through, its
    modification time, and why it cannot be used. The command controls these
    paths: never follow a link, block on a pipe or read anything but a file."""
    try:
        fd = os.open(path, os.O_RDONLY | os.O_NONBLOCK | os.O_NOFOLLOW)
    except FileNotFoundError:
        return None, None, None
    except OSError as error:
        return None, None, f'cannot be read: {error.strerror or error}'
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode):
            return None, info.st_mtime, 'not a regular file'
        raw = bytearray()
        while len(raw) <= limit:
            chunk = os.read(fd, limit + 1 - len(raw))
            if not chunk:
                break
            raw.extend(chunk)
        return bytes(raw), info.st_mtime, None
    except OSError as error:
        return None, None, f'cannot be read: {error.strerror or error}'
    finally:
        os.close(fd)

def finite_json(raw):
    """JSON as Core can store and read it: no NaN, Infinity or numbers out of range."""
    def number(value):
        if isinstance(value, float) and not math.isfinite(value) or isinstance(value, int) and abs(value) >= 2 ** 63:
            raise ValueError('a number out of range')
        return value

    def constant(name):
        raise ValueError(f'{name} is not a finite number')
    return json.loads(raw, parse_constant=constant, parse_float=lambda text: number(float(text)),
                      parse_int=lambda text: number(int(text)))

def usage_summary(folder):
    """Recorded consumption/cost of one attempt. Unknown stays unknown."""
    raw, _, problem = read_report(folder / 'usage.jsonl', USAGE_LIMIT)
    if raw is None and problem is None:
        return None
    if problem:
        return {'entries': 0, 'knownUsd': 0, 'unknownEntries': 0, 'invalidLines': 1, 'incompleteLines': 0,
                'truncated': False, 'sources': [], 'complete': False, 'problem': problem}
    truncated = len(raw) > USAGE_LIMIT
    lines = raw[:USAGE_LIMIT].split(b'\n')
    tail = lines.pop()
    known, entries, unknown, invalid, sources = 0.0, 0, 0, 0, []
    for line in lines:
        if not line.strip():
            continue
        try:
            value = finite_json(line)
        except (ValueError, RecursionError):
            invalid += 1
            continue
        if not isinstance(value, dict):
            invalid += 1
            continue
        entries += 1
        usd = value.get('usd')
        if usd is None:
            unknown += 1
        # No single call costs a billion dollars; such a value is a broken line.
        elif isinstance(usd, (int, float)) and not isinstance(usd, bool) and 0 <= usd <= 1e9:
            known += usd
        else:
            invalid += 1
        source = value.get('source')
        if isinstance(source, str) and source.strip() and source[:200] not in sources and len(sources) < 10:
            sources.append(source[:200])
    incomplete = 1 if tail.strip() and not truncated else 0
    return {'entries': entries, 'knownUsd': round(known, 6), 'unknownEntries': unknown,
            'invalidLines': invalid, 'incompleteLines': incomplete, 'truncated': truncated,
            'sources': sources,
            'complete': not (unknown or invalid or incomplete or truncated)}

def progress(folder):
    """The command's last structured progress, not interpreted."""
    raw, at, problem = read_report(folder / 'progress.json', PROGRESS_LIMIT)
    if raw is None and problem is None:
        return None
    if problem:
        return {'problem': problem, 'updatedAtUnix': at}
    if len(raw) > PROGRESS_LIMIT:
        return {'problem': 'larger than 64 KiB', 'updatedAtUnix': at}
    try:
        return {'value': finite_json(raw), 'updatedAtUnix': at}
    except (ValueError, RecursionError):
        return {'problem': 'not complete JSON of finite numbers', 'updatedAtUnix': at}

def attempt_env(spec, folder):
    """Where this attempt reports, and who it is. Core's values win."""
    env = {'YUZUNO_JOB_ID': spec['id'], 'YUZUNO_JOB_ATTEMPT': spec['attempt'],
           'YUZUNO_JOB_USAGE_FILE': str(folder / 'usage.jsonl'),
           'YUZUNO_JOB_PROGRESS_FILE': str(folder / 'progress.json')}
    run = spec.get('run')
    if run:
        env.update({'YUZUNO_RUN_ID': run['id'], 'YUZUNO_RUN_STAGE': run['stage'],
                    'YUZUNO_RUN_ATTEMPT': str(run['attempt'])})
    # The GPUs admission reserved for this attempt, and only those.
    devices = [d['uuid'] for d in spec.get('gpuReservation') or [] if d.get('uuid')]
    if devices:
        env['CUDA_VISIBLE_DEVICES'] = ','.join(devices)
        env['YUZUNO_JOB_GPUS'] = ','.join(devices)
    if spec.get('checkpoint'):
        # Where this attempt saves, and the file its stop request appears in.
        env['YUZUNO_CHECKPOINT_DIR'] = str(checkpoint_dir(spec))
        env['YUZUNO_CHECKPOINT_REQUEST'] = str(folder / 'checkpoint-stop.json')
    source = spec.get('checkpointFrom')
    if source:
        env['YUZUNO_RESUME_FROM'] = str(Path(source['dir']) / 'manifest.json')
    return env

def checkpoint_dir(spec):
    return Path(spec['cwd']) / CHECKPOINTS / spec['attempt']

class Forwarder:
    """The wrapper's side of a stop at a checkpoint. Core writes the request,
    then signals this process (the unit's main one). Only the declared signal
    goes, once, only to this wrapper's own child, and never once the child
    has exited: `wait` marks it exited before reaping it, so its PID is still
    that child's (a zombie) whenever a signal could be sent."""
    def __init__(self, spec, folder):
        self.folder = folder
        self.signal = CHECKPOINT_SIGNALS[spec['checkpoint'].get('signal') or 'SIGTERM']
        self.child = None
        self.exited = False
        self.sent = False

    def __call__(self, *_):
        if self.child is None or self.exited or self.sent or not (self.folder / 'checkpoint-stop.json').exists():
            return
        self.sent = True
        outcome = {'signal': self.signal.name, 'pid': self.child.pid, 'at': time.time()}
        try:
            os.kill(self.child.pid, self.signal)
        except ProcessLookupError:
            outcome['problem'] = 'the command had already exited'
        atomic(self.folder / 'checkpoint-forward.json', outcome)

    def started(self, child):
        # A request that came before the command started is sent now.
        self.child = child
        self()

    def wait(self, child):
        os.waitid(os.P_PID, child.pid, os.WEXITED | os.WNOWAIT)
        self.exited = True
        return child.wait()

def checkpoint_files(base, manifest):
    """The files a manifest lists, each a regular file inside `base` reached
    without a link, with Core's own full digest; or why not."""
    listed = manifest.get('files')
    if not isinstance(listed, list) or not listed:
        return None, 'the manifest lists no files'
    if len(listed) > CHECKPOINT_FILES:
        return None, f'the manifest lists more than {CHECKPOINT_FILES} files'
    root = base.resolve(strict=True)
    files = []
    for entry in listed:
        name = entry.get('path') if isinstance(entry, dict) else None
        if (not isinstance(name, str) or not name or name.startswith('/') or '..' in Path(name).parts
                or Path(name) == Path('manifest.json')):
            return None, f'the manifest lists an invalid path: {str(name)[:200]}'
        path = base / name
        try:
            before = path.lstat()
            if not stat.S_ISREG(before.st_mode):
                return None, f'{name} is not a regular file'
            if path.resolve(strict=True) != root / name:
                return None, f'{name} is reached through a link'
            digest = hashlib.sha256()
            with path.open('rb') as f:
                for chunk in iter(lambda: f.read(1024 * 1024), b''):
                    digest.update(chunk)
            after = path.lstat()
        except FileNotFoundError:
            return None, f'{name} is missing'
        except OSError as error:
            return None, f'{name} cannot be read: {error.strerror or error}'
        if (after.st_size, after.st_mtime_ns) != (before.st_size, before.st_mtime_ns):
            return None, f'{name} changed while it was being checked'
        sha = digest.hexdigest()
        if entry.get('sha256') not in (None, sha):
            return None, f'{name} does not match the digest the manifest records'
        files.append({'path': name, 'bytes': after.st_size, 'sha256': sha})
    return files, None

def verify_checkpoint(spec, folder, code):
    """After the command exited: whether this attempt left a checkpoint made
    for this stop request. None when no stop was requested."""
    request = read(folder / 'checkpoint-stop.json')
    if not request:
        return None
    declared = spec['checkpoint']
    base = checkpoint_dir(spec)
    outcome = {'ok': False, 'requestedAt': request.get('requestedAt'), 'nonce': request.get('nonce'),
               'dir': str(base), 'exitCode': code, 'forward': read(folder / 'checkpoint-forward.json')}
    def no(reason):
        outcome['reason'] = reason
        outcome['checkedAt'] = time.time()
        return outcome
    if code != declared['stoppedExitCode']:
        return no(f'the command exited {code}, not the declared stopped code {declared["stoppedExitCode"]}')
    manifest_path = base / 'manifest.json'
    try:
        info = manifest_path.lstat()
        if not stat.S_ISREG(info.st_mode):
            return no('manifest.json is not a regular file')
        if info.st_size > MANIFEST_LIMIT:
            return no('manifest.json is larger than 1 MiB')
        raw = manifest_path.read_bytes()
        manifest = json.loads(raw)
    except FileNotFoundError:
        return no('no manifest.json was written')
    except (ValueError, UnicodeDecodeError, RecursionError, OSError) as error:
        return no(f'manifest.json is not readable JSON: {str(error)[:200]}')
    if not isinstance(manifest, dict):
        return no('manifest.json is not a JSON object')
    if manifest.get('attempt') != spec['attempt']:
        return no('the manifest names another attempt')
    if manifest.get('nonce') != request.get('nonce'):
        return no('the manifest does not name this stop request')
    files, problem = checkpoint_files(base, manifest)
    if problem:
        return no(problem)
    outcome.update({'ok': True, 'reason': None, 'manifestSha256': hashlib.sha256(raw).hexdigest(),
                    'files': files, 'progress': manifest.get('progress'), 'checkedAt': time.time()})
    return outcome

def checkpoint_source_problem(source):
    """Before a resumed attempt starts: the checkpoint it resumes from is
    still exactly what was verified when its attempt stopped."""
    base = Path(source['dir'])
    try:
        raw = (base / 'manifest.json').read_bytes()
    except OSError:
        return f'the checkpoint it resumes from has no manifest at {base}'
    if hashlib.sha256(raw).hexdigest() != source['manifestSha256']:
        return 'the checkpoint manifest it resumes from has changed since it was verified'
    try:
        manifest = json.loads(raw)
    except ValueError:
        return 'the checkpoint manifest it resumes from is not JSON'
    files, problem = checkpoint_files(base, manifest)
    if problem:
        return f'the checkpoint it resumes from: {problem}'
    if [(f['path'], f['sha256']) for f in files] != [(f['path'], f['sha256']) for f in source['files']]:
        return 'a checkpoint file it resumes from has changed since it was verified'
    return None


class _Memory(ctypes.Structure):
    _fields_ = [('total', ctypes.c_ulonglong), ('free', ctypes.c_ulonglong), ('used', ctypes.c_ulonglong)]


class _Utilization(ctypes.Structure):
    _fields_ = [('gpu', ctypes.c_uint), ('memory', ctypes.c_uint)]


def nvml_devices():
    lib = ctypes.CDLL('libnvidia-ml.so.1')
    if lib.nvmlInit_v2() != 0:
        raise RuntimeError('nvmlInit failed')
    try:
        count = ctypes.c_uint()
        if lib.nvmlDeviceGetCount_v2(ctypes.byref(count)) != 0:
            raise RuntimeError('nvmlDeviceGetCount failed')
        devices = []
        for index in range(count.value):
            handle = ctypes.c_void_p()
            if lib.nvmlDeviceGetHandleByIndex_v2(index, ctypes.byref(handle)) != 0:
                raise RuntimeError(f'nvmlDeviceGetHandleByIndex {index} failed')
            uuid, name = ctypes.create_string_buffer(96), ctypes.create_string_buffer(96)
            memory, util = _Memory(), _Utilization()
            if (lib.nvmlDeviceGetUUID(handle, uuid, 96) != 0 or lib.nvmlDeviceGetName(handle, name, 96) != 0
                    or lib.nvmlDeviceGetMemoryInfo(handle, ctypes.byref(memory)) != 0):
                raise RuntimeError(f'NVML could not read device {index}')
            devices.append({'index': index, 'uuid': uuid.value.decode(), 'name': name.value.decode(),
                            'memoryTotalMiB': memory.total // 1048576, 'memoryFreeMiB': memory.free // 1048576,
                            'memoryUsedMiB': memory.used // 1048576,
                            'utilizationPercent': util.gpu if lib.nvmlDeviceGetUtilizationRates(handle, ctypes.byref(util)) == 0 else None})
        return devices
    finally:
        lib.nvmlShutdown()


def smi_devices():
    # WSL keeps nvidia-smi in /usr/lib/wsl/lib, which is not on a service's PATH.
    smi = shutil.which('nvidia-smi') or next(
        (p for p in ('/usr/lib/wsl/lib/nvidia-smi', '/usr/bin/nvidia-smi') if Path(p).exists()), None)
    if not smi:
        raise RuntimeError('nvidia-smi not found')
    out = command([smi, '--query-gpu=index,uuid,name,memory.total,memory.free,memory.used,utilization.gpu',
                   '--format=csv,noheader,nounits'], timeout=10).stdout
    devices = []
    for line in out.strip().splitlines():
        index, uuid, name, total, free, used, util = [v.strip() for v in line.split(',')]
        devices.append({'index': int(index), 'uuid': uuid, 'name': name, 'memoryTotalMiB': int(total),
                        'memoryFreeMiB': int(free), 'memoryUsedMiB': int(used),
                        'utilizationPercent': int(util) if util.isdigit() else None})
    return devices


def gpus():
    """The local NVIDIA devices now, by UUID: memory and utilization. NVML
    first, nvidia-smi if NVML cannot be used. The compute process list is never
    read: on WSL it can be empty while the card is in use."""
    try:
        return {'source': 'nvml', 'devices': nvml_devices()}
    except Exception as nvml_error:
        try:
            return {'source': 'nvidia-smi', 'devices': smi_devices(), 'nvmlError': str(nvml_error)[:200]}
        except Exception as smi_error:
            return {'error': f'NVML: {nvml_error}; nvidia-smi: {smi_error}'[:500], 'devices': []}

def capabilities():
    version = command(['systemctl', '--version']).stdout.splitlines()[0]
    manager = command(['systemctl', '--user', 'show', '--property=ControlGroup']).stdout.strip().split('=', 1)[1]
    controllers = (Path('/sys/fs/cgroup') / manager.lstrip('/') / 'cgroup.controllers').read_text().split()
    if not {'cpu', 'memory', 'pids'} <= set(controllers):
        raise RuntimeError('User manager requires cgroup v2 cpu, memory and pids controllers')
    return {'available': True, 'version': version, 'bootId': boot_id(),
            'controllers': controllers, 'python': sys.version.split()[0]}

def worker(spec, folder):
    resource = spec['resources']
    relative = Path('/proc/self/cgroup').read_text().strip().split('::', 1)[1]
    group = Path('/sys/fs/cgroup') / relative.lstrip('/')
    limits = {n: (group / n).read_text().strip()
              for n in ('memory.max', 'memory.swap.max', 'cpu.max', 'pids.max')}
    quota, period = map(int, limits['cpu.max'].split())
    if (int(limits['memory.max']) != resource['memoryMiB'] * 1024 * 1024
            or int(limits['memory.swap.max']) != resource['swapMiB'] * 1024 * 1024
            or int(limits['pids.max']) != TASKS_MAX
            or abs(quota / period - resource['cpuMillis'] / 1000) > .0001):
        raise RuntimeError('Requested cgroup limits are not effective; command was not started')
    proof = {'jobId': spec['id'], 'attempt': spec['attempt'], 'bootId': boot_id(),
             'invocationId': os.environ.get('INVOCATION_ID'), 'controlGroup': relative,
             'pid': os.getpid(), 'limits': limits, 'pids': pids_snapshot(group), 'at': time.time()}
    # Core signals this process only once started.json exists, so the
    # handler is in place before the default action could end the wrapper.
    forward = Forwarder(spec, folder) if spec.get('checkpoint') else None
    if forward:
        signal.signal(signal.SIGUSR1, forward)
    atomic(folder / 'started.json', proof)
    if read(folder / 'cancel.json'):
        return 125
    current = snapshot(spec)
    if current != spec['snapshot']:
        atomic(folder / 'input-changed.json', {'reason': guard_reason(spec, current)})
        return 78
    changed = upstream_problem(spec)
    if changed:
        atomic(folder / 'input-changed.json', {'reason': changed})
        return 78
    source = spec.get('checkpointFrom')
    changed = source and checkpoint_source_problem(source)
    if changed:
        atomic(folder / 'input-changed.json', {'reason': changed})
        return 78
    if forward:
        base = checkpoint_dir(spec)
        try:
            base.parent.mkdir(exist_ok=True)
            base.mkdir()
        except FileExistsError:
            atomic(folder / 'input-changed.json', {'reason': f'{base} already exists; each attempt saves into a new one'})
            return 78
        except OSError as error:
            atomic(folder / 'input-changed.json', {'reason': f'{base} cannot be created for checkpoints: {error.strerror or error}'})
            return 78
    # Clear ambient manager/Core credentials. The submission stores this exact
    # env; Core adds only this attempt's identity and report files.
    total = 0
    log = None
    try:
        child = subprocess.Popen(spec['argv'], cwd=spec['cwd'], env={**spec['env'], **attempt_env(spec, folder)},
                                 stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
        if forward:
            forward.started(child)
        while True:
            chunk = os.read(child.stdout.fileno(), 16384)
            if not chunk:
                break
            while chunk:
                at = total % SEGMENT
                if at == 0:
                    if log:
                        log.flush()
                        os.fsync(log.fileno())
                        log.close()
                    slot = (total // SEGMENT) % 2
                    temp = folder / ('log-' + str(slot) + '.new')
                    with temp.open('wb') as f:
                        f.write(struct.pack('>Q', total))
                    temp.replace(folder / ('log-' + str(slot) + '.bin'))
                    log = (folder / ('log-' + str(slot) + '.bin')).open('ab', buffering=0)
                part, chunk = chunk[:SEGMENT - at], chunk[SEGMENT - at:]
                log.write(part)
                total += len(part)
        code = forward.wait(child) if forward else child.wait()
    finally:
        if log:
            os.fsync(log.fileno())
            log.close()
        # This worker is still in the cgroup, so fast failures retain counters
        # even if systemd removes the empty group before the collector polls.
        atomic(folder / 'finished-pids.json', {**proof, 'pids': pids_snapshot(group)})
    if forward:
        # The command has ended: from here a stop's grace period no longer
        # applies, and Core does not cancel the check below (checkpoint.rs).
        try:
            atomic(folder / CHECKPOINT_EXIT, {'attempt': spec['attempt'], 'exitCode': code, 'at': time.time()})
        except OSError:
            pass
        # Inside this attempt's limits and timeout, before the reservation can
        # be released; never fails the worker itself.
        try:
            checked = verify_checkpoint(spec, folder, code)
        except Exception as error:
            checked = {'ok': False, 'reason': f'the checkpoint could not be checked: {error}'[:300]}
        if checked is not None:
            atomic(folder / 'checkpoint.json', checked)
    if code == 0 and spec.get('artifacts'):
        # Inside this attempt's limits and timeout. Never fail the worker
        # itself here: a missing record is reported as an unverified artifact,
        # and the exit status stays the command's own.
        try:
            atomic(folder / 'artifacts.json', {'attempt': spec['attempt'], 'checkedAt': time.time(),
                                               'artifacts': [check_artifact(spec['cwd'], a) for a in spec['artifacts']]})
        except Exception:
            pass
    if code < 0:
        if forward:
            signal.signal(signal.SIGUSR1, signal.SIG_DFL)
        os.kill(os.getpid(), -code)
    return code

def reports(spec, folder):
    """What the attempt itself reported: verified artifacts, usage/cost, progress.

    Written by the command, so it can never keep an outcome from being
    recorded: anything Core could not read is replaced by the reason.
    """
    try:
        value = {'artifacts': checked_artifacts(spec, folder), 'cost': usage_summary(folder),
                 'progress': progress(folder)}
        if spec.get('checkpoint'):
            # The worker's own check; a stop that never got one stays None.
            value['checkpoint'] = read(folder / 'checkpoint.json')
        json.dumps(value, allow_nan=False)
        return value
    except Exception as error:
        return {'artifacts': None, 'cost': None, 'progress': None,
                'reportProblem': f'The attempt\'s reports could not be read: {error}'[:300]}

def result(spec, folder, status, evidence, reason=None):
    value = {'jobId': spec['id'], 'attempt': spec['attempt'], 'bootId': boot_id(),
             'status': status, 'reason': reason, 'finishedAtUnix': time.time(),
             'started': read(folder / 'started.json'), 'evidence': evidence,
             **reports(spec, folder)}
    # Core reconciliation and the external collector can finish concurrently.
    with (folder / 'result.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        previous = read(folder / 'result.json')
        if previous and previous['status'] != 'unknown':
            return previous
        atomic(folder / 'result.json', value)
        return value

def classify(spec, folder, state):
    proof = read(folder / 'started.json')
    if proof and (proof['bootId'] != boot_id() or proof['attempt'] != spec['attempt']):
        return None
    if not proof or not state.get('InvocationID') or state['InvocationID'] != proof['invocationId']:
        return None
    if state.get('MainPID') != '0' or not group_empty(proof['controlGroup']):
        return None
    if state.get('SubState') not in ('exited', 'failed', 'dead'):
        return None
    if read(folder / 'input-changed.json'):
        return 'rejected'
    if (read(folder / 'checkpoint.json') or {}).get('ok') is True:
        # Stopped at a verified checkpoint: an end the user asked for.
        return 'cancelled'
    if state.get('Result') == 'success' and state.get('ExecMainCode') == '1' and state.get('ExecMainStatus') == '0':
        # A clean exit is not success until every declared artifact verified.
        return 'failed' if spec.get('artifacts') and artifacts_reason(spec, folder) else 'succeeded'
    return 'failed'

def settled(spec, folder, outcome):
    # Persisting the outcome precedes collector exit. Keep its reservation too.
    if spec['bootId'] != boot_id():
        return outcome
    collector = show(spec['supervisorUnit'])
    worker = show(spec['unit'])
    launch = read(folder / 'launch.json') or {}
    proof = read(folder / 'started.json') or {}
    if (unit_empty(collector) and worker.get('MainPID') == '0'
            and group_empty(worker.get('ControlGroup'))
            and group_empty(launch.get('controlGroup'))
            and group_empty(proof.get('controlGroup'))):
        return outcome
    return {'status': 'settling', 'reason': 'Outcome saved; waiting for worker and collector groups to exit'}

# Pause and resume freeze or thaw the worker unit's whole cgroup through
# systemd. Memory, GPU memory and the Core reservation stay with the job;
# work already submitted to a GPU still finishes. The worker's RuntimeMaxSec
# keeps counting while frozen and cannot be extended on a running unit.
PAUSE_WAIT = 10

def controlled(operation):
    """Serialize pause, resume and cancel of one attempt. The lock is held
    only while the operation runs, so one process can run several in turn."""
    def run(spec, folder):
        with (folder / 'control.lock').open('a') as lock:
            fcntl.flock(lock, fcntl.LOCK_EX)
            return operation(spec, folder)
    run.__name__ = operation.__name__
    return run

def live_worker(spec, folder):
    """(systemd state, start proof) of this attempt's own worker invocation,
    or (None, why not). Only that invocation is ever frozen or thawed."""
    if spec['bootId'] != boot_id():
        return None, 'OS boot changed; the previous processes cannot continue'
    state = show(spec['unit'])
    if state.get('Description') != 'Yuzuno job ' + spec['attempt']:
        return None, 'The worker unit does not belong to this attempt; nothing was changed'
    proof = read(folder / 'started.json')
    if not proof or proof.get('attempt') != spec['attempt'] or proof.get('bootId') != boot_id():
        return None, 'The worker has not confirmed its start; nothing was changed'
    if (not state.get('InvocationID') or state['InvocationID'] != proof.get('invocationId')
            or state.get('ControlGroup') != proof.get('controlGroup')):
        return None, 'The worker invocation is not the one that started this attempt; nothing was changed'
    return state, proof

def freezer(proof):
    """The worker cgroup's own report. systemd's FreezerState can stay
    'frozen' after the unit has died, so only cgroup.events is evidence."""
    try:
        path = Path('/sys/fs/cgroup') / proof['controlGroup'].lstrip('/') / 'cgroup.events'
        values = dict(line.split() for line in path.read_text().splitlines())
    except (OSError, ValueError, KeyError, AttributeError):
        return None
    return {'populated': values.get('populated') == '1', 'frozen': values.get('frozen') == '1'}

def wait_freezer(proof, frozen, seconds=PAUSE_WAIT):
    deadline = time.monotonic() + seconds
    while True:
        now = freezer(proof)
        if now is None or now['frozen'] == frozen or time.monotonic() >= deadline:
            return now
        time.sleep(.02)

def pause_evidence(state, proof, now):
    return {'invocationId': proof['invocationId'], 'controlGroup': proof['controlGroup'],
            'freezer': now, 'freezerState': state.get('FreezerState'), 'at': time.time()}

@controlled
def pause(spec, folder):
    finished = read(folder / 'result.json')
    if finished and finished['status'] != 'unknown':
        return {'state': 'notPaused', 'reason': 'The job has already finished; nothing was paused'}
    if read(folder / 'cancel.json'):
        return {'state': 'notPaused', 'reason': 'Cancellation was requested; nothing was paused'}
    state, proof = live_worker(spec, folder)
    if state is None:
        return {'state': 'notPaused', 'reason': proof}
    if state.get('ActiveState') != 'active' or state.get('SubState') != 'running':
        return {'state': 'notPaused', 'reason': f"The job is not running ({state.get('ActiveState')}/{state.get('SubState')}); nothing was paused"}
    now = freezer(proof)
    if now and now['frozen']:
        return {'state': 'paused', 'reason': 'Already paused', 'evidence': pause_evidence(state, proof, now)}
    asked = command(['systemctl', '--user', 'freeze', spec['unit']], timeout=15, check=False)
    now = wait_freezer(proof, True)
    after, _ = live_worker(spec, folder)
    evidence = {**pause_evidence(after or state, proof, now), 'freezeReturnCode': asked.returncode,
                'freezeError': asked.stderr.strip()[:500]}
    if after is None or now is None:
        return {'state': 'unknown', 'reason': 'The worker changed or exited while it was being paused', 'evidence': evidence}
    if now['frozen']:
        atomic(folder / 'paused.json', {'attempt': spec['attempt'], **evidence})
        return {'state': 'paused', 'reason': 'Paused: every process in the job is frozen; memory and GPU memory are kept', 'evidence': evidence}
    if asked.returncode:
        return {'state': 'notPaused', 'reason': 'systemd did not freeze the job: ' + (asked.stderr.strip()[:300] or 'unknown error'), 'evidence': evidence}
    return {'state': 'pausing', 'reason': f'Freeze requested, but not every process had stopped after {PAUSE_WAIT} s (one may be inside a driver or kernel call)', 'evidence': evidence}

@controlled
def resume(spec, folder):
    state, proof = live_worker(spec, folder)
    if state is None:
        return {'state': 'notResumed', 'reason': proof}
    now = freezer(proof)
    if now is None:
        return {'state': 'notResumed', 'reason': 'The worker group no longer exists'}
    if not now['frozen'] and state.get('FreezerState') == 'running':
        return {'state': 'running', 'reason': 'Already running', 'evidence': pause_evidence(state, proof, now)}
    asked = command(['systemctl', '--user', 'thaw', spec['unit']], timeout=15, check=False)
    now = wait_freezer(proof, False)
    after, _ = live_worker(spec, folder)
    evidence = {**pause_evidence(after or state, proof, now), 'thawReturnCode': asked.returncode,
                'thawError': asked.stderr.strip()[:500]}
    if after is None or now is None:
        return {'state': 'unknown', 'reason': 'The worker changed or exited while it was being resumed', 'evidence': evidence}
    if not now['frozen']:
        atomic(folder / 'resumed.json', {'attempt': spec['attempt'], **evidence})
        return {'state': 'running', 'reason': 'Resumed: the same processes continue', 'evidence': evidence}
    if asked.returncode:
        return {'state': 'notResumed', 'reason': 'systemd did not thaw the job: ' + (asked.stderr.strip()[:300] or 'unknown error'), 'evidence': evidence}
    return {'state': 'resuming', 'reason': f'Thaw requested, but the job was still frozen after {PAUSE_WAIT} s', 'evidence': evidence}

def thaw_for_stop(spec, folder, proof, state):
    """systemd refuses to stop a frozen unit. Thaw this attempt's own worker
    first; its processes may run briefly while they handle termination."""
    if not proof or proof.get('invocationId') != state.get('InvocationID'):
        return None
    now = freezer(proof)
    if not (now and now['frozen']) and state.get('FreezerState') in (None, '', 'running'):
        return None
    asked = command(['systemctl', '--user', 'thaw', spec['unit']], timeout=15, check=False)
    return {'wasFrozen': True, 'thawReturnCode': asked.returncode, 'freezer': wait_freezer(proof, False, 3)}

@controlled
def checkpoint_stop(spec, folder):
    """The user's stop at a checkpoint. The request is written once (a repeat
    keeps the first); then the wrapper, this unit's main process, is asked to
    forward the declared signal to its command. A paused worker is thawed
    first. Nothing is released here: the attempt ends when its processes do."""
    if not spec.get('checkpoint'):
        return {'delivered': False, 'reason': 'This Job declared no checkpoint; nothing was changed'}
    finished = read(folder / 'result.json')
    if finished and finished['status'] != 'unknown':
        return {'delivered': False, 'reason': 'The job has already finished; nothing was changed'}
    if read(folder / 'cancel.json'):
        return {'delivered': False, 'reason': 'Cancellation was requested; nothing was changed'}
    request = read(folder / 'checkpoint-stop.json')
    if not request:
        request = {'attempt': spec['attempt'], 'nonce': os.urandom(16).hex(), 'requestedAt': time.time()}
        atomic(folder / 'checkpoint-stop.json', request)
    state, proof = live_worker(spec, folder)
    if state is None:
        # Before the command starts, the wrapper reads the request itself.
        return {'delivered': False, 'request': request, 'reason': proof}
    if state.get('MainPID') != str(proof.get('pid')):
        return {'delivered': False, 'request': request,
                'reason': "The unit's main process is not this attempt's wrapper; no signal was sent"}
    thawed = thaw_for_stop(spec, folder, proof, state)
    asked = command(['systemctl', '--user', 'kill', '--kill-whom=main', '--signal=SIGUSR1', spec['unit']],
                    timeout=15, check=False)
    return {'delivered': asked.returncode == 0, 'request': request, 'thawed': thawed,
            'reason': None if asked.returncode == 0 else 'systemd did not signal the wrapper: ' + (asked.stderr.strip()[:300] or 'unknown error')}

@controlled
def cancel(spec, folder):
    previous = read(folder / 'result.json')
    if previous and previous['status'] != 'unknown':
        return settled(spec, folder, previous)
    if spec['bootId'] != boot_id():
        return result(spec, folder, 'interrupted', {'expectedBootId': spec['bootId'], 'currentBootId': boot_id()}, 'OS boot changed; previous processes cannot continue')
    before = {key: show(spec[key]) for key in ('supervisorUnit', 'unit')}
    if any(s.get('LoadState') != 'not-found' and s.get('Description') != 'Yuzuno job ' + spec['attempt'] for s in before.values()):
        return result(spec, folder, 'unknown', before, 'Unit ownership does not match this attempt; no process was stopped')
    launch = read(folder / 'launch.json')
    if launch and before['supervisorUnit'].get('InvocationID') and launch.get('supervisorInvocation') != before['supervisorUnit']['InvocationID']:
        return result(spec, folder, 'unknown', before, 'Collector invocation changed; no process was stopped')
    proof = read(folder / 'started.json')
    if proof and proof.get('bootId') == boot_id():
        current = before['unit'].get('InvocationID')
        if current and current != proof.get('invocationId'):
            return result(spec, folder, 'unknown', before, 'Invocation identity changed; no process was stopped')
    # Stop the launcher first so it cannot create a worker after cancellation.
    command(['systemctl', '--user', 'stop', spec['supervisorUnit']], timeout=15, check=False)
    finished = read(folder / 'result.json')
    if finished and finished['status'] != 'unknown':
        return settled(spec, folder, finished)
    thawed = thaw_for_stop(spec, folder, proof, before['unit'])
    command(['systemctl', '--user', 'stop', spec['unit']], timeout=15, check=False)
    after = {key: show(spec[key]) for key in ('supervisorUnit', 'unit')}
    groups = [state.get('ControlGroup') for state in before.values()]
    if proof:
        groups.append(proof.get('controlGroup'))
    if all(unit_empty(v) for v in after.values()) and all(group_empty(g) for g in groups):
        return result(spec, folder, 'cancelled', {'before': before, 'after': after, 'groupsEmpty': groups, 'thawedToStop': thawed}, 'Cancellation confirmed: launcher and worker groups have exited. Earlier outcome may be unknown.')
    return result(spec, folder, 'unknown', {'before': before, 'after': after, 'thawedToStop': thawed}, 'Cancellation could not confirm empty process groups')

def supervise(spec, folder):
    # Unique transient unit plus a durable start intent: no automatic process retry.
    if read(folder / 'launch.json'):
        raise RuntimeError('This attempt already has a launch intent; reconcile instead of launching again')
    atomic(folder / 'launch.json', {'attempt': spec['attempt'], 'bootId': boot_id(), 'at': time.time(),
                                  'supervisorInvocation': os.environ.get('INVOCATION_ID'),
                                  'controlGroup': Path('/proc/self/cgroup').read_text().strip().split('::', 1)[1]})
    if read(folder / 'cancel.json'):
        return result(spec, folder, 'cancelled', {'workerStarted': False}, 'Cancelled before worker launch')
    resource = spec['resources']
    args = ['systemd-run', '--user', '--quiet', '--unit=' + spec['unit'], '--service-type=exec',
            '-p', 'Description=Yuzuno job ' + spec['attempt'],
            '--expand-environment=no', '-p', 'RemainAfterExit=yes', '-p', 'Restart=no',
            '-p', 'KillMode=control-group', '-p', 'OOMPolicy=kill', '-p', 'TimeoutStopSec=3s',
            '-p', 'RuntimeMaxSec=' + str(spec['timeoutSeconds']) + 's',
            '-p', 'MemoryMax=' + str(resource['memoryMiB']) + 'M',
            '-p', 'MemorySwapMax=' + str(resource['swapMiB']) + 'M',
            '-p', 'CPUQuota=' + str(resource['cpuMillis'] / 10) + '%', '-p', 'TasksMax=' + str(TASKS_MAX),
            '-p', 'StandardOutput=null', '-p', 'StandardError=null',
            '--', sys.executable, str(Path(__file__).resolve()), 'worker', str(folder / 'spec.json')]
    launch = command(args, check=False)
    launch_evidence = {'returnCode': launch.returncode, 'stderr': launch.stderr[:1000]}
    deadline = time.monotonic() + spec['timeoutSeconds'] + 20
    last = {}
    pids = None
    while time.monotonic() < deadline:
        last = show(spec['unit'])
        pids = pids_evidence(spec, folder, last, pids)
        status = classify(spec, folder, last)
        if status:
            outcome = result(spec, folder, status, {'launch': launch_evidence, 'systemd': last, 'pids': pids},
                             terminal_reason(spec, folder, status, last, pids))
            command(['systemctl', '--user', 'stop', spec['unit']], check=False)
            command(['systemctl', '--user', 'reset-failed', spec['unit']], check=False)
            return outcome
        if launch.returncode or (last.get('ActiveState') == 'failed' and not read(folder / 'started.json')):
            return result(spec, folder, 'unknown', {'launch': launch_evidence, 'systemd': last, 'pids': pids}, 'No verified worker start receipt; reconcile before retry')
        time.sleep(.5)
    return result(spec, folder, 'unknown', {'launch': launch_evidence, 'systemd': last, 'pids': pids}, 'No conclusive terminal evidence before collector deadline')

def reconcile(spec, folder):
    previous = read(folder / 'result.json')
    if previous and previous['status'] != 'unknown':
        return settled(spec, folder, previous)
    if spec['bootId'] != boot_id():
        return result(spec, folder, 'interrupted', {'expectedBootId': spec['bootId'], 'currentBootId': boot_id()}, 'OS boot changed; the previous process cannot continue')
    state = show(spec['unit'])
    status = classify(spec, folder, state)
    if status:
        pids = pids_evidence(spec, folder, state)
        return settled(spec, folder, result(spec, folder, status, {'systemd': state, 'pids': pids},
                                           terminal_reason(spec, folder, status, state, pids)))
    proof = read(folder / 'started.json')
    # A frozen worker still reads active/running; its cgroup tells paused apart.
    paused = freezer(proof) if proof and proof.get('invocationId') == state.get('InvocationID') else None
    return {'status': 'unresolved', 'systemd': state, 'supervisor': show(spec['supervisorUnit']), 'started': proof, 'freezer': paused}

def main():
    mode = sys.argv[1]
    if mode == 'gpus':
        print(json.dumps(gpus()))
        return
    if mode == 'capabilities':
        print(json.dumps(capabilities()))
        return
    if mode == 'snapshot':
        print(json.dumps(snapshot(json.load(sys.stdin))))
        return
    if mode == 'verify':
        request = json.load(sys.stdin)
        print(json.dumps([check_artifact(request['cwd'], a) for a in request['artifacts']]))
        return
    file = Path(sys.argv[2]).resolve()
    spec = read(file)
    folder = file.parent
    if mode == 'worker':
        sys.exit(worker(spec, folder))
    elif mode == 'supervise':
        supervise(spec, folder)
    elif mode == 'cancel':
        print(json.dumps(cancel(spec, folder)))
    elif mode == 'reconcile':
        print(json.dumps(reconcile(spec, folder)))
    elif mode == 'reports':
        print(json.dumps(reports(spec, folder)))
    elif mode == 'pause':
        print(json.dumps(pause(spec, folder)))
    elif mode == 'resume':
        print(json.dumps(resume(spec, folder)))
    elif mode == 'checkpoint':
        print(json.dumps(checkpoint_stop(spec, folder)))
    elif mode == 'inspect':
        state = show(spec['unit'])
        proof = read(folder / 'started.json')
        if proof and proof.get('bootId') == boot_id() and proof.get('invocationId') == state.get('InvocationID'):
            print(json.dumps(state))
        else:
            print('null')
    else:
        raise RuntimeError('Unknown host operation')

if __name__ == '__main__':
    main()
