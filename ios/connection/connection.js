const form = document.querySelector('#connection-form');
const address = document.querySelector('#core-url');
const about = document.querySelector('#form-about');
const nameField = document.querySelector('#core-name');
const button = document.querySelector('#connect-button');
const message = document.querySelector('#connection-message');
const unsaved = document.querySelector('#open-unsaved');
const savedSection = document.querySelector('#saved-cores');
const savedList = document.querySelector('#saved-list');
const rememberedSection = document.querySelector('#remembered');
const rememberedList = document.querySelector('#remembered-list');
const identity = document.querySelector('#identity-check');
const identityText = document.querySelector('#identity-text');
const identityCancel = document.querySelector('#identity-cancel');
const invoke = window.__TAURI__?.core?.invoke;

function show(text, error = false) {
  message.textContent = text;
  message.dataset.error = String(error);
}

function busy(on) {
  button.disabled = on;
  address.disabled = on;
  nameField.disabled = on;
  unsaved.disabled = on;
  for (const control of savedList.querySelectorAll('button')) control.disabled = on;
  for (const control of rememberedList.querySelectorAll('button')) control.disabled = on;
}

// What "Open without saving" opens: the Workspace that just answered, while
// its address is still the one in the field.
let answered = null;
function offerUnsaved(target) {
  answered = target;
  unsaved.hidden = !target;
}

// A Workspace this page was asked to open that answered as a different one.
// Nothing opens until that is answered.
let different = null;
function askAboutIdentity(result) {
  different = result;
  identity.hidden = !result;
  if (!result) return;
  identityText.textContent =
    `“${result.profileName}” answered as a different workspace than the one saved under that name, ` +
    'so this app did not open it. It cannot keep the two apart here: both workspaces at one address share ' +
    'what this app stores for that address, and an unsent message is kept per agent, not per workspace, so ' +
    'they would hand each other their drafts. Save this one at an address of its own. Removing the saved ' +
    'workspace only forgets what this iPhone saved about it; it does not clear what is stored for that address.';
}

// Two addresses that differ only by a trailing slash are one address. The
// app is what parses and normalises them; this is the page's own comparison.
const sameAddress = (typed, saved) =>
  typed.trim().replace(/\/+$/, '') === String(saved).replace(/\/+$/, '');

// Which saved Workspace the form is about: one of them, or none, which saves
// a new one. The form says which, so Connect is never ambiguous.
let editing = null;
function label(open) {
  button.replaceChildren(open ? 'Open ' : 'Connect ');
  button.append(Object.assign(document.createElement('span'), { ariaHidden: 'true', textContent: '↗' }));
}
function edit(profile) {
  editing = profile;
  address.value = profile ? profile.url : '';
  nameField.value = profile ? profile.name : '';
  about.textContent = profile
    ? `Opening ${profile.name}. Change the address to save another workspace instead.`
    : '';
  about.hidden = !profile;
  label(Boolean(profile));
  offerUnsaved(null);
  askAboutIdentity(null);
}

// The saved list, as `saved_cores` answers it. Saved is not reachable: this
// draws what is written down on this iPhone and claims nothing about it.
function drawSaved(saved) {
  const profiles = saved?.profiles ?? [];
  savedSection.hidden = profiles.length === 0;
  savedList.replaceChildren();
  for (const profile of profiles) {
    const item = document.createElement('li');
    if (saved.selected === profile.id) item.dataset.selected = 'true';
    const open = document.createElement('button');
    open.type = 'button';
    open.className = 'saved-open';
    open.append(Object.assign(document.createElement('span'), { className: 'saved-name', textContent: profile.name }));
    open.append(Object.assign(document.createElement('span'), { className: 'saved-url', textContent: profile.url }));
    // Two Workspaces may share a name, and an address alone does not tell
    // them apart either: which one this is, is its workspace, once one has
    // answered here.
    open.append(
      Object.assign(document.createElement('span'), {
        className: 'saved-workspace',
        textContent: profile.workspaceId ? `workspace ${profile.workspaceId}` : 'not opened yet on this iPhone',
      }),
    );
    open.addEventListener('click', () => {
      edit(profile);
      connect();
    });
    const rename = document.createElement('button');
    rename.type = 'button';
    rename.className = 'saved-rename';
    rename.textContent = 'Rename';
    rename.setAttribute('aria-label', `Rename ${profile.name}`);
    rename.addEventListener('click', () => renameProfile(profile));
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'saved-remove';
    remove.textContent = 'Remove';
    remove.setAttribute('aria-label', `Remove ${profile.name}`);
    remove.addEventListener('click', () => removeProfile(profile));
    item.append(open, rename, remove);
    savedList.append(item);
  }
  drawRemembered(saved);
}

