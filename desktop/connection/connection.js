const form = document.querySelector('#connection-form');
const address = document.querySelector('#core-url');
const button = document.querySelector('#connect-button');
const message = document.querySelector('#connection-message');
const startRow = document.querySelector('#start-row');
const startButton = document.querySelector('#start-button');
const startHint = document.querySelector('#start-hint');
const invoke = window.__TAURI__?.core?.invoke;

// The saved Core this app may start in WSL ({ coreUrl, distro, confirmed }),
// offered once connecting to that same address has failed. Not confirmed
// yet: only the Core said where it is installed, and an address on this
// computer may be a tunnel to another one; the user's start decides.
let startable = null;

function offerFrom(info) {
  startable = info.startDistro
    ? { coreUrl: info.coreUrl, distro: info.startDistro, confirmed: Boolean(info.startConfirmed) }
    : null;
  if (!startable) return;
  startButton.textContent = startable.confirmed
    ? `Start in this computer's WSL (${startable.distro})`
    : "Start in this computer's WSL";
  startHint.textContent = startable.confirmed
    ? 'Starts this Workspace\'s Core, as this app has started it here before.'
    : `This Workspace says its Core is in WSL (${startable.distro}). Start it here only if it is installed in this computer's WSL; a Core on another computer starts there.`;
}
let unreachable = false;

function show(text, error = false) {
  message.textContent = text;
  message.dataset.error = String(error);
}

function sameCore(value, coreUrl) {
  try {
    return new URL(value.trim()).origin === new URL(coreUrl).origin;
  } catch {
    return false;
  }
}

function showStart() {
  startRow.hidden = !(startable && unreachable && sameCore(address.value, startable.coreUrl));
}

function busy(on) {
  button.disabled = on;
  address.disabled = on;
  startButton.disabled = on;
}

async function connect() {
  if (button.disabled) return;
  busy(true);
  show('Finding your workspace…');
  try {
    const target = await invoke('connect_core', { url: address.value });
    show('Found it. Opening your workspace…');
    window.location.replace(target);
  } catch (error) {
    unreachable = true;
    show(String(error), true);
    button.textContent = 'Try again ↗';
  } finally {
    busy(false);
    showStart();
  }
}

async function start() {
  if (startButton.disabled || !startable) return;
  busy(true);
  show(`Starting Core in this computer's WSL (${startable.distro})… This can take a minute.`);
  try {
    const target = await invoke('start_core', { url: address.value });
    show('Core is running. Opening your workspace…');
    window.location.replace(target);
  } catch (error) {
    show(String(error), true);
    // What the attempt changed: an unconfirmed start that this computer's
    // WSL refused is no longer offered.
    try {
      offerFrom(await invoke('connection_info'));
    } catch {
      // Keep the page as it is.
    }
  } finally {
    busy(false);
    showStart();
  }
}

form.addEventListener('submit', (event) => {
  event.preventDefault();
  if (invoke) void connect();
});
startButton.addEventListener('click', () => {
  if (invoke) void start();
});
address.addEventListener('input', showStart);

async function init() {
  if (!invoke) {
    show('Connection page preview · Open the desktop app to connect.');
    button.disabled = true;
    return;
  }
  // The embedded connection page has a fixed light palette. This never
  // changes the workspace's per-origin appearance preference.
  void invoke('set_appearance', { theme: 'light' }).catch(() => {});
  try {
    const info = await invoke('connection_info');
    address.value = info.coreUrl;
    offerFrom(info);
    if (info.error) show(info.error, true);
    else if (info.autoConnect) await connect();
    else show('Choose a workspace, then connect.');
  } catch (error) {
    show(`Could not load the connection settings: ${String(error)}`, true);
  }
}

void init();

// Without a system frame (Windows), this page's top band moves the window and
// its own buttons minimize, maximize and close it. An older shell, or one that
// kept the frame, leaves them hidden.
const frame = window.__TAURI__?.window?.getCurrentWindow?.();
const controls = document.querySelector('.window-controls');
const MOVE_BAND = 72;

async function initFrame() {
  if (!frame) return;
  try {
    if (await frame.isDecorated()) return;
  } catch {
    return;
  }
  controls.hidden = false;
  controls.addEventListener('click', (event) => {
    const action = event.target.closest('[data-window]')?.dataset.window;
    if (action === 'minimize') void frame.minimize();
    else if (action === 'maximize') void frame.toggleMaximize();
    else if (action === 'close') void frame.close();
  });
  document.addEventListener('mousedown', (event) => {
    if (event.button !== 0 || event.clientY > MOVE_BAND) return;
    if (event.target.closest('button, a, input, label, select, textarea')) return;
    event.preventDefault();
    void (event.detail === 2 ? frame.toggleMaximize() : frame.startDragging());
  });
}

void initFrame();
