const form = document.querySelector('#connection-form');
const address = document.querySelector('#core-url');
const button = document.querySelector('#connect-button');
const message = document.querySelector('#connection-message');
const startRow = document.querySelector('#start-row');
const startButton = document.querySelector('#start-button');
const startHint = document.querySelector('#start-hint');
const savedSection = document.querySelector('#saved-cores');
const savedList = document.querySelector('#saved-list');
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

// The Workspaces saved here, as connection_info answers them. Saved is not
// reachable: this draws what is written down and claims nothing about it.
// A list that could not be read is not an empty list, and is not drawn as
// one: nothing is listed, and the message says why.
function drawSaved(info) {
  const saved = info.savedError ? [] : info.saved ?? [];
  savedSection.hidden = saved.length === 0;
  savedList.replaceChildren();
  for (const entry of saved) {
    const item = document.createElement('li');
    if (info.selected === entry.id) item.dataset.selected = 'true';
    const open = document.createElement('button');
    open.type = 'button';
    open.className = 'saved-open';
    open.append(Object.assign(document.createElement('span'), { className: 'saved-name', textContent: entry.name }));
    open.append(Object.assign(document.createElement('span'), { className: 'saved-url', textContent: entry.url }));
    // Two Workspaces may share a name, and an address alone does not tell
    // them apart either: which one this is, is its workspace.
    open.append(
      Object.assign(document.createElement('span'), {
        className: 'saved-workspace',
        textContent: entry.workspaceId ? `workspace ${entry.workspaceId}` : 'not opened yet on this computer',
      }),
    );
    // Only one entry may start a Core, and only where this app can start
    // one: the Mac never reports this, whatever a record carries.
    if (entry.startable) {
      open.append(
        Object.assign(document.createElement('span'), {
          className: 'saved-start',
          textContent: 'can start its Core in WSL',
        }),
      );
    }
    open.addEventListener('click', () => {
      address.value = entry.url;
      void connect();
    });
    const rename = document.createElement('button');
    rename.type = 'button';
    rename.className = 'saved-rename secondary';
    rename.textContent = 'Rename';
    rename.setAttribute('aria-label', `Rename ${entry.name}`);
    rename.addEventListener('click', () => void renameEntry(entry));
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'saved-remove secondary';
    remove.textContent = 'Remove';
    remove.setAttribute('aria-label', `Remove ${entry.name}`);
    remove.addEventListener('click', () => void removeEntry(entry));
    item.append(open, rename, remove);
    savedList.append(item);
  }
}

async function renameEntry(entry) {
  const name = window.prompt(`What should this computer call ${entry.url}?`, entry.name);
  if (name === null) return;
  try {
    drawSaved(await invoke('rename_core', { entry: entry.id, name }));
    show('Renamed. That is the name on this computer; the workspace itself is unchanged.');
  } catch (error) {
    show(String(error), true);
  }
}

async function removeEntry(entry) {
  // What removing does, and what it does not, before it is done.
  const sure = window.confirm(
    `Remove \u201C${entry.name}\u201D from this computer?\n\n` +
      'This forgets its address here, and any start profile saved for it. It changes nothing on the workspace, and nothing it is doing stops.',
  );
  if (!sure) return;
  try {
    drawSaved(await invoke('remove_core', { entry: entry.id }));
    show(`\u201C${entry.name}\u201D is no longer saved on this computer.`);
  } catch (error) {
    show(String(error), true);
  }
}


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
    drawSaved(info);
    if (info.savedError) {
      // Not "enter it again and it will be saved": connecting is refused
      // while this is so, and nothing is written over what is saved.
      show(
        `The workspaces saved on this computer could not be used (${info.savedError}). What is saved has not been changed. Until they can be read, this app will not open a workspace, because it could not tell which one answered.`,
        true,
      );
    } else if (info.error) show(info.error, true);
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
