// T-88 lab B: one candidate Core on its loopback port, reached only through
// SSH tunnels whose local ports differ from Core's: Chromium on Linux through
// OpenSSH, and Edge on Windows through Windows' own ssh.exe. Both clients use
// the same Workspace at once. Each tunnel is dropped with an unsent draft and
// restored. A lab sshd (user-level, loopback, public key only, forwarding
// only to Core's port) stands in for the Core host's SSH server.
//
// Only this lab's processes are started or signalled: its Core, sshd and
// ssh clients, its headless Chromium, and on Windows the ssh.exe and
// headless Edge whose command lines name this run's directory. The daily
// Core, its data and windows, and the user's own Edge are never touched.
// Claude Code runs with the user's own login (Haiku only).
//
// Usage: tunnel-lab.mjs <yuzuno-workspace> <lab dir> <web dir> <bridge.mjs>.
// Writes report.json in the lab dir; exits 1 if a check failed.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { basename, resolve } from 'node:path';
import { answerText, api, chromium, composerText, coreStatus, createClaudeAgent, delay, savedDraft, sendAndFinish, turnsOf, typeDraft, until, waitConnected } from './ui.mjs';

const [bin, lab, web, bridge] = process.argv.slice(2).map(p => resolve(p));
assert.ok(bin && lab && web && bridge);
const CORE = 4489, SSHD = 4490, LINUX = 5489, WINDOWS = 5490, CDP = 9489;
const direct = `http://127.0.0.1:${CORE}`, linuxBase = `http://127.0.0.1:${LINUX}`, windowsBase = `http://127.0.0.1:${WINDOWS}`;
const NODE_BIN = (process.env.HOME + '/.local/share/fnm/node-versions/v22.23.2/installation/bin');
const SSH_EXE = '/mnt/c/Windows/System32/OpenSSH/ssh.exe';
const EDGE = '/mnt/c/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const POWERSHELL = '/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe';
const CURL_EXE = '/mnt/c/Windows/System32/curl.exe';
const ICACLS = '/mnt/c/Windows/System32/icacls.exe';
const run = basename(lab);
const tag = `yuzuno-t88-${run}`; // names every Windows process and file of this run
const user = process.env.USER || 'tester';
const report = { startedAt: new Date().toISOString(), lab, ports: { CORE, SSHD, LINUX, WINDOWS, CDP }, checks: [], pageErrors: [], passed: false };
const owned = { core: null, sshd: null, linuxTunnel: null, windowsTunnel: null };
let linuxContext, edge;

function check(name, ok, data = {}) {
  report.checks.push({ name, ok: !!ok, ...data });
  console.log(ok ? 'PASS' : 'FAIL', name, JSON.stringify(data).slice(0, 500));
  assert.ok(ok, name);
}
const sh = (cmd, args, opts = {}) => spawnSync(cmd, args, { encoding: 'utf8', timeout: 60000, ...opts });
const open = port => new Promise(done => {
  const socket = net.connect({ host: '127.0.0.1', port });
  socket.once('connect', () => { socket.destroy(); done(true); });
  socket.once('error', () => done(false));
  socket.setTimeout(2000, () => { socket.destroy(); done(false); });
});
// Encoded, so no quoting is lost between WSL's argv and Windows' command line.
const ps = command => sh(POWERSHELL, ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(command, 'utf16le').toString('base64')], { cwd: '/mnt/c/' });
const winPath = path => sh('wslpath', ['-w', path]).stdout.trim();
const windowsTemp = sh('wslpath', ['-u', ps('[IO.Path]::GetTempPath()').stdout.trim()]).stdout.trim();
const winDir = resolve(windowsTemp, tag);

// Stops only Windows processes of this run: their command line names `tag`.
function stopWindows(name) {
  const result = ps(`Get-CimInstance Win32_Process -Filter "Name='${name}'" | Where-Object { $_.CommandLine -like '*${tag}*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue; $_.ProcessId }`);
  return result.stdout.split(/\s+/).filter(Boolean).map(Number);
}
function windowsListener(port) {
  const result = ps(`$c = Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1; if ($c) { (Get-Process -Id $c.OwningProcess).ProcessName + ' ' + $c.OwningProcess }`);
  return result.stdout.trim();
}
function linuxListener(port) {
  return sh('ss', ['-ltnpH', `sport = :${port}`]).stdout.trim();
}

