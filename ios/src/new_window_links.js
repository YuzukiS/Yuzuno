// The window's script for links that ask for a new window (T-170). On iOS
// Tauri opens no new window (`on_new_window` is not supported there), so a
// tap on such a link did nothing. A tap on an `a target="_blank"` link of a
// Core page now becomes a `yuzuno-open:` navigation of this window instead,
// carrying the link's absolute URL as `encodeURIComponent` makes it. The app
// always cancels that navigation, and opens the link in Safari or Mail only
// if it is a web page or mail link (core_url.rs `destination`). This script
// calls nothing of the app's, and its checks only spare stray taps: the
// app's own check decides what opens. Tauri runs it in the main frame only,
// at the start of each page the window loads.
(() => {
  // The Core's pages only: this app's own page has no such link.
  if (location.protocol !== 'https:') return;
  const outside = new Set(['http:', 'https:', 'mailto:']);
  // On the document, after the page's own handlers: one may set a link's
  // target as it is clicked, and a click the page handled stays its own.
  document.addEventListener('click', (event) => {
    if (event.defaultPrevented || event.button !== 0) return;
    const link = event.target instanceof Element ? event.target.closest('a[href]') : null;
    if (!link || (link.getAttribute('target') || '').toLowerCase() !== '_blank') return;
    let url;
    try {
      url = new URL(link.getAttribute('href'), document.baseURI);
    } catch {
      return;
    }
    if (!outside.has(url.protocol)) return;
    event.preventDefault();
    const request = 'yuzuno-open:' + encodeURIComponent(url.href);
    window.location.href = request;
  });
})();
