// The embedded connection page (YN-111; YN-107 design section 5). Three
// actions: start this computer's Core, install Core on this computer, and
// connect to another Core. Everything it does goes through the app's own
// commands; it starts, installs and opens nothing by itself, apart from one
// start of this computer's confirmed Core when the app opens (below).
const $ = (selector) => document.querySelector(selector);
const form = $('#connection-form');
const address = $('#core-url');
const button = $('#connect-button');
const message = $('#connection-message');
const startCard = $('#act-start');
const startButton = $('#start-button');
const startBody = $('#start-body');
const startMessage = $('#start-message');
const autoStartRow = $('#auto-start-row');
const autoStartBox = $('#auto-start');
const autoStartMessage = $('#auto-start-message');
const installCard = $('#act-install');
const installButton = $('#install-button');
const installBody = $('#install-body');
const panel = $('#local-panel');
const distro = $('#distro');
const checkMessage = $('#check-message');
const go = $('#go');
const savedSection = $('#saved-cores');
const savedList = $('#saved-list');
const rememberedSection = $('#remembered');
const rememberedList = $('#remembered-list');
const invoke = window.__TAURI__?.core?.invoke;
const Channel = window.__TAURI__?.core?.Channel;

// ---- Language -------------------------------------------------------------
// The system's language until someone picks one here; the choice is kept by
// this page only.
const WORDS = window.YUZUNO_I18N ?? { zh: {}, en: {} };
const LANG_KEY = 'yuzuno.connection.lang';
const GUIDE_KEY = 'yuzuno.connection.guideDismissed';

function stored(key) {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function store(key, value) {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // A page that cannot keep it asks again next time.
  }
}

let lang = ['zh', 'en'].includes(stored(LANG_KEY))
  ? stored(LANG_KEY)
  : /^zh\b/i.test(navigator.language || '') ? 'zh' : 'en';

function t(key, values = {}) {
  const text = WORDS[lang]?.[key] ?? WORDS.en?.[key] ?? key;
  return text.replace(/\{(\w+)\}/g, (whole, name) => (name in values ? String(values[name]) : whole));
}

// The platform's own wording first (`check.arch.wsl`), then the shared one.
function platformText(key, platform) {
  const own = `${key}.${platform}`;
  return WORDS[lang]?.[own] !== undefined || WORDS.en?.[own] !== undefined ? t(own) : WORDS.en?.[key] !== undefined ? t(key) : null;
}

function applyStatic() {
  document.documentElement.lang = lang === 'zh' ? 'zh-CN' : 'en';
  document.title = t('pageTitle');
  for (const element of document.querySelectorAll('[data-t]')) {
    if ('html' in element.dataset) element.innerHTML = t(element.dataset.t);
    else element.textContent = t(element.dataset.t);
  }
  for (const element of document.querySelectorAll('[data-t-label]')) {
    element.setAttribute('aria-label', t(element.dataset.tLabel));
    if (element.hasAttribute('title')) element.title = t(element.dataset.tLabel);
  }
  for (const choice of document.querySelectorAll('[data-lang]')) choice.setAttribute('aria-pressed', String(choice.dataset.lang === lang));
}

// A message is kept as what it says, so a change of language redraws it.
// What a command answered stays in its own words: in English it follows the
// page's own sentence, and under a Chinese one it is under Details.
const said = new Map();

function say(element, spec) {
  if (spec) said.set(element, spec);
  else said.delete(element);
  drawMessage(element);
}

function drawMessage(element) {
  const spec = said.get(element);
  element.replaceChildren();
  element.dataset.error = String(Boolean(spec?.error));
  if (!spec) return;
  if (spec.key) element.append(t(spec.key, spec.values));
  if (spec.original !== undefined && lang === 'en') {
    element.append(spec.key ? ` ${spec.original}` : spec.original);
  } else if (spec.original !== undefined) {
    const details = document.createElement('details');
    const summary = document.createElement('summary');
    summary.textContent = t('details');
    const words = document.createElement('code');
    words.textContent = spec.original;
    details.append(summary, words);
    element.append(details);
  }
}

// Errors from the local Core commands are `{ code, message }`; the older
// commands answer with their message alone.
function words(error) {
  if (typeof error === 'string') return error;
  if (error && typeof error.message === 'string') return error.message;
  return String(error);
}

