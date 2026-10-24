// The Simulator check's measuring probe (T-170), added only by serve.py to
// the page Mobile Safari opens; never part of the app. It shows, as text the
// UI test reads, the window, the layout and visual viewports and the safe
// area insets the page is given, in CSS pixels.
(() => {
  const gauge = document.createElement('div');
  gauge.style.cssText = 'position:fixed;inset:0;visibility:hidden;pointer-events:none;'
    + 'padding:env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left)';
  const out = document.createElement('div');
  out.setAttribute('role', 'status');
  out.style.cssText = 'position:fixed;left:8px;bottom:30%;z-index:2147483647;pointer-events:none;'
    + 'font:10px/1.3 monospace;background:#fff;color:#000;padding:2px 4px';
  const n = (value) => Math.round(parseFloat(value));
  const write = () => {
    const inset = getComputedStyle(gauge), view = window.visualViewport, root = document.documentElement;
    const visual = view ? `${n(view.width)}x${n(view.height)}@${n(view.offsetLeft)},${n(view.offsetTop)}` : 'none';
    out.textContent = `probe: window ${innerWidth}x${innerHeight} layout ${root.clientWidth}x${root.clientHeight}`
      + ` visual ${visual} insets ${n(inset.paddingTop)},${n(inset.paddingRight)},${n(inset.paddingBottom)},${n(inset.paddingLeft)}`
      + ` scroll ${n(scrollX)},${n(scrollY)}`;
  };
  addEventListener('DOMContentLoaded', () => { document.body.append(gauge, out); write(); });
  for (const event of ['resize', 'scroll', 'orientationchange']) addEventListener(event, write);
  window.visualViewport?.addEventListener('resize', write);
  window.visualViewport?.addEventListener('scroll', write);
  setInterval(write, 500);
})();