// Addresses with no profile whose Workspace this iPhone still remembers.
// They are shown because they are the reason a connection there can be
// refused, and a refusal whose cause is invisible looks like a fault.
function drawRemembered(saved) {
  const addresses = saved?.remembered ?? [];
  rememberedSection.hidden = addresses.length === 0;
  rememberedList.replaceChildren();
  for (const known of addresses) {
    const item = document.createElement('li');
    item.append(Object.assign(document.createElement('span'), { className: 'saved-url', textContent: known.url }));
    item.append(
      Object.assign(document.createElement('span'), {
        className: 'saved-workspace',
        textContent: `workspace ${known.workspaceId} was here`,
      }),
    );
    const forget = document.createElement('button');
    forget.type = 'button';
    forget.className = 'saved-forget';
    forget.textContent = 'Forget';
    forget.setAttribute('aria-label', `Forget which workspace was at ${known.url}`);
    forget.addEventListener('click', () => forgetAddress(known));
    item.append(forget);
    rememberedList.append(item);
  }
}

// Forgetting which Workspace was at an address, and nothing else. A step of
// its own on purpose: never part of removing a workspace, it connects to
// nothing, and it clears nothing. What it says has to be exactly what it
// does -- the stored data stays, and the next workspace to answer there may
// read it.
async function forgetAddress(known) {
  const sure = window.confirm(
    `Forget which workspace was at ${known.url}?\n\n` +
      `This iPhone will stop remembering that workspace ${known.workspaceId} was there, so the next workspace ` +
      'that answers at this address will be opened.\n\n' +
      'What is stored for this address stays. Drafts, reading places and signed-in state are still there, and a ' +
      'workspace opened here afterwards may read them. This does not delete them, and does not connect to anything.\n\n' +
      'To keep a workspace apart from them, give it an address of its own instead.',
  );
  if (!sure) return;
  busy(true);
  try {
    drawSaved(await invoke('forget_address', { url: known.url }));
    show(
      `This iPhone no longer remembers which workspace was at ${known.url}. What is stored for that address is still there.`,
    );
  } catch (error) {
    show(String(error), true);
  }
  busy(false);
}

async function renameProfile(profile) {
  const name = window.prompt(`What should this iPhone call ${profile.url}?`, profile.name);
  if (name === null) return;
  busy(true);
  try {
    drawSaved(await invoke('rename_core', { profile: profile.id, name }));
    if (editing?.id === profile.id) edit({ ...profile, name: name.trim() });
    show('Renamed. That is the name on this iPhone; the workspace itself is unchanged.');
  } catch (error) {
    show(String(error), true);
  }
  busy(false);
}

async function removeProfile(profile) {
  // What removing does, and what it does not, before it is done.
  const sure = window.confirm(
    `Remove “${profile.name}” from this iPhone?\n\n` +
      'This takes it off the list here. It changes nothing on the workspace, and nothing it is doing stops.\n\n' +
      'What is stored for its address is not cleared, and this iPhone goes on remembering which workspace was there, so a different one is not opened onto it. That is listed separately and can be forgotten on its own.',
  );
  if (!sure) return;
  busy(true);
  try {
    drawSaved(await invoke('remove_core', { profile: profile.id }));
    if (editing?.id === profile.id) edit(null);
    show(`“${profile.name}” is no longer saved on this iPhone.`);
  } catch (error) {
    show(String(error), true);
  }
  busy(false);
}

