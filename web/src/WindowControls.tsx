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

/** The desktop window, when its shell drew no system frame (Windows). In a
 * browser, an older shell, or without the permission, the system frame stays
 * and the toolbar remains an ordinary toolbar. */
export function useCustomFrame() {
  const [frame, setFrame] = useState<NativeWindow | null>(null);
  useEffect(() => {
    const win = currentWindow();
    if (!win) return;
    let live = true;
    win.isDecorated().then(
      (decorated) => live && !decorated && setFrame(win),
      () => {},
    );
    return () => {
      live = false;
    };
  }, []);
  return frame;
}

const CONTROL = "button, a, input, select, textarea, summary, [role], [tabindex]";

/** A press on the bar's empty parts moves the window; a double press
 * maximizes or restores it. Controls in the bar keep their own clicks, and
 * so does a panel opened from the bar, such as Jobs: React passes the
 * presses on its overlay up to the bar, but they happen elsewhere, and a
 * drag would swallow the click that closes it. */
export function moveWindow(frame: NativeWindow | null, event: React.MouseEvent) {
  if (!frame || event.button !== 0) return;
  if (!event.currentTarget.contains(event.target as Node)) return;
  if ((event.target as Element).closest(CONTROL)) return;
  event.preventDefault();
  void (event.detail === 2 ? frame.toggleMaximize() : frame.startDragging());
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
