// This app's version, for the pages its window opens (T-191). Before the
// window opens, the app puts in the version it was built as: its package
// version, which `tauri ios build` also writes into the bundle as
// CFBundleShortVersionString (app_version.rs). A page reads it as a value,
// as Settings → Runtime does. The script calls nothing of the app's and
// grants nothing: a Core's pages still reach no command of this app, and
// an older app, which has no such script, gives them no version at all.
// Tauri runs it in the main frame only, at the start of each page the
// window loads.
(() => {
  const version = "__YUZUNO_APP_VERSION__";
  Object.defineProperty(window, '__YUZUNO_IPHONE_APP__', {
    value: Object.freeze({ version }),
    enumerable: false,
    configurable: false,
    writable: false,
  });
})();