// The app checks the address and that a Yuzuno Workspace answers there,
// saves it under its name, then the page opens it. A failure keeps the
// address to correct or retry. A Workspace that answered but could not be
// saved is said to be so: Connect tries again, or it opens without saving.
// A saved Workspace that answers as a different one opens nothing until
// that is answered.
async function connect() {
  if (button.disabled) return;
  busy(true);
  offerUnsaved(null);
  askAboutIdentity(null);
  show(editing ? `Opening ${editing.name}…` : 'Finding your workspace…');
  try {
    const result = await invoke('connect_core', {
      url: address.value,
      profile: editing?.id ?? null,
      name: nameField.value || null,
    });
    // Anything the app did not open stops here. Keyed on 'changed' alone, a
    // refusal it did not recognise fell through to the navigation below --
    // so the test is what the app said it did, not which reason it gave.
    if (result.opened === false) {
      if (result.identity === 'changed') {
        show('This is not the workspace saved under that name.', true);
        askAboutIdentity(result);
      } else if (result.identity === 'unverified') {
        show(
          `${result.profileName} did not say which workspace it is, so this iPhone could not check it is the one ` +
            'saved at that address. Nothing was opened and nothing saved here has changed.',
          true,
        );
      } else if (result.identity === 'unkeepable') {
        show(
          `${result.profileName} named a workspace identifier longer than this iPhone keeps, so nothing was ` +
            'opened and nothing was written. What is saved is as it was.',
          true,
        );
      } else {
        show('This iPhone did not open that workspace, and nothing saved here has changed.', true);
      }
      busy(false);
      return;
    }
    if (result.saved) {
      show('Found it. Opening your workspace…');
      window.location.replace(result.url);
      return;
    }
    show(
      `Your workspace answered, but this iPhone could not save its address (${result.saveError}). Connect to try saving again, or open it without saving: next time you would enter the address again.`,
      true,
    );
    offerUnsaved(result.url);
    busy(false);
  } catch (error) {
    show(String(error), true);
    busy(false);
    address.focus();
  }
}

identityCancel.addEventListener('click', () => {
  askAboutIdentity(null);
  show('Left closed. Its address is still saved, under the same name.');
});

unsaved.addEventListener('click', () => {
  if (!answered || unsaved.disabled) return;
  show('Opening your workspace without saving its address…');
  window.location.replace(answered);
});

// Another address is not the Workspace that answered, nor the saved one this
// form was about.
address.addEventListener('input', () => {
  offerUnsaved(null);
  askAboutIdentity(null);
  // The saved address as the app writes it ends in "/", and what is typed
  // may not: a difference of only that is the same address, and dropping the
  // profile over it used to mean the app was asked about no profile at all.
  // The app looks the address up either way; this only keeps the form honest
  // about which Workspace it is about.
  if (editing && !sameAddress(address.value, editing.url)) {
    const was = editing;
    editing = null;
    about.hidden = true;
    label(false);
    show(`That is no longer ${was.name}’s address: connecting saves it as another workspace.`);
  }
});

form.addEventListener('submit', (event) => {
  event.preventDefault();
  connect();
});

// The saved Workspaces are listed, none opened: one tap opens one, and its
// address can still be changed first. A record that cannot be read is said
// to be so, not taken for a first launch.
async function start() {
  if (!invoke) {
    busy(true);
    show('This page runs inside the Yuzuno app.', true);
    return;
  }
  const saved = await invoke('saved_cores').catch((error) => ({ state: 'unreadable', reason: String(error), profiles: [] }));
  drawSaved(saved);
  if (saved?.state === 'saved') {
    const selected = saved.profiles.find((profile) => profile.id === saved.selected);
    if (selected) edit(selected);
    show(
      saved.profiles.length > 1
        ? 'Choose a workspace to open, or add another below.'
        : 'Your last workspace. Open it, or add another below.',
    );
  } else if (saved?.state === 'never') {
    show('Enter your workspace address to begin.');
  } else {
    // Not "enter it again and it will be saved": connecting is refused while
    // this is so, and nothing is written over what is saved.
    show(
      `The workspaces saved on this iPhone could not be used (${saved?.reason ?? 'unknown'}). What is saved has not been changed. Until they can be read, this app will not open a workspace, because it could not tell which one answered.`,
      true,
    );
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