// ---- What this page knows -------------------------------------------------
const page = {
  info: null,
  // Where this computer can install or start Core (`local_core_targets`).
  targets: null,
  // The saved Core this app may start ({ coreUrl, where, platform,
  // confirmed }), as connection_info names it for the shown address. An
  // unconfirmed one only has the Core's own word for where it is installed,
  // and an address on this computer may be a tunnel to another one; the
  // user's start decides.
  startable: null,
  autoStart: true,
  // The last connection found nothing answering.
  unreachable: false,
  // What is under way: 'connect', 'start', 'list', 'check' or 'install'.
  busy: null,
};

// The local panel: finding (mode 'find', in the start action) or installing
// (mode 'install', in the install action) in one of the listed targets.
const local = {
  mode: null,
  targets: [],
  target: null,
  check: null,
  notFound: false,
  editing: false,
  view: 'check',
  progress: null,
  problem: null,
  cancelling: false,
  values: null,
};

const PHASES = ['release', 'download', 'verify', 'copy', 'register', 'start', 'open'];
// Cancelling stops an install only until it is copied in (shared table).
const CANCELLABLE = 4;

// Only a start this app can run here is offered: connection_info names its
// platform, and none where this app cannot start it.
function offerFrom(info) {
  const platform = info.startPlatform ?? null;
  page.startable = platform
    ? { coreUrl: info.coreUrl, distro: info.startDistro ?? '', platform, confirmed: Boolean(info.startConfirmed) }
    : null;
  page.autoStart = info.autoStartLocalCore !== false;
}

function startWhere(start) {
  return start.platform === 'macos' ? t('thisMac') : start.distro;
}

function portOf(url) {
  try {
    const parsed = new URL(url);
    return parsed.port || (parsed.protocol === 'https:' ? '443' : '80');
  } catch {
    return '';
  }
}

// Hidden where this app can neither install nor start a Core: the Mac until
// YN-108 connects its own, and any other system. A target list that could
// not be read hides nothing; asking again says why.
function localOffered() {
  const targets = page.targets;
  return !(targets && targets.available === false && ['comingSoon', 'unsupported'].includes(targets.reason));
}

function nothingSaved() {
  const info = page.info;
  return Boolean(info) && !info.savedError && !(info.saved ?? []).length && !(info.remembered ?? []).length;
}

// ---- Drawing --------------------------------------------------------------
function drawIntro() {
  const intro = $('#intro');
  // "Start it" only where there is a start to offer.
  if (page.unreachable && (page.info?.saved ?? []).length)
    intro.textContent = t(page.startable && localOffered() ? 'introSaved' : 'introSavedOther');
  else if (localOffered() && page.targets?.platform === 'wsl') intro.textContent = t('introLocal');
  else intro.innerHTML = t('intro');
}

function drawGuide() {
  $('#guide').hidden = !(nothingSaved() && page.unreachable && localOffered() && page.targets && stored(GUIDE_KEY) !== 'yes');
}

function drawStart() {
  const offered = localOffered();
  startCard.hidden = !offered;
  installCard.hidden = !offered;
  const start = page.startable;
  $('#start-badge').hidden = !start?.confirmed;
  const desc = $('#start-desc');
  if (!start) desc.textContent = t('startDescNone');
  else if (start.confirmed) desc.textContent = t('startDescSaved', { where: startWhere(start), port: portOf(start.coreUrl) });
  else desc.textContent = t('startUnconfirmed', { where: startWhere(start) });
  startButton.textContent = start ? t('startGo') : t('startFind');
  startButton.className = start?.confirmed ? '' : 'secondary';
  // The switch is shown only where it can act: a confirmed start.
  autoStartRow.hidden = !start?.confirmed;
  autoStartBox.checked = page.autoStart;
  const panelHere = local.mode === 'find';
  startButton.hidden = panelHere;
  startBody.hidden = !(panelHere || said.has(startMessage));
  startCard.dataset.open = String(!startBody.hidden);
  installButton.hidden = local.mode === 'install';
  installBody.hidden = local.mode !== 'install';
  installCard.dataset.open = String(local.mode === 'install');
}

function drawBusy() {
  const busy = Boolean(page.busy);
  button.disabled = busy;
  address.disabled = busy;
  startButton.disabled = busy;
  installButton.disabled = busy;
  autoStartBox.disabled = busy;
  distro.disabled = busy;
  $('#recheck').disabled = busy || !local.target;
  $('#change').disabled = busy;
  $('#panel-close').disabled = busy;
}

function abbreviated(path, home) {
  if (home && path === home) return '~';
  if (home && path.startsWith(`${home}/`)) return `~/${path.slice(home.length + 1)}`;
  return path;
}

function expanded(path, home) {
  const trimmed = path.trim();
  if (trimmed === '~') return home;
  if (trimmed.startsWith('~/')) return `${home}/${trimmed.slice(2)}`;
  return trimmed;
}