function startCore() {
  const log = openSync(resolve(lab, 'core.log'), 'a');
  owned.core = spawn(bin, ['--port', String(CORE), '--data-dir', resolve(lab, 'data'), '--web-dir', web, '--cwd', resolve(lab, 'project'), '--codex', '/bin/false'], {
    cwd: lab, stdio: ['ignore', log, log], detached: true,
    env: { HOME: process.env.HOME, LANG: 'C.UTF-8', PATH: `${NODE_BIN}:/usr/local/bin:/usr/bin:/bin`, YUZUNO_CLAUDE_BRIDGE: bridge, TMPDIR: resolve(lab, 'tmp') },
  });
}

function startSshd() {
  const dir = resolve(lab, 'ssh');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  for (const name of ['host', 'client'])
    assert.equal(sh('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', `t88-${name}`, '-f', resolve(dir, name)]).status, 0);
  const client = readFileSync(resolve(dir, 'client.pub'), 'utf8').trim();
  // The key may only forward to Core's loopback port: no shell, no other target.
  writeFileSync(resolve(dir, 'authorized_keys'), `restrict,port-forwarding,permitopen="127.0.0.1:${CORE}" ${client}\n`, { mode: 0o600 });
  writeFileSync(resolve(dir, 'known_hosts'), `[127.0.0.1]:${SSHD} ${readFileSync(resolve(dir, 'host.pub'), 'utf8').trim()}\n`);
  writeFileSync(resolve(dir, 'sshd_config'), [
    `Port ${SSHD}`, 'ListenAddress 127.0.0.1', `HostKey ${resolve(dir, 'host')}`, `PidFile ${resolve(dir, 'sshd.pid')}`,
    `AuthorizedKeysFile ${resolve(dir, 'authorized_keys')}`, 'AuthenticationMethods publickey', 'PasswordAuthentication no',
    'KbdInteractiveAuthentication no', 'UsePAM no', 'StrictModes no', 'AllowTcpForwarding local', 'GatewayPorts no',
    'PermitTTY no', 'X11Forwarding no', 'AllowAgentForwarding no', 'PermitTunnel no', `AllowUsers ${user}`, '',
  ].join('\n'));
  const log = openSync(resolve(lab, 'sshd.log'), 'a');
  owned.sshd = spawn('/usr/sbin/sshd', ['-D', '-e', '-f', resolve(dir, 'sshd_config')], { stdio: ['ignore', log, log], detached: true });
  return dir;
}

function linuxTunnel(dir) {
  const log = openSync(resolve(lab, 'linux-ssh.log'), 'a');
  owned.linuxTunnel = spawn('ssh', ['-N', '-F', '/dev/null', '-i', resolve(dir, 'client'), '-o', 'IdentitiesOnly=yes', '-o', 'BatchMode=yes',
    '-o', `UserKnownHostsFile=${resolve(dir, 'known_hosts')}`, '-o', 'StrictHostKeyChecking=yes', '-o', 'ExitOnForwardFailure=yes',
    '-L', `${LINUX}:127.0.0.1:${CORE}`, '-p', String(SSHD), `${user}@127.0.0.1`], { stdio: ['ignore', log, log] });
}

function windowsTunnel() {
  const log = openSync(resolve(lab, 'windows-ssh.log'), 'a');
  owned.windowsTunnel = spawn(SSH_EXE, ['-N', '-F', 'none', '-i', winPath(resolve(winDir, 'client')), '-o', 'IdentitiesOnly=yes', '-o', 'BatchMode=yes',
    '-o', `UserKnownHostsFile=${winPath(resolve(winDir, 'known_hosts'))}`, '-o', 'StrictHostKeyChecking=yes', '-o', 'ExitOnForwardFailure=yes',
    '-L', `${WINDOWS}:127.0.0.1:${CORE}`, '-p', String(SSHD), `${user}@127.0.0.1`], { cwd: winDir, stdio: ['ignore', log, log] });
}

async function curlStatus(base, path, headers = [], method = 'GET', exe = 'curl') {
  const args = ['-s', '-o', exe === 'curl' ? '/dev/null' : 'NUL', '-w', '%{http_code}', '-X', method, ...headers.flatMap(h => ['-H', h])];
  if (method === 'POST') args.push('-H', 'content-type: application/json', '--data', '{}');
  return Number(sh(exe, [...args, base + path], exe === 'curl' ? {} : { cwd: '/mnt/c/' }).stdout.trim());
}

