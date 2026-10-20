const form = document.querySelector('#connection-form');
const address = document.querySelector('#core-url');
const button = document.querySelector('#connect-button');
const message = document.querySelector('#connection-message');
const invoke = window.__TAURI__?.core?.invoke;

function show(text, error = false) {
  message.textContent = text;
  message.dataset.error = String(error);
}

async function connect() {
  if (button.disabled) return;
  button.disabled = true;
  address.disabled = true;
  show('Finding your workspace…');
  try {
    const target = await invoke('connect_core', { url: address.value });
    show('Found it. Opening your workspace…');
    window.location.replace(target);
  } catch (error) {
    show(String(error), true);
    button.textContent = 'Try again ↗';
  } finally {
    button.disabled = false;
    address.disabled = false;
  }
}

form.addEventListener('submit', (event) => {
  event.preventDefault();
  if (invoke) void connect();
});

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