function targetLabel(id) {
  return local.targets.find((target) => target.id === id)?.label ?? id;
}

function checkItem(item, platform) {
  const row = document.createElement('div');
  row.className = 'check';
  row.dataset.id = item.id;
  const state = item.state === 'ok' ? 'ok' : item.state === 'unknown' ? 'unknown' : item.level === 'required' ? 'bad' : 'missing';
  row.dataset.state = state;
  const mark = document.createElement('i');
  mark.setAttribute('aria-hidden', 'true');
  mark.textContent = state === 'ok' ? '✓' : state === 'bad' ? '!' : state === 'unknown' ? '?' : '–';
  const text = document.createElement('span');
  // An id this page does not know shows what the check said.
  const label = platformText(`check.${item.id}`, platform);
  text.append(label ?? item.detail ?? item.id);
  if (label && item.detail) text.append(Object.assign(document.createElement('small'), { textContent: item.detail }));
  const fix = item.state !== 'ok' ? platformText(`fix.${item.id}`, platform) : null;
  if (fix) text.append(Object.assign(document.createElement('small'), { textContent: fix }));
  row.append(mark, text);
  return row;
}

function drawChecks(check) {
  const list = $('#checks');
  list.replaceChildren();
  for (const level of ['required', 'recommended']) {
    const items = check.checks.filter((item) => item.level === level);
    if (!items.length) continue;
    list.append(Object.assign(document.createElement('h3'), { textContent: t(level) }));
    for (const item of items) list.append(checkItem(item, check.platform));
  }
}

// The location to install to: the check's defaults until someone changes it.
function placement() {
  const check = local.check;
  if (!local.editing) return { ...check.defaults, valid: true };
  const home = check.home;
  const installDir = expanded($('#edit-install').value, home);
  const dataDir = expanded($('#edit-data').value, home);
  const portText = $('#edit-port').value.trim();
  const port = /^\d+$/.test(portText) ? Number(portText) : NaN;
  if (!(port >= 1024 && port <= 65535)) return { installDir, dataDir, port, valid: false, why: 'badPort' };
  const plain = (path) => path.startsWith('/') && !(check.platform === 'wsl' && /\s/.test(path));
  const within = (inner, outer) => inner === outer || inner.startsWith(`${outer.replace(/\/+$/, '')}/`);
  if (!plain(installDir) || !plain(dataDir) || within(installDir, dataDir) || within(dataDir, installDir))
    return { installDir, dataDir, port, valid: false, why: 'badPath' };
  return { installDir, dataDir, port, valid: true };
}

function drawCheckPane() {
  const check = local.check;
  const installing = local.mode === 'install';
  $('#distro-label').textContent = t(installing ? 'distroLabel' : 'distroLabelFind');
  const notFound = $('#not-found');
  notFound.hidden = !(installing && local.notFound && check && !check.installation);
  notFound.textContent = t('notFound', { distro: targetLabel(local.target) });
  $('#checks').hidden = !(installing && check);
  if (check) drawChecks(check);
  const installation = check?.installation;
  $('#found').hidden = !installation;
  if (installation) {
    $('#found-title').textContent = t('foundTitle', { distro: targetLabel(check.target) });
    $('#found-body').textContent = installation.recorded
      ? t('foundRecorded', { release: installation.releaseId, port: installation.port, workspace: installation.workspaceId })
      : t('foundUnrecorded', { release: installation.releaseId });
  }
  const placing = installing && check && !installation;
  // The paths check names a workspace already in the data folder; it is
  // opened as it is (check_rules.rs, `paths`).
  const paths = check?.checks.find((item) => item.id === 'paths');
  $('#existing-data').hidden = !(placing && !local.editing && paths?.state === 'ok' && paths.detail);
  $('#where').hidden = !(placing && !local.editing);
  $('#where-edit').hidden = !(placing && local.editing);
  if (placing) {
    $('#where-install').textContent = abbreviated(check.defaults.installDir, check.home);
    $('#where-data').textContent = abbreviated(check.defaults.dataDir, check.home);
    $('#where-port').textContent = String(check.defaults.port);
  }
  const change = $('#change');
  change.hidden = !(placing && check.installable);
  change.textContent = t(local.editing ? 'useDefaults' : 'change');
  let ready = false;
  if (installation) {
    go.hidden = false;
    go.textContent = t('startIt');
    ready = true;
  } else if (placing) {
    go.hidden = false;
    go.textContent = t('installGo');
    const where = placement();
    const error = $('#where-error');
    error.hidden = !local.editing || where.valid;
    error.textContent = where.valid ? '' : t(where.why);
    ready = check.installable && where.valid && localInstallable();
  } else {
    go.hidden = true;
  }
  go.disabled = Boolean(page.busy) || !ready;
}