// The page's own view of its connection while its tunnel is gone.
async function dropped(page, name, agentId, draft, label) {
  const status = await until(async () => {
    const s = await coreStatus(page);
    return s && s !== 'Core connected' && s !== 'Connecting to Core' ? s : null;
  }, 60000, `${label}: the page notices the dropped tunnel`);
  const send = page.getByRole('button', { name: 'Send message', exact: true });
  check(`${label}: tunnel dropped: the page says so, sending is held, the draft stays`,
    (await send.isDisabled()) && (await composerText(page, name)) === draft && (await savedDraft(page, agentId)) === draft,
    { status, composer: await composerText(page, name) });
  return status;
}

async function restored(page, name, agentId, draft, label, workspaceId) {
  await waitConnected(page, 60000);
  const seen = (await page.evaluate(() => fetch('/api/health').then(r => r.json()))).workspaceId;
  check(`${label}: tunnel restored: the same page reconnects to the same Workspace with the draft`,
    seen === workspaceId && (await composerText(page, name)) === draft, { workspaceId: seen });
}

async function main() {
  for (const port of [CORE, SSHD, LINUX, WINDOWS, CDP])
    if (await open(port)) throw Error(`Port ${port} is in use; nothing was started`);
  for (const name of ['data', 'project', 'tmp']) mkdirSync(resolve(lab, name), { recursive: true });
  report.binarySha256 = sh('sha256sum', [bin]).stdout.split(' ')[0];
  startCore();
  const health = await until(() => api(direct, '/health'), 60000, 'Core health');
  const workspaceId = health.workspaceId;
  report.health = health;
  const dir = startSshd();
  await until(() => open(SSHD), 20000, 'the lab sshd');

  // --- Linux client through OpenSSH ---------------------------------------
  check('Linux: nothing answers on the tunnel port before the tunnel exists', !(await open(LINUX)));
  linuxTunnel(dir);
  await until(() => open(LINUX), 20000, 'the Linux tunnel');
  report.linuxListener = linuxListener(LINUX);
  check('Linux: the tunnel port belongs to ssh', /"ssh"/.test(report.linuxListener), { listener: report.linuxListener });
  check('Linux: through the tunnel (local port ≠ Core port), health shows the same Workspace',
    (await api(linuxBase, '/health')).workspaceId === workspaceId);
  const refusals = {
    otherOrigin: await curlStatus(linuxBase, '/api/projects', [`Origin: http://127.0.0.1:${CORE}`, 'x-yuzuno-client: desktop'], 'POST'),
    otherLoopbackName: await curlStatus(linuxBase, '/api/projects', [`Origin: http://localhost:${LINUX}`, 'x-yuzuno-client: desktop'], 'POST'),
    noClientHeader: await curlStatus(linuxBase, '/api/projects', [`Origin: ${linuxBase}`], 'POST'),
    domainHost: await curlStatus(linuxBase, '/api/health', [`Host: yuzuno.example:${LINUX}`]),
  };
  check('Linux: through the tunnel, a foreign Origin, a mutation without the client header and a domain Host are refused',
    Object.values(refusals).every(code => code === 403), refusals);

  // --- Windows tunnel and Edge, proven before any model turn ----------------
  mkdirSync(winDir, { recursive: true });
  copyFileSync(resolve(dir, 'client'), resolve(winDir, 'client'));
  copyFileSync(resolve(dir, 'known_hosts'), resolve(winDir, 'known_hosts'));
  // Windows OpenSSH ignores a private key anyone else may read, and the temp
  // folder's inherited ACL can include other groups (lab r1): owner only.
  const me = ps('$env:USERNAME').stdout.trim();
  const acl = sh(ICACLS, [winPath(resolve(winDir, 'client')), '/inheritance:r', '/grant:r', `${me}:F`], { cwd: '/mnt/c/' });
  assert.equal(acl.status, 0, `icacls: ${acl.stdout}${acl.stderr}`);
  report.windows = { dir: winPath(winDir), ssh: sh(SSH_EXE, ['-V'], { cwd: '/mnt/c/' }).stderr.trim() };
  check('Windows: nothing listens on the tunnel port before the tunnel exists', !(await open(WINDOWS)) && !windowsListener(WINDOWS));
  windowsTunnel();
  await until(() => open(WINDOWS), 30000, 'the Windows tunnel');
  report.windows.listener = windowsListener(WINDOWS);
  check('Windows: the tunnel port belongs to Windows ssh.exe', /^ssh /.test(report.windows.listener), { listener: report.windows.listener });
  const viaCurl = JSON.parse(sh(CURL_EXE, ['-s', `${windowsBase}/api/health`], { cwd: '/mnt/c/' }).stdout);
  const noHeader = await curlStatus(windowsBase, '/api/projects', [`Origin: ${windowsBase}`], 'POST', CURL_EXE);
  check('Windows: curl.exe through the tunnel sees the same Workspace; a mutation without the client header is refused',
    viaCurl.workspaceId === workspaceId && noHeader === 403, { noHeader });
  spawn(EDGE, ['--headless=new', `--remote-debugging-port=${CDP}`, `--user-data-dir=${winPath(resolve(winDir, 'edge'))}`,
    '--no-first-run', '--no-default-browser-check', '--disable-sync', 'about:blank'], { cwd: winDir, stdio: 'ignore', detached: true }).unref();
  const version = await until(() => fetch(`http://127.0.0.1:${CDP}/json/version`).then(r => r.json()), 60000, 'headless Edge');
  report.windows.edge = version.Browser;
  edge = await chromium.connectOverCDP(`http://127.0.0.1:${CDP}`);
  const wp = await edge.contexts()[0].newPage();
  wp.setDefaultTimeout(60000);
  wp.on('pageerror', e => report.pageErrors.push(`windows: ${e.message}`));
  await wp.goto(windowsBase);
  await waitConnected(wp);
  const ua = await wp.evaluate(() => navigator.userAgent);
  check('Windows: Edge on Windows opens the Workspace through its tunnel', /Windows NT/.test(ua) && /Edg\//.test(ua), { ua, edge: version.Browser });

  // --- Linux client: first Agent, approval, drops --------------------------
  const linuxBrowser = await chromium.launchPersistentContext(resolve(lab, 'linux-profile'), {
    executablePath: '/usr/sbin/chromium', headless: true, viewport: { width: 1440, height: 960 }, args: ['--disable-dev-shm-usage'],
  });
  linuxContext = linuxBrowser;
  const lp = linuxBrowser.pages()[0] || await linuxBrowser.newPage();
  lp.setDefaultTimeout(60000);
  lp.on('pageerror', e => report.pageErrors.push(`linux: ${e.message}`));
  await lp.goto(linuxBase);
  await waitConnected(lp);
  const name = 'T-88 tunnel agent';
  // The harness reads Core directly; the pages use only their tunnels.
  const agent = await createClaudeAgent(lp, direct, { name, cwd: resolve(lab, 'project') });
  report.agent = agent;
  await lp.getByRole('textbox', { name: `Message ${name}`, exact: true })
    .fill('Use the Write tool to create a file named t88-linux.txt containing the word ok, then reply with the single word done.');
  let result = await sendAndFinish(lp, direct, agent.id, { approve: true });
  const linuxFile = readFileSync(resolve(lab, 'project/t88-linux.txt'), 'utf8').trim();
  check('Linux: a Claude Agent created in the page answers through the tunnel after "Allow once" in the page',
    result.turn.status === 'completed' && result.approvals >= 1 && linuxFile === 'ok', { approvals: result.approvals, answer: answerText(result.turn).slice(0, 60) });

  let draft = 'Reply with the single word linux.';
  await typeDraft(lp, name, agent.id, draft);
  owned.linuxTunnel.kill('SIGTERM');
  await until(async () => !(await open(LINUX)), 10000, 'the Linux tunnel closes');
  report.linuxDropStatus = await dropped(lp, name, agent.id, draft, 'Linux');
  check('Linux: Core itself kept running with the same Workspace while the tunnel was down',
    (await api(direct, '/health')).workspaceId === workspaceId && owned.core.exitCode === null);
  linuxTunnel(dir);
  await until(() => open(LINUX), 20000, 'the Linux tunnel again');
  await restored(lp, name, agent.id, draft, 'Linux', workspaceId);
  // A reload while the tunnel is down fails in the browser; nothing else starts.
  owned.linuxTunnel.kill('SIGTERM');
  await until(async () => !(await open(LINUX)), 10000, 'the Linux tunnel closes again');
  const reload = await lp.reload().then(() => 'loaded', e => e.message.split('\n')[0]);
  check('Linux: reloading without the tunnel fails in the browser', reload !== 'loaded', { reload });
  linuxTunnel(dir);
  await until(() => open(LINUX), 20000, 'the Linux tunnel a third time');
  await lp.goto(linuxBase);
  await waitConnected(lp);
  check('Linux: after the failed reload and a new tunnel, the draft is back', (await composerText(lp, name)) === draft);
  result = await sendAndFinish(lp, direct, agent.id);
  check('Linux: the kept draft is sent and answered', result.turn.status === 'completed' && /linux/i.test(answerText(result.turn)),
    { answer: answerText(result.turn).slice(0, 60) });
  await lp.screenshot({ path: resolve(lab, 'linux.png') });

  // --- Windows client: same Agent, approval, drop ---------------------------
  // Edge has been open on the Workspace since before the Agent existed.
  await wp.waitForFunction(name => document.body.innerText.includes(name), name);
  await wp.evaluate(id => localStorage.setItem('yuzuno.selected', id), agent.id);
  await wp.reload();
  await waitConnected(wp);
  await wp.getByRole('heading', { name, exact: true }).waitFor();
  await wp.getByText('create a file named t88-linux.txt', { exact: false }).first().waitFor();
  check('Windows: the Agent created on Linux appeared live in Edge, with its history', true);
  await wp.getByRole('textbox', { name: `Message ${name}`, exact: true })
    .fill('Use the Write tool to create a file named t88-windows.txt containing the word ok, then reply with the single word done.');
  result = await sendAndFinish(wp, direct, agent.id, { approve: true });
  const windowsFile = readFileSync(resolve(lab, 'project/t88-windows.txt'), 'utf8').trim();
  check('Windows: a turn sent from Edge is approved in Edge and completes on the Linux Core',
    result.turn.status === 'completed' && result.approvals >= 1 && windowsFile === 'ok', { approvals: result.approvals });

  draft = 'Reply with the single word windows.';
  await typeDraft(wp, name, agent.id, draft);
  const stopped = stopWindows('ssh.exe');
  await until(async () => !(await open(WINDOWS)), 15000, 'the Windows tunnel closes');
  report.windows.stoppedTunnel = stopped;
  report.windows.dropStatus = await dropped(wp, name, agent.id, draft, 'Windows');
  windowsTunnel();
  await until(() => open(WINDOWS), 30000, 'the Windows tunnel again');
  await restored(wp, name, agent.id, draft, 'Windows', workspaceId);
  result = await sendAndFinish(wp, direct, agent.id);
  check('Windows: the kept draft is sent and answered', result.turn.status === 'completed' && /windows/i.test(answerText(result.turn)),
    { answer: answerText(result.turn).slice(0, 60) });
  await wp.screenshot({ path: resolve(lab, 'windows.png') });

  // Both clients at once on one Workspace.
  await lp.getByText('create a file named t88-windows.txt', { exact: false }).first().waitFor();
  const turns = await turnsOf(direct, agent.id);
  const workspaces = new Set([workspaceId, (await api(linuxBase, '/health')).workspaceId, (await api(windowsBase, '/health')).workspaceId]);
  check('both clients: the Linux page shows the Windows turns live; one Workspace, four completed turns',
    workspaces.size === 1 && turns.length === 4 && turns.every(t => t.status === 'completed'), { turns: turns.length });
}

async function cleanup() {
  await linuxContext?.close().catch(() => {});
  if (edge) {
    const session = await edge.newBrowserCDPSession().catch(() => null);
    await session?.send('Browser.close').catch(() => {});
  }
  await delay(1500);
  report.windowsCleanup = { edge: stopWindows('msedge.exe'), ssh: stopWindows('ssh.exe') };
  for (const key of ['linuxTunnel', 'sshd']) owned[key]?.kill('SIGTERM');
  if (owned.core && owned.core.exitCode === null) {
    owned.core.kill('SIGINT');
    await until(async () => owned.core.exitCode !== null || null, 30000, 'Core exit').catch(() => owned.core.kill('SIGKILL'));
  }
  // The copied lab key must not stay on Windows.
  for (let i = 0; i < 10 && existsSync(winDir); i++) {
    try { rmSync(winDir, { recursive: true, force: true }); } catch { await delay(1000); }
  }
  report.windowsDirRemoved = !existsSync(winDir);
  report.leftoverWindows = { edge: stopWindows('msedge.exe'), ssh: stopWindows('ssh.exe') };
  report.leftoverLinux = sh('pgrep', ['-af', lab]).stdout.split('\n').filter(l => l && !l.includes('tunnel-lab.mjs') && !l.includes('lab-b.sh'));
}

try {
  await main();
  report.passed = true;
} catch (error) {
  report.error = String(error?.stack || error).slice(0, 2000);
  console.log('ERROR', report.error);
} finally {
  await cleanup();
  report.finishedAt = new Date().toISOString();
  writeFileSync(resolve(lab, 'report.json'), JSON.stringify(report, null, 2) + '\n');
}
process.exit(report.passed ? 0 : 1);
