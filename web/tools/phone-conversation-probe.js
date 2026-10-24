// T-170: a phone conversation's layout, measured inside a browser Playwright
// does not drive (Mobile Safari in an iOS Simulator), on the crowded
// conversations of phone-fixture-server.mjs:
//   YUZUNO_FIXTURE=conversation YUZUNO_INJECT=<this file> ios/uitests/run.sh safari <out>
// The criteria are those phone-conversation-check.mjs asserts in Chromium.
// While a conversation is on screen it measures 1.5 s after it opens, after
// each rotation, resize or keyboard change, and again 2 s later. Each
// measurement is one line of phone-measure.jsonl: probe "phone-conversation",
// the Agent, the state ("closed", "keyboard", "work-open", "turns-open",
// "closed-again"), the numbers, `failed`: the criteria that state did not
// meet (none, []), and `unmeasured`: those it could not measure there (the
// latest reply's, when the conversation is not at its latest; and a control a
// dialog covers, "(modal: not-applicable)" — a dialog is over the
// conversation on purpose). `unmeasured` is not `failed` and is not passing
// either: neither counts as the criterion met. A dialog excuses only "on
// top", and only for the control it actually covers; the overflow criteria
// are never waived with it. Each line also carries `dialog` and `keyboard`,
// so which of those was true is read off the record rather than inferred from
// a state's name or a screenshot's, and `vvRaw`/`visualHeight`/`clientHeight`
// beside the rounded `visual`. Once, when a conversation is first on screen without the
// keyboard, it opens the work panel and then the turn panel with their
// buttons, and closes each by a click outside it: scripted clicks, not
// touches, done in about a second, well before the next screenshot. Otherwise
// it only reads layout.
(() => {
  const shown = (el) => {
    if (!el) return false;
    const r = el.getBoundingClientRect();
    const s = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && s.display !== "none" && s.visibility !== "hidden";
  };
  const box = (el) => {
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return [r.left, r.top, r.width, r.height].map(Math.round);
  };
  const meets = (a, b) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
  // A dialog of the app's own (components.tsx's Modal: a Radix
  // Dialog.Content, role="dialog", beside a .modal-overlay sibling) is on
  // screen. While one is, it covers the conversation on purpose.
  const dialog = () => [...document.querySelectorAll('[role="dialog"]')].some(shown);
  // What a tap at the middle of an element reaches: the element itself
  // ("self"), nothing at all ("nothing": the middle is outside the viewport,
  // where elementFromPoint answers null — not the same as being covered), or
  // what covers it. `modal` says that what it reached belongs to a dialog: the
  // overlay is a sibling of the dialog box, so closest() has to name both, and
  // the dialog's own content can be what a tap reaches, not only the overlay.
  const onTop = (el) => {
    if (!shown(el)) return { hit: "hidden", modal: false };
    const r = el.getBoundingClientRect();
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    if (hit && (hit === el || el.contains(hit))) return { hit: "self", modal: false };
    if (!hit) return { hit: "nothing", modal: false };
    return {
      hit: String(hit.className || hit.tagName).slice(0, 60),
      modal: !!hit.closest('.modal-overlay, [role="dialog"]'),
    };
  };
  const post = (value) => {
    const line = JSON.stringify({ probe: "phone-conversation", ms: Math.round(performance.now()), ...value });
    if (!(navigator.sendBeacon && navigator.sendBeacon("/__measure", line)))
      fetch("/__measure", { method: "POST", body: line, keepalive: true }).catch(() => {});
  };
  const main = () => document.querySelector(".main-panel");
  // The Agent whose conversation is on screen, if one is.
  const agent = () => {
    const input = main()?.querySelector("[data-composer-input]");
    if (!shown(input) || !main().querySelector(".turn")) return null;
    return (input.getAttribute("aria-label") || "").replace(/^Message /, "");
  };
  const keyboard = () => document.documentElement.hasAttribute("data-keyboard");

  let n = 0;
  function measure(state, why) {
    const who = agent();
    if (!who) return;
    const panel = main();
    const failed = [], unmeasured = [];
    const need = (criterion, ok) => { if (!ok) failed.push(criterion); };
    // How far the conversation is from its latest, where the latest reply is.
    const scroll = panel.querySelector(".conversation-scroll");
    const away = scroll ? Math.round(scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight) : null;
    const overflow = [".conversation-inner", ".composer", ".composer-bottom", ".reply-actions", ".recovery-notice", ".inline-error", ".composer-hint", ".message-content", ".pending-card"]
      .flatMap((selector) => [...panel.querySelectorAll(selector)].filter(shown)
        .filter((el) => el.scrollWidth > el.clientWidth + 1 && !["auto", "scroll"].includes(getComputedStyle(el).overflowX))
        .map((el) => `${selector} ${el.scrollWidth}>${el.clientWidth}`));
    const buttons = [...panel.querySelectorAll(".phone-dock-button")].filter(shown);
    const controls = Object.fromEntries([
      ["input", "[data-composer-input]"], ["send", ".send-button"],
      ["image", '.composer-tools button[aria-label="Add images"]'],
      ["markUp", '.composer-tools button[aria-label="Mark up an image"]'],
      ["mode", ".composer-tools .composer-mode"],
    ].map(([name, selector]) => {
      const el = panel.querySelector(selector);
      const reached = onTop(el);
      return [name, { onTop: reached.hit, modal: reached.modal, box: box(el) }];
    }));
    // A control a dialog covers is not measured here rather than failed: the
    // dialog is meant to be over it. Only a dialog excuses it, and only the
    // "on top" criterion — nothing else is waived with it.
    const open = dialog();
    const needControl = (criterion, control) => {
      if (control.onTop === "self") return;
      if (open && control.modal) unmeasured.push(`${criterion} (modal: not-applicable)`);
      else failed.push(criterion);
    };
    const work = panel.querySelector(".work-dock"), turns = panel.querySelector(".turn-dock");
    const composer = panel.querySelector(".composer")?.getBoundingClientRect();
    const text = box(panel.querySelector(".conversation-inner"));
    const hint = panel.querySelector(".composer-hint[data-notice]");
    const notice = hint ? { text: hint.textContent.trim(), box: box(hint), whiteSpace: getComputedStyle(hint).whiteSpace, clipped: hint.scrollWidth > hint.clientWidth + 1 } : null;
    const reply = [...panel.querySelectorAll(".reply-actions")].filter((el) => el.querySelector(":scope > .copy-button") && el.querySelector(":scope > .turn-footer")).at(-1);
    const copy = reply?.querySelector(":scope > .copy-button")?.getBoundingClientRect();
    const footer = reply?.querySelector(":scope > .turn-footer")?.getBoundingClientRect();
    const replyRows = copy && footer ? { actionsBottom: Math.round(copy.bottom), timeTop: Math.round(footer.top), separate: footer.top >= copy.bottom - 1 } : null;
    const errorEl = [...panel.querySelectorAll(".turn .inline-error")].filter(shown).at(-1);
    const error = errorEl ? { box: box(errorEl), clipped: errorEl.scrollWidth > errorEl.clientWidth + 1 || errorEl.scrollHeight > errorEl.clientHeight + 1 } : null;
    const vv = window.visualViewport;
    const send = panel.querySelector(".send-button")?.getBoundingClientRect();

    need("phone layout", /\bphone\b/.test(document.querySelector(".app")?.className || ""));
    need("no page overflow", document.documentElement.scrollWidth <= innerWidth);
    need("nothing runs off the side", overflow.length === 0);
    if (state === "keyboard") {
      need("no dock button with the keyboard", buttons.length === 0);
      needControl("input on top", controls.input);
      needControl("Send on top", controls.send);
      need("Send in the visual viewport", !!send && !!vv && send.top >= vv.offsetTop - 1 && send.bottom <= vv.offsetTop + vv.height + 1);
    } else {
      for (const [name, control] of Object.entries(controls)) needControl(`${name} on top`, control);
      need("two dock buttons of 44px", buttons.length === 2 && buttons.every((b) => b.offsetWidth >= 44 && b.offsetHeight >= 44));
      need("dock buttons clear of the composer", !!composer && !buttons.some((b) => meets(b.getBoundingClientRect(), composer)));
    }
    if (state !== "work-open" && state !== "turns-open") need("docks wait to be opened", !shown(work) && !shown(turns));
    if (state === "closed" || state === "closed-again") {
      // Upright, the text has the width; sideways the column's reading width bounds it.
      if (innerWidth <= 520) need("text has the width", !!text && text[2] >= innerWidth - 34);
      if (who === "Mori") {
        need("notice reads in full", !!notice && !notice.clipped && notice.whiteSpace !== "nowrap");
        if (away !== null && away <= 72) {
          need("reply's actions above its time", !!replyRows?.separate);
          need("Turn's error reads in full", !!error && !error.clipped);
        } else unmeasured.push("reply's actions above its time", "Turn's error reads in full");
      }
    }
    const opened = state === "work-open" ? work : state === "turns-open" ? turns : null;
    let items = null;
    if (opened) {
      const button = panel.querySelector(state === "work-open" ? ".phone-dock-work" : ".phone-dock-turns")?.getBoundingClientRect();
      const r = opened.getBoundingClientRect();
      need("the panel opens alone", shown(opened) && !shown(opened === work ? turns : work));
      need("the panel is on screen", r.left >= 0 && r.right <= innerWidth && r.top >= 0);
      need("the panel opens above its button", !!button && r.bottom <= button.top + 1);
      if (state === "work-open") {
        items = [...work.querySelectorAll(".work-dock-item")].map((el) => { const b = el.getBoundingClientRect(); return [Math.round(b.width), Math.round(b.height), b.left >= 0 && b.right <= innerWidth]; });
        need("jobs, runs and the sub-agent listed", items.length >= 5);
        need("each a 44px row on screen", items.every(([, height, within]) => height >= 44 && within));
      } else {
        // Back to latest shows only away from the latest.
        const latest = turns.querySelector(".turn-dock-latest");
        const stops = [...turns.querySelectorAll('li[data-kind="number"] .turn-dock-stop')];
        items = stops.map((el) => [el.textContent.trim(), el.offsetWidth, el.offsetHeight]);
        need("four-digit Turns", items.some(([number]) => number.length >= 4));
        need("numbered Turns are 44px", stops.length > 0 && stops.every((el) => el.offsetWidth >= 44 && el.offsetHeight >= 44));
        need("Back to latest is 44px", !latest || (latest.offsetWidth >= 44 && latest.offsetHeight >= 44));
      }
    }
    post({
      n: ++n, agent: who, state, why, failed, unmeasured, away,
      window: [innerWidth, innerHeight],
      visual: vv ? [vv.width, vv.height, vv.offsetTop].map(Math.round) : null,
      // The same reading unrounded, with the scale, beside what the layout
      // made of it: `visual` alone could not tell a short viewport from one
      // the page had not taken up yet, and -12 is a reading to keep as it
      // came rather than round into something that looks deliberate.
      vvRaw: vv ? { offsetTop: vv.offsetTop, height: vv.height, scale: vv.scale } : null,
      visualHeight: getComputedStyle(document.documentElement).getPropertyValue("--visual-height").trim() || null,
      clientHeight: document.documentElement.clientHeight,
      // Whether a dialog is on screen and whether the keyboard is up, so the
      // two can be read off the record instead of guessed from the state's
      // name or a screenshot's.
      dialog: open,
      keyboard: document.documentElement.hasAttribute("data-keyboard"),
      focus: document.activeElement ? (document.activeElement.getAttribute("aria-label") || document.activeElement.tagName) : null,
      overflow, text, buttons: buttons.map(box), controls, notice, replyRows, error,
      panel: opened ? box(opened) : null, items,
    });
  }

  const pause = (ms) => new Promise((done) => setTimeout(done, ms));
  // Twice a frame: React has drawn the click.
  const drawn = () => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)));
  let driven = false, driving = false;
  async function drive() {
    if (driven || keyboard() || !agent()) return;
    driven = driving = true;
    for (const [button, state] of [[".phone-dock-work", "work-open"], [".phone-dock-turns", "turns-open"]]) {
      const el = main().querySelector(button);
      if (!shown(el)) {
        post({ agent: agent(), state, why: "drive", failed: [`no ${button} to open`] });
        continue;
      }
      el.click();
      await drawn();
      await pause(150);
      measure(state, "drive");
      main().querySelector(".phone-dock-scrim")?.click();
      await drawn();
      await pause(150);
      measure("closed-again", "drive");
    }
    driving = false;
  }

  // One measurement per burst of events, then a later one; never while a
  // panel is open for the drive.
  const pending = new Map();
  const steady = (why) => {
    if (driving) setTimeout(() => steady(why), 300);
    else measure(keyboard() ? "keyboard" : "closed", why);
  };
  function soon(why, delay = 300) {
    if (pending.has(why)) return;
    pending.set(why, setTimeout(() => {
      pending.delete(why);
      steady(why);
      setTimeout(() => steady(`${why}+2s`), 2000);
    }, delay));
  }
  addEventListener("resize", () => soon("resize"));
  addEventListener("orientationchange", () => soon("orientationchange"));
  if (window.visualViewport) visualViewport.addEventListener("resize", () => soon("visual-resize"));
  new MutationObserver(() => soon(keyboard() ? "keyboard-up" : "keyboard-down"))
    .observe(document.documentElement, { attributes: true, attributeFilter: ["data-keyboard"] });
  // A conversation coming on screen: measured once it has settled, then
  // the panels, each once.
  let seen = null;
  setInterval(() => {
    const who = agent();
    if (who === seen) return;
    seen = who;
    if (!who) return;
    soon(`open ${who}`, 1500);
    setTimeout(() => void drive(), 1900);
  }, 250);
})();