// Shared table, part 2: available, a selectable target, and installable.
function localInstallable() {
  const target = local.targets.find((listed) => listed.id === local.target);
  return Boolean(page.targets?.available && target?.selectable && local.check?.installable);
}

function stepLabel(phase) {
  return t(`phase.${phase}`, { distro: targetLabel(local.target) });
}

function megabytes(bytes) {
  return (bytes / 1e6).toFixed(1);
}

function drawProgressPane() {
  const progress = local.progress;
  const problem = local.problem;
  const reached = progress.phase ? PHASES.indexOf(progress.phase) : -1;
  const steps = $('#steps');
  steps.replaceChildren();
  PHASES.forEach((phase, index) => {
    const item = document.createElement('li');
    let state = index < reached ? 'done' : index === reached ? 'doing' : 'todo';
    if (problem && index === reached) state = 'failed';
    if (progress.finished) state = 'done';
    item.dataset.state = state;
    item.dataset.phase = phase;
    const mark = document.createElement('i');
    mark.setAttribute('aria-hidden', 'true');
    mark.textContent = state === 'done' ? '✓' : state === 'failed' ? '!' : '';
    const text = document.createElement('span');
    text.append(stepLabel(phase));
    const detail = progress.details[phase];
    if (phase === 'download' && progress.total > 0 && index <= reached) {
      text.append(Object.assign(document.createElement('span'), {
        className: 'step-detail',
        textContent: t('downloaded', { done: megabytes(progress.done), total: megabytes(progress.total) }),
      }));
      if (state === 'doing') {
        const bar = document.createElement('div');
        bar.className = 'bar';
        const fill = document.createElement('span');
        fill.style.width = `${Math.min(100, Math.round((progress.done / progress.total) * 100))}%`;
        bar.append(fill);
        text.append(bar);
      }
    } else if (detail) {
      text.append(Object.assign(document.createElement('span'), { className: 'step-detail', textContent: detail }));
    }
    item.append(mark, text);
    steps.append(item);
  });
  $('#problem').hidden = !problem;
  if (problem) {
    const phase = problem.phase ?? 'none';
    $('#problem-title').textContent = t(problem.cancelled ? 'cancelledTitle' : 'failTitle');
    $('#problem-body').textContent = t(`fail.${phase}`, { distro: targetLabel(local.target) });
    $('#problem-cleaned').textContent = t(`cleaned.${phase}`);
    $('#problem-detail').textContent = problem.code ? `${problem.code}: ${problem.message}` : problem.message;
  }
  const cancel = $('#progress-cancel');
  const hint = $('#progress-hint');
  const running = !problem && !progress.finished;
  const cancellable = reached < CANCELLABLE;
  cancel.hidden = !running;
  cancel.disabled = !cancellable || local.cancelling;
  cancel.textContent = t(local.cancelling ? 'cancelling' : cancellable ? 'cancelInstall' : 'registering');
  hint.hidden = !(running && cancellable);
  hint.textContent = t('progressHint');
  $('#retry').hidden = !problem;
  $('#progress-close').hidden = !problem;
}

function drawPanel() {
  panel.hidden = !local.mode;
  if (!local.mode) return;
  const home = local.mode === 'find' ? startBody : installBody;
  if (panel.parentElement !== home) home.append(panel);
  $('#pane-check').hidden = local.view !== 'check';
  $('#pane-progress').hidden = local.view !== 'progress';
  for (const option of distro.options) {
    const target = local.targets.find((listed) => listed.id === option.value);
    if (target) option.textContent = optionText(target);
  }
  if (local.view === 'check') drawCheckPane();
  else drawProgressPane();
}

function drawAll() {
  applyStatic();
  drawIntro();
  drawGuide();
  drawStart();
  drawPanel();
  drawBusy();
  if (page.info) drawSaved(page.info);
  for (const element of said.keys()) drawMessage(element);
}

function setBusy(kind) {
  page.busy = kind;
  drawBusy();
  if (local.mode) drawPanel();
}

