// T-170: where a page's parts are on a phone, measured inside the browser
// itself. phone-fixture-server.mjs adds this to each page it serves; a check
// outside Playwright (Mobile Safari in an iOS Simulator) then reads, as JSON
// lines, what the page saw: the safe-area insets as CSS resolves env(), the
// window and the visual viewport (which shrinks when the keyboard opens), the
// scroll position, what has focus, and the boxes of the app's parts in CSS px.
// It measures on load, on each resize, rotation, visual viewport change, focus
// change and dialog opening or closing, and again 2 s and 6 s later. It reads
// only layout and never changes the page.
(() => {
  const probe = document.createElement("div");
  probe.setAttribute("aria-hidden", "true");
  probe.style.cssText = "position:fixed;left:0;top:0;width:0;height:0;visibility:hidden;pointer-events:none;"
    + "padding:env(safe-area-inset-top,0px) env(safe-area-inset-right,0px) env(safe-area-inset-bottom,0px) env(safe-area-inset-left,0px)";
  document.documentElement.append(probe);

  // The app's parts (safe-area-check.mjs measures the same), then the iOS
  // app's connection page (ios/connection/index.html) when it is the page.
  const parts = {
    app: ".app", toolbar: ".toolbar", main: ".main-panel", composer: ".composer", input: "[data-composer-input]",
    send: ".send-button", overlay: ".modal-overlay", modal: ".modal",
    wordmark: ".wordmark", eyebrow: ".eyebrow", heading: "h1", field: "#core-url",
  };
  const round = (n) => Math.round(n * 100) / 100;
  const box = (selector) => {
    const el = [...document.querySelectorAll(selector)].find((e) => {
      const r = e.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    });
    if (!el) return undefined;
    const r = el.getBoundingClientRect();
    return [r.left, r.top, r.right, r.bottom].map(round);
  };

  let n = 0;
  function measure(why) {
    const inset = getComputedStyle(probe);
    const vv = window.visualViewport;
    const focused = document.activeElement && document.activeElement !== document.body
      ? document.activeElement.getAttribute("aria-label") || document.activeElement.id || document.activeElement.tagName.toLowerCase()
      : null;
    const boxes = {};
    for (const [name, selector] of Object.entries(parts)) {
      const b = box(selector);
      if (b) boxes[name] = b;
    }
    const line = JSON.stringify({
      n: ++n, why, ms: Math.round(performance.now()), page: location.pathname,
      orientation: screen.orientation ? screen.orientation.type : (matchMedia("(orientation: landscape)").matches ? "landscape" : "portrait"),
      standalone: "standalone" in navigator ? navigator.standalone : null,
      insets: [inset.paddingTop, inset.paddingRight, inset.paddingBottom, inset.paddingLeft],
      window: [innerWidth, innerHeight],
      visual: vv ? [vv.width, vv.height, vv.offsetLeft, vv.offsetTop, vv.pageLeft, vv.pageTop, vv.scale].map(round) : null,
      scroll: [round(scrollX), round(scrollY)],
      focused, boxes,
    });
    if (!(navigator.sendBeacon && navigator.sendBeacon("/__measure", line)))
      fetch("/__measure", { method: "POST", body: line, keepalive: true }).catch(() => {});
  }

  // One measurement per burst of events of a kind, then the two late ones.
  const pending = new Map();
  function soon(why) {
    if (pending.has(why)) return;
    pending.set(why, setTimeout(() => {
      pending.delete(why);
      measure(why);
      setTimeout(() => measure(`${why}+2s`), 2000);
      setTimeout(() => measure(`${why}+6s`), 6000);
    }, 150));
  }

  if (document.readyState === "complete") soon("load");
  else addEventListener("load", () => soon("load"));
  addEventListener("resize", () => soon("resize"));
  addEventListener("orientationchange", () => soon("orientationchange"));
  addEventListener("focusin", () => soon("focusin"));
  addEventListener("focusout", () => soon("focusout"));
  if (window.visualViewport) {
    visualViewport.addEventListener("resize", () => soon("visual-resize"));
    visualViewport.addEventListener("scroll", () => soon("visual-scroll"));
  }
  let dialog = false;
  new MutationObserver(() => {
    const open = !!document.querySelector(".modal");
    if (open !== dialog) {
      dialog = open;
      soon(open ? "dialog-open" : "dialog-closed");
    }
  }).observe(document.documentElement, { childList: true, subtree: true });
})();
