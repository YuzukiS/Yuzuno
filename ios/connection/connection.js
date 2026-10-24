const form = document.querySelector('#connection-form');
const address = document.querySelector('#core-url');
const button = document.querySelector('#connect-button');
const message = document.querySelector('#connection-message');
const unsaved = document.querySelector('#open-unsaved');
const invoke = window.__TAURI__?.core?.invoke;

function show(text, error = false) {
  message.textContent = text;
  message.dataset.error = String(error);
}

function busy(on) {
  button.disabled = on;
  address.disabled = on;
  unsaved.disabled = on;
}

// What "Open without saving" opens: the Workspace that just answered, while
// its address is still the one in the field.
let answered = null;
function offerUnsaved(target) {
  answered = target;
  unsaved.hidden = !target;
}

// The app checks the address and that a Yuzuno Workspace answers there,
// saves it for next time, then the page opens it. A failure keeps the
// address to correct or retry. A Workspace that answered but could not be
// saved is said to be so: Connect tries again, or it opens without saving.
async function connect() {
  if (button.disabled) return;
  busy(true);
  offerUnsaved(null);
  show('Finding your workspace…');
  try {
    const result = await invoke('connect_core', { url: address.value });
    if (result.saved) {
      show('Found it. Opening your workspace…');
      window.location.replace(result.url);
      return;
    }
    show(`Your workspace answered, but this iPhone could not save its address (${result.saveError}). Connect to try saving again, or open it without saving: next time you would enter the address again.`, true);
    offerUnsaved(result.url);
    busy(false);
  } catch (error) {
    show(String(error), true);
    busy(false);
    address.focus();
  }
}

unsaved.addEventListener('click', () => {
  if (!answered || unsaved.disabled) return;
  show('Opening your workspace without saving its address…');
  window.location.replace(answered);
});

// Another address is not the Workspace that answered.
address.addEventListener('input', () => offerUnsaved(null));

form.addEventListener('submit', (event) => {
  event.preventDefault();
  connect();
});

// The last Workspace is filled in, not opened: one tap opens it, and its
// address can still be changed first. A saved address that cannot be read
// is said to be so, not taken for a first launch.
async function start() {
  if (!invoke) {
    busy(true);
    show('This page runs inside the Yuzuno app.', true);
    return;
  }
  const saved = await invoke('saved_core').catch((error) => ({ state: 'unreadable', reason: String(error) }));
  if (saved?.state === 'saved') {
    address.value = saved.url;
    show('Your last workspace. Connect to open it.');
  } else if (saved?.state === 'never') {
    show('Enter your workspace address to begin.');
  } else {
    show(`The workspace address saved on this iPhone could not be used (${saved?.reason ?? 'unknown'}). Enter it again: connecting saves it anew.`, true);
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