// ---- Saved workspaces (T-195) ---------------------------------------------
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
        textContent: entry.workspaceId ? t('workspaceId', { id: entry.workspaceId }) : t('notOpenedYet'),
      }),
    );
    // Only one entry may start a Core, and only where this app can start
    // one: the app says which.
    if (entry.startable) {
      open.append(
        Object.assign(document.createElement('span'), {
          className: 'saved-start',
          textContent: t(page.startable?.platform === 'macos' ? 'canStartMac' : 'canStart'),
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
    rename.textContent = t('rename');
    rename.setAttribute('aria-label', t('renameLabel', { name: entry.name }));
    rename.addEventListener('click', () => void renameEntry(entry));
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'saved-remove secondary';
    remove.textContent = t('remove');
    remove.setAttribute('aria-label', t('removeLabel', { name: entry.name }));
    remove.addEventListener('click', () => void removeEntry(entry));
    item.append(open, rename, remove);
    savedList.append(item);
  }
  drawRemembered(info);
}

// Addresses with no entry whose Workspace this computer still remembers.
// They are shown because they are the reason a connection there can be
// refused: a refusal whose cause is invisible looks like a fault. A list
// that could not be read says nothing about them either.
function drawRemembered(info) {
  const addresses = info.savedError ? [] : info.remembered ?? [];
  rememberedSection.hidden = addresses.length === 0;
  rememberedList.replaceChildren();
  for (const known of addresses) {
    const item = document.createElement('li');
    item.append(Object.assign(document.createElement('span'), { className: 'saved-url', textContent: known.url }));
    item.append(
      Object.assign(document.createElement('span'), {
        className: 'saved-workspace',
        textContent: t('workspaceWasHere', { id: known.workspaceId }),
      }),
    );
    const forget = document.createElement('button');
    forget.type = 'button';
    forget.className = 'saved-forget secondary';
    forget.textContent = t('forget');
    forget.setAttribute('aria-label', t('forgetLabel', { url: known.url }));
    forget.addEventListener('click', () => void forgetAddress(known));
    item.append(forget);
    rememberedList.append(item);
  }
}

function listChanged(info) {
  page.info = { ...page.info, ...info };
  drawSaved(page.info);
  drawGuide();
}

// Forgetting which Workspace was at an address, and nothing else. This is
// deliberately a step of its own: it is never done as part of removing a
// workspace, it connects to nothing, and it clears nothing. What it says
// has to be exactly what it does -- the stored data stays, and the next
// workspace to answer there may read it.
async function forgetAddress(known) {
  if (!window.confirm(t('forgetConfirm', { url: known.url, id: known.workspaceId }))) return;
  try {
    listChanged(await invoke('forget_address', { url: known.url }));
    say(message, { key: 'forgot', values: { url: known.url } });
  } catch (error) {
    say(message, { key: 'notChanged', original: words(error), error: true });
  }
}

async function renameEntry(entry) {
  const name = window.prompt(t('renamePrompt', { url: entry.url }), entry.name);
  if (name === null) return;
  try {
    listChanged(await invoke('rename_core', { entry: entry.id, name }));
    say(message, { key: 'renamed' });
  } catch (error) {
    say(message, { key: 'notChanged', original: words(error), error: true });
  }
}

async function removeEntry(entry) {
  // What removing does, and what it does not, before it is done.
  if (!window.confirm(t('removeConfirm', { name: entry.name }))) return;
  try {
    listChanged(await invoke('remove_core', { entry: entry.id }));
    say(message, { key: 'removed', values: { name: entry.name } });
  } catch (error) {
    say(message, { key: 'notChanged', original: words(error), error: true });
  }
}

// ---- Connect ----------------------------------------------------------------
// Whether nothing answered at all, as the app says it (main.rs, open_core):
// only then may this computer's own Core be started by itself.
const NOT_REACHABLE = /^Core is not reachable/;

// Answers 'opened', 'unreachable' or 'failed'.
async function connect() {
  if (page.busy) return 'failed';
  setBusy('connect');
  say(message, { key: 'finding' });
  try {
    const target = await invoke('connect_core', { url: address.value });
    say(message, { key: 'found' });
    window.location.replace(target);
    return 'opened';
  } catch (error) {
    const text = words(error);
    page.unreachable = true;
    say(message, { key: 'connectFailed', original: text, error: true });
    $('#connect-label').dataset.t = 'tryAgain';
    $('#connect-label').textContent = t('tryAgain');
    return NOT_REACHABLE.test(text) ? 'unreachable' : 'failed';
  } finally {
    setBusy(null);
    drawIntro();
    drawGuide();
  }
}

// ---- Start the saved Core ---------------------------------------------------
// Starts the saved Core at its own address -- never at what is typed in the
// address box -- through start_core, which starts it only if nothing answers
// there and opens it only once it answers with its own Workspace.
async function startSaved(automatic) {
  const start = page.startable;
  if (page.busy || !start) return;
  setBusy('start');
  const key = automatic ? 'autoStarting' : start.platform === 'macos' ? 'startingMac' : 'startingWsl';
  say(startMessage, { key, values: { where: startWhere(start) } });
  drawStart();
  try {
    const target = await invoke('start_core', { url: start.coreUrl });
    say(startMessage, { key: 'started' });
    window.location.replace(target);
  } catch (error) {
    say(startMessage, { key: 'startFailed', original: words(error), error: true });
    // What the attempt changed: an unconfirmed start that this computer
    // refused is no longer offered. Nothing is tried again by itself.
    try {
      offerFrom(await invoke('connection_info'));
    } catch {
      // Keep the page as it is.
    }
  } finally {
    setBusy(null);
    drawStart();
  }
}

async function setAutoStart() {
  const wanted = autoStartBox.checked;
  autoStartBox.disabled = true;
  try {
    const answer = await invoke('local_core_auto_start', { enabled: wanted });
    page.autoStart = answer?.enabled !== false;
    say(autoStartMessage, null);
  } catch (error) {
    say(autoStartMessage, { key: 'autoStartFailed', original: words(error), error: true });
  } finally {
    autoStartBox.checked = page.autoStart;
    autoStartBox.disabled = Boolean(page.busy);
  }
}

// ---- Find or install in a distribution --------------------------------------
function optionText(target) {
  let text = target.label;
  if (target.isDefault) text += t('distroDefault');
  if (target.note) text += ` · ${target.note}`;
  return text;
}

function closePanel() {
  if (page.busy) return;
  Object.assign(local, { mode: null, check: null, notFound: false, editing: false, view: 'check', progress: null, problem: null });
  say(checkMessage, null);
  panel.hidden = true;
  drawStart();
}

async function openPanel(mode) {
  if (page.busy) return;
  Object.assign(local, { mode, targets: [], target: null, check: null, notFound: false, editing: false, view: 'check', progress: null, problem: null });
  say(startMessage, null);
  distro.replaceChildren();
  drawStart();
  drawPanel();
  setBusy('list');
  say(checkMessage, { key: 'listing' });
  let targets;
  try {
    targets = await invoke('local_core_targets');
  } catch (error) {
    say(checkMessage, { key: 'listFailed', original: words(error), error: true });
    return;
  } finally {
    setBusy(null);
  }
  if (!targets || typeof targets !== 'object') {
    say(checkMessage, { key: 'listFailed', original: String(targets), error: true });
    return;
  }
  page.targets = targets;
  local.targets = targets.targets ?? [];
  if (!localOffered()) {
    closePanel();
    drawAll();
    return;
  }
  drawIntro();
  if (!targets.available) {
    if (targets.reason === 'noWsl') say(checkMessage, { key: 'noWsl', error: true });
    else say(checkMessage, { key: 'wslError', original: targets.message ?? targets.reason ?? '', error: true });
    drawPanel();
    return;
  }
  for (const target of local.targets) {
    const option = document.createElement('option');
    option.value = target.id;
    option.textContent = optionText(target);
    option.disabled = !target.selectable;
    distro.append(option);
  }
  const chosen = local.targets.find((target) => target.selectable && target.isDefault) ?? local.targets.find((target) => target.selectable);
  if (!chosen) {
    distro.value = '';
    say(checkMessage, { key: 'noneSelectable', error: true });
    drawPanel();
    return;
  }
  distro.value = chosen.id;
  await runCheck();
}

async function runCheck() {
  const target = distro.value;
  if (page.busy || !target) return;
  Object.assign(local, { target, check: null, editing: false, view: 'check', problem: null });
  setBusy('check');
  say(checkMessage, { key: 'checking', values: { distro: targetLabel(target) } });
  try {
    const check = await invoke('local_core_check', { target });
    local.check = check;
    say(checkMessage, null);
    // Nothing to start here: installing is what is left (design 2).
    if (local.mode === 'find' && !check.installation) {
      local.mode = 'install';
      local.notFound = true;
      drawStart();
    }
  } catch (error) {
    say(checkMessage, { key: 'checkFailed', original: words(error), error: true });
  } finally {
    setBusy(null);
    drawPanel();
  }
}

function toggleLocation() {
  const check = local.check;
  if (!check) return;
  local.editing = !local.editing;
  if (local.editing) {
    $('#edit-install').value = abbreviated(check.defaults.installDir, check.home);
    $('#edit-data').value = abbreviated(check.defaults.dataDir, check.home);
    $('#edit-port').value = String(check.defaults.port);
  }
  drawPanel();
}

async function startFound() {
  const check = local.check;
  if (page.busy || !check?.installation) return;
  setBusy('start');
  say(checkMessage, { key: 'startingIn', values: { distro: targetLabel(check.target) } });
  try {
    const target = await invoke('local_core_start', { target: check.target });
    say(checkMessage, { key: 'started' });
    window.location.replace(target);
  } catch (error) {
    say(checkMessage, { key: 'startFailed', original: words(error), error: true });
  } finally {
    setBusy(null);
  }
}

async function install(values) {
  if (page.busy) return;
  local.values = values;
  local.view = 'progress';
  local.problem = null;
  local.cancelling = false;
  local.progress = { phase: null, done: 0, total: 0, details: {}, finished: false };
  if (!Channel) {
    local.problem = { phase: null, code: 'noChannel', message: 'This app cannot send install progress to this page.', cancelled: false };
    drawPanel();
    return;
  }
  const channel = new Channel();
  channel.onmessage = (progress) => {
    if (!progress || !PHASES.includes(progress.phase) || local.problem) return;
    const now = PHASES.indexOf(progress.phase);
    const before = local.progress.phase ? PHASES.indexOf(local.progress.phase) : -1;
    // Steps only go forward.
    if (now < before) return;
    local.progress.phase = progress.phase;
    if (progress.phase === 'download' && typeof progress.done === 'number') {
      local.progress.done = progress.done;
      if (typeof progress.total === 'number') local.progress.total = progress.total;
    }
    if (typeof progress.detail === 'string') local.progress.details[progress.phase] = progress.detail;
    drawPanel();
  };
  setBusy('install');
  try {
    const target = await invoke('local_core_install', {
      target: local.target,
      installDir: values.installDir,
      dataDir: values.dataDir,
      port: values.port,
      onProgress: channel,
    });
    local.progress.finished = true;
    drawPanel();
    window.location.replace(target);
  } catch (error) {
    const code = typeof error?.code === 'string' ? error.code : null;
    local.problem = { phase: local.progress.phase, code, message: words(error), cancelled: code === 'cancelled' };
  } finally {
    local.cancelling = false;
    setBusy(null);
  }
}

async function cancelInstall() {
  const reached = local.progress?.phase ? PHASES.indexOf(local.progress.phase) : -1;
  if (page.busy !== 'install' || reached >= CANCELLABLE || local.cancelling) return;
  local.cancelling = true;
  drawPanel();
  try {
    await invoke('local_core_cancel');
  } catch {
    // The install goes on, and answers for itself.
    local.cancelling = false;
    drawPanel();
  }
}

// Before anything is registered, trying again installs again; from then on
// the installation may be there, so it is checked again first.
async function retry() {
  const problem = local.problem;
  if (!problem || page.busy) return;
  const phase = problem.phase ? PHASES.indexOf(problem.phase) : -1;
  if (phase >= 0 && phase < CANCELLABLE && local.values) return install(local.values);
  local.view = 'check';
  local.problem = null;
  await runCheck();
}

function onGo() {
  if (local.check?.installation) return void startFound();
  const where = placement();
  if (!where.valid || !localInstallable()) return;
  void install({ installDir: where.installDir, dataDir: where.dataDir, port: where.port });
}

// ---- Events -------------------------------------------------------------------
form.addEventListener('submit', (event) => {
  event.preventDefault();
  if (invoke) void connect();
});
startButton.addEventListener('click', () => {
  if (!invoke) return;
  if (page.startable) void startSaved(false);
  else void openPanel('find');
});
installButton.addEventListener('click', () => {
  if (invoke) void openPanel('install');
});
autoStartBox.addEventListener('change', () => {
  if (invoke) void setAutoStart();
});
distro.addEventListener('change', () => void runCheck());
$('#recheck').addEventListener('click', () => void runCheck());
$('#change').addEventListener('click', toggleLocation);
for (const input of ['#edit-install', '#edit-data', '#edit-port']) $(input).addEventListener('input', drawPanel);
$('#panel-close').addEventListener('click', closePanel);
$('#progress-close').addEventListener('click', closePanel);
$('#progress-cancel').addEventListener('click', () => void cancelInstall());
$('#retry').addEventListener('click', () => void retry());
go.addEventListener('click', onGo);
$('#guide-dismiss').addEventListener('click', () => {
  store(GUIDE_KEY, 'yes');
  drawGuide();
});
for (const choice of document.querySelectorAll('[data-lang]')) {
  choice.addEventListener('click', () => {
    lang = choice.dataset.lang;
    store(LANG_KEY, lang);
    drawAll();
  });
}

// What this computer can do locally, asked once when the page opens so the
// Mac's page shows only Connect. Listing reads `wsl.exe --list` on Windows
// and starts nothing.
async function loadTargets() {
  let targets;
  try {
    targets = await invoke('local_core_targets');
  } catch {
    return;
  }
  if (!targets || typeof targets !== 'object') return;
  page.targets = targets;
  if (!local.mode) local.targets = page.targets.targets ?? [];
  drawIntro();
  drawGuide();
  drawStart();
}

async function init() {
  say(message, { key: 'gettingReady' });
  drawAll();
  if (!invoke) {
    say(message, { key: 'preview' });
    button.disabled = true;
    startButton.disabled = true;
    installButton.disabled = true;
    return;
  }
  // The embedded connection page has a fixed light palette. This never
  // changes the workspace's per-origin appearance preference.
  void invoke('set_appearance', { theme: 'light' }).catch(() => {});
  let info;
  try {
    info = await invoke('connection_info');
  } catch (error) {
    say(message, { key: 'settingsFailed', original: words(error), error: true });
    return;
  }
  page.info = info;
  address.value = info.coreUrl;
  offerFrom(info);
  drawSaved(info);
  drawStart();
  const targets = loadTargets();
  if (info.savedError) {
    // Not "enter it again and it will be saved": connecting is refused
    // while this is so, and nothing is written over what is saved.
    say(message, { key: 'savedUnusable', values: { reason: info.savedError }, error: true });
  } else if (info.error) {
    say(message, { key: 'launchError', original: info.error, error: true });
  } else if (info.autoConnect) {
    const answer = await connect();
    // When the app opens and the last Workspace is this computer's
    // confirmed Core that does not answer, start it: once, never for an
    // unconfirmed one, and not again if it fails (design 6, part 4).
    const start = page.startable;
    if (answer === 'unreachable' && page.autoStart && start?.confirmed && sameCore(address.value, start.coreUrl))
      await startSaved(true);
  } else {
    say(message, { key: 'chooseWorkspace' });
  }
  await targets;
}

function sameCore(value, coreUrl) {
  try {
    return new URL(value.trim()).origin === new URL(coreUrl).origin;
  } catch {
    return false;
  }
}

void init();

// Without a system frame (Windows), this page's top band moves the window and
// its own buttons minimize, maximize and close it. On macOS the system's own
// window buttons stand over this band (YN-90): the band moves the window, and
// a double click does what the user's system setting says. An older shell, or
// one that kept its own title bar, leaves the page as it is.
const frame = window.__TAURI__?.window?.getCurrentWindow?.();
const controls = document.querySelector('.window-controls');
const MOVE_BAND = 72;
const BAND_CONTROL = 'button, a, input, label, select, textarea, summary';
const DOUBLE_CLICKS = new Set(['zoom', 'minimize', 'none']);

// What the macOS shell reports ({ inset, doubleClick }); null for any other
// shell, a refusal, or an answer of another shape.
async function titleBar() {
  if (!invoke) return null;
  try {
    const bar = await invoke('desktop_title_bar');
    return bar && typeof bar.inset === 'number' && DOUBLE_CLICKS.has(bar.doubleClick) ? bar : null;
  } catch {
    return null;
  }
}

function inBand(event) {
  return event.button === 0 && event.clientY <= MOVE_BAND && !event.target.closest(BAND_CONTROL);
}

async function initFrame() {
  if (!frame) return;
  let decorated;
  try {
    decorated = await frame.isDecorated();
  } catch {
    return;
  }
  if (!decorated) {
    controls.hidden = false;
    controls.addEventListener('click', (event) => {
      const action = event.target.closest('[data-window]')?.dataset.window;
      if (action === 'minimize') void frame.minimize();
      else if (action === 'maximize') void frame.toggleMaximize();
      else if (action === 'close') void frame.close();
    });
    document.addEventListener('mousedown', (event) => {
      if (!inBand(event)) return;
      event.preventDefault();
      void (event.detail === 2 ? frame.toggleMaximize() : frame.startDragging());
    });
    return;
  }
  if (!(await titleBar())) return;
  // As the workspace toolbar: the second press of a double click acts when it
  // is released where it began, reading the setting again then.
  document.addEventListener('mousedown', (event) => {
    if (!inBand(event)) return;
    event.preventDefault();
    if (event.detail !== 2) return void frame.startDragging();
    const { clientX, clientY } = event;
    window.addEventListener('mouseup', async (up) => {
      if (up.detail !== 2 || up.clientX !== clientX || up.clientY !== clientY || !inBand(up)) return;
      const bar = await titleBar();
      if (bar?.doubleClick === 'zoom') void frame.toggleMaximize();
      else if (bar?.doubleClick === 'minimize') void frame.minimize();
    }, { once: true, capture: true });
  });
}

void initFrame();
