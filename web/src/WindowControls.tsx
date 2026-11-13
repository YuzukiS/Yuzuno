import { useEffect, useState } from "react";
import { Copy, Minus, Square, X } from "lucide-react";
import { strings, useStrings } from "./i18n";
import { Tip, TipText } from "./Tip";
import "./window-controls.css";

const text = strings({
  window: "Window",
  minimize: "Minimize",
  maximize: "Maximize",
  restore: "Restore",
  close: "Close window",
}, {
  window: "窗口",
  minimize: "最小化",
  maximize: "最大化",
  restore: "还原",
  close: "关闭窗口",
});

/** The few window calls the toolbar makes; the desktop shell grants exactly
 * these to the selected Core's page. */
export type NativeWindow = {
  isDecorated(): Promise<boolean>;
  isMaximized(): Promise<boolean>;
  minimize(): Promise<void>;
  toggleMaximize(): Promise<void>;
  close(): Promise<void>;
  startDragging(): Promise<void>;
};

function currentWindow(): NativeWindow | undefined {
  return (
    window as Window & {
      __TAURI__?: { window?: { getCurrentWindow?: () => NativeWindow } };
    }
  ).__TAURI__?.window?.getCurrentWindow?.();
}

/** What the macOS shell reports of the system's own window buttons over the
 * toolbar (YN-90): where they end, from the window's left edge (0 while they
 * are hidden, as in full screen), and what a double click on the bar does by
 * the user's system setting. */
export type TitleBar = { inset: number; doubleClick: "zoom" | "minimize" | "none" };

const DOUBLE_CLICKS = new Set(["zoom", "minimize", "none"]);

/** Asks the shell now. A browser, another system, an older shell without
 * the command, a refusal or an answer of another shape: null, and the
 * toolbar stays as it is. */
export async function readTitleBar(): Promise<TitleBar | null> {
  const invoke = (
    window as Window & {
      __TAURI__?: { core?: { invoke?: (command: string) => Promise<unknown> } };
    }
  ).__TAURI__?.core?.invoke;
  if (!invoke) return null;
  try {
    const answer = (await invoke("desktop_title_bar")) as Partial<TitleBar> | null;
    if (
      !answer ||
      typeof answer.inset !== "number" ||
      !Number.isFinite(answer.inset) ||
      answer.inset < 0 ||
      !DOUBLE_CLICKS.has(answer.doubleClick as string)
    )
      return null;
    return { inset: answer.inset, doubleClick: answer.doubleClick as TitleBar["doubleClick"] };
  } catch {
    return null;
  }
}

/** How the desktop window's toolbar acts as its title bar:
 * - `controls` (Windows): no system frame; the toolbar moves the window and
 *   carries its own window controls.
 * - `overlay` (macOS): the system frame's title bar lies over the page and
 *   its window buttons stand at the toolbar's leading end; the toolbar
 *   leaves them `inset` pixels and moves the window.
 * In a browser, an older shell, or without the permission: null, and the
 * toolbar remains an ordinary toolbar. */
export type WindowFrame =
  | { kind: "controls"; window: NativeWindow }
  | { kind: "overlay"; window: NativeWindow; inset: number };

export function useWindowFrame() {
  const [frame, setFrame] = useState<WindowFrame | null>(null);
  useEffect(() => {
    const win = currentWindow();
    if (!win) return;
    let live = true;
    // The newest question wins: answers to earlier resizes may come later.
    let asked = 0;
    const read = () => {
      const n = ++asked;
      void readTitleBar().then((bar) => {
        if (!live || n !== asked) return;
        // The shell sets the window's title bar when it makes the window:
        // once it has reported its buttons, a later read that fails (an IPC
        // hiccup) keeps the toolbar as it was rather than dropping their room.
        setFrame((current) =>
          !bar
            ? current?.kind === "overlay"
              ? current
              : null
            : current?.kind === "overlay" && current.inset === bar.inset
              ? current
              : { kind: "overlay", window: win, inset: bar.inset },
        );
      });
    };
    let listening = false;
    win.isDecorated().then(
      (decorated) => {
        if (!live) return;
        if (!decorated) return setFrame({ kind: "controls", window: win });
        // Entering full screen hides the buttons, leaving it shows them
        // again; both resize the window.
        read();
        window.addEventListener("resize", read);
        listening = true;
      },
      () => {},
    );
    return () => {
      live = false;
      if (listening) window.removeEventListener("resize", read);
    };
  }, []);
  return frame;
}

const CONTROL = "button, a, input, select, textarea, summary, [role], [tabindex]";

/** A press on the bar's empty parts moves the window. Controls in the bar
 * keep their own clicks, and so does a panel opened from the bar, such as
 * Jobs: React passes the presses on its overlay up to the bar, but they
 * happen elsewhere, and a drag would swallow the click that closes it.
 *
 * A double press: on Windows it maximizes or restores the window. On macOS
 * it does what the user's setting for a title bar double click says, when
 * the second press is released where it began, as Tauri's own drag regions
 * do there (tauri#8306): moving away cancels it. */
export function moveWindow(frame: WindowFrame | null, event: React.MouseEvent) {
  if (!frame || event.button !== 0) return;
  const bar = event.currentTarget;
  if (!bar.contains(event.target as Node)) return;
  if ((event.target as Element).closest(CONTROL)) return;
  event.preventDefault();
  if (event.detail !== 2) return void frame.window.startDragging();
  if (frame.kind === "controls") return void frame.window.toggleMaximize();
  const { clientX, clientY } = event;
  window.addEventListener(
    "mouseup",
    (up) => {
      const target = up.target as Element | null;
      if (
        up.button !== 0 ||
        up.detail !== 2 ||
        up.clientX !== clientX ||
        up.clientY !== clientY ||
        !target ||
        !bar.contains(target) ||
        target.closest(CONTROL)
      )
        return;
      void doubleClick(frame.window);
    },
    { once: true, capture: true },
  );
}

/** The setting is read again at each double click, so a change in System
 * Settings applies at once, as for the system's own title bars. */
async function doubleClick(win: NativeWindow) {
  const bar = await readTitleBar();
  if (bar?.doubleClick === "zoom") await win.toggleMaximize();
  else if (bar?.doubleClick === "minimize") await win.minimize();
}

export function WindowControls({ frame }: { frame: NativeWindow }) {
  const t = useStrings(text);
  const [maximized, setMaximized] = useState(false);
  useEffect(() => {
    let live = true;
    const read = () =>
      frame.isMaximized().then(
        (value) => live && setMaximized(value),
        () => {},
      );
    void read();
    window.addEventListener("resize", read);
    return () => {
      live = false;
      window.removeEventListener("resize", read);
    };
  }, [frame]);
  return (
    <div className="window-controls" role="group" aria-label={t.window}>
      <Tip side="bottom" describe={false} content={<TipText title={t.minimize} />}>
        <button type="button" className="icon-button window-control" aria-label={t.minimize} onClick={() => void frame.minimize()}>
          <Minus size={15} />
        </button>
      </Tip>
      <Tip side="bottom" describe={false} content={<TipText title={maximized ? t.restore : t.maximize} />}>
        <button type="button" className="icon-button window-control" aria-label={maximized ? t.restore : t.maximize} onClick={() => void frame.toggleMaximize()}>
          {maximized ? <Copy size={13} /> : <Square size={12} />}
        </button>
      </Tip>
      <Tip side="bottom" describe={false} content={<TipText title={t.close} />}>
        <button type="button" className="icon-button window-control close" aria-label={t.close} onClick={() => void frame.close()}>
          <X size={15} />
        </button>
      </Tip>
    </div>
  );
}
