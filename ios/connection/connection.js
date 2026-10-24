const form = document.querySelector('#connection-form');
const address = document.querySelector('#core-url');
const button = document.querySelector('#connect-button');
const message = document.querySelector('#connection-message');
const invoke = window.__TAURI__?.core?.invoke;

function show(text, error = false) {
  message.textContent = text;
  message.dataset.error = String(error);
}

function busy(on) {
  button.disabled = on;
  address.disabled = on;
}

// The app checks the address and that a Yuzuno Workspace answers there,
// then the page opens it. A failure keeps the address to correct or retry.
async function connect() {
  if (button.disabled) return;
  busy(true);
  show('Finding your workspace…');
  try {
    const target = await invoke('connect_core', { url: address.value });
    show('Found it. Opening your workspace…');
    window.location.replace(target);
  } catch (error) {
    show(String(error), true);
    busy(false);
    address.focus();
  }
}

form.addEventListener('submit', (event) => {
  event.preventDefault();
  connect();
});

// The last Workspace is filled in, not opened: one tap opens it, and its
// address can still be changed first.
async function start() {
  if (!invoke) {
    busy(true);
    show('This page runs inside the Yuzuno app.', true);
    return;
  }
  const saved = await invoke('saved_core').catch(() => null);
  if (saved) {
    address.value = saved;
    show('Your last workspace. Connect to open it.');
  } else {
    show('Enter your workspace address to begin.');
  }
}

start();

// The status bar's backdrop (connection.css) stays at the top of what is
// seen. With the keyboard open, iOS scrolls the visual viewport and leaves
// the layout viewport, which the backdrop is fixed to, behind.
const visual = window.visualViewport;
function followVisualViewport() {
  document.documentElement.style.setProperty('--visual-top', `${visual.offsetTop}px`);
}
if (visual) {
  visual.addEventListener('resize', followVisualViewport);
  visual.addEventListener('scroll', followVisualViewport);
  followVisualViewport();
}
