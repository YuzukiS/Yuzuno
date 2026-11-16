/**
 * A kept file dragged out of the page as itself (YN-102, YN-170).
 *
 * In the desktop app the app drags it, as a real file: the page names the
 * file (never an address or a path) to the app's `desktop_file_drag`
 * command once the pointer has moved with its button held, and the app
 * fetches it from Core and starts the system's drag with its path
 * (desktop/src/file_drag.rs). Any app that takes a dropped file takes it:
 * a folder, a mail, the ChatGPT app's input box. A desktop app without the
 * command (an older one) says so when asked, and the page drags as a
 * browser does.
 *
 * In a browser only Chromium on Windows and macOS drags a file out, as a
 * `DownloadURL`: a folder or the desktop saves it as that file, but an app
 * that takes only real paths does not, and no page can give it one. Other
 * browsers drag nothing out: a link to a file is not dragged as a link
 * (which a folder would keep as a shortcut).
 */
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type DragEvent,
  type HTMLAttributes,
  type MouseEvent,
  type PointerEvent,
} from "react";
import { desktopInvoke, type DesktopInvoke } from "./desktop-badge";
import { strings, useStrings } from "./i18n";

/** A file Core keeps, as `desktop_file_drag` takes it. */
export type NativeFile =
  | { kind: "briefAttachment"; projectId: string; section: string; name: string; version: number }
  | { kind: "agentFile"; agentId: string; fileId: string; name: string }
  | { kind: "projectFile"; projectId: string; fileId: string; name: string };

/** A file to drag out: the file as the app fetches it, and for a browser's
 * `DownloadURL` its type and where the page reads it. */
export type DragTarget = { file: NativeFile; mime: string; url: string };

/** How far the pointer moves with its button held before a drag starts, in
 * CSS pixels: Windows' default drag rectangle (`SM_CXDRAG`, `SM_CYDRAG`)
 * and Chromium's own threshold. A shorter press is a click. */
export const DRAG_THRESHOLD = 4;

/** How long a failed drag's reason stays in view. */
const ERROR_MS = 6000;

const text = strings(
  { failed: (reason: string) => `Couldn’t drag this file out: ${reason}` },
  { failed: (reason) => `无法拖出这个文件：${reason}` },
);

/**
 * Whether this browser drags a kept file out as itself (YN-102): Chromium
 * on Windows and macOS (Chrome, Edge, the Windows app's WebView2) saves a
 * `DownloadURL` dropped on a folder or the desktop as that file. Safari,
 * Firefox, the Mac and iPhone apps (WKWebView) and phones have no such
 * drag; nor Linux, where only some file managers take that drop and none
 * was checked. By the user agent: `navigator.userAgentData` exists only in a
 * secure context, and Core is also opened over plain http at a LAN address.
 */
export function dragsOutAsFile(agent = navigator.userAgent) {
  return /\bChrome\/\d/.test(agent) && /Windows NT|Macintosh/.test(agent);
}

let asked: { invoke: DesktopInvoke; ready: Promise<boolean> } | null = null;

/** Whether the desktop app this page runs in drags files out itself: asked
 * once per page. Outside the desktop app, or in one without the command, no. */
export function nativeFileDrag(invoke: DesktopInvoke | undefined = desktopInvoke()): Promise<boolean> {
  if (!invoke) return Promise.resolve(false);
  if (asked?.invoke !== invoke) {
    const ready = invoke("desktop_file_drag", {}).then(
      (answer) => typeof answer === "object" && answer !== null && (answer as { ready?: unknown }).ready === true,
      () => false,
    );
    asked = { invoke, ready };
  }
  return asked.ready;
}

/** What Tauri rejects a command with: the command's own error text. */
const reasonOf = (reason: unknown) =>
  typeof reason === "string" ? reason : reason instanceof Error ? reason.message : String(reason);

type DragProps = HTMLAttributes<HTMLElement> & { draggable?: boolean; "data-file-drag"?: string };

export type FileDrag = {
  /** How this page drags the file out: through the desktop app as a real
   * file, as a browser's `DownloadURL`, or not at all. */
  mode: "native" | "download" | "none";
  /** For each element that drags the file out (a link stays a link to click). */
  props: DragProps;
  /** Why the last drag failed, for a few seconds; else null. */
  error: string | null;
};

/** How `target` is dragged out of this page; null drags nothing. */
export function useFileDrag(target: DragTarget | null): FileDrag {
  const t = useStrings(text);
  const [ready, setReady] = useState(false);
  const [preparing, setPreparing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const latest = useRef(target);
  latest.current = target;
  // The press under way, if any: what stops following it.
  const press = useRef<(() => void) | null>(null);
  // A click that follows a drag is the end of the drag, not a click.
  const swallow = useRef(false);

  useEffect(() => {
    let live = true;
    void nativeFileDrag().then((yes) => {
      if (live) setReady(yes);
    });
    return () => {
      live = false;
      press.current?.();
    };
  }, []);
  useEffect(() => {
    if (!error) return;
    const timer = setTimeout(() => setError(null), ERROR_MS);
    return () => clearTimeout(timer);
  }, [error]);

  const onPointerDown = useCallback(
    (event: PointerEvent<HTMLElement>) => {
      swallow.current = false;
      press.current?.();
      if (event.pointerType !== "mouse" || event.button !== 0 || !latest.current) return;
      const from = { x: event.clientX, y: event.clientY };
      const view = event.currentTarget.ownerDocument.defaultView;
      if (!view) return;
      const move = (moved: globalThis.PointerEvent) => {
        if (Math.max(Math.abs(moved.clientX - from.x), Math.abs(moved.clientY - from.y)) < DRAG_THRESHOLD) return;
        stop();
        const file = latest.current?.file;
        const invoke = desktopInvoke();
        if (!file || !invoke) return;
        swallow.current = true;
        setError(null);
        setPreparing(true);
        invoke("desktop_file_drag", { file })
          .then(
            () => undefined,
            (reason) => setError(t.failed(reasonOf(reason))),
          )
          .finally(() => setPreparing(false));
      };
      const stop = () => {
        view.removeEventListener("pointermove", move, true);
        view.removeEventListener("pointerup", stop, true);
        view.removeEventListener("pointercancel", stop, true);
        view.removeEventListener("blur", stop);
        if (press.current === stop) press.current = null;
      };
      view.addEventListener("pointermove", move, true);
      view.addEventListener("pointerup", stop, true);
      view.addEventListener("pointercancel", stop, true);
      view.addEventListener("blur", stop);
      press.current = stop;
    },
    [t],
  );
  const onClickCapture = useCallback((event: MouseEvent<HTMLElement>) => {
    if (!swallow.current) return;
    swallow.current = false;
    event.preventDefault();
    event.stopPropagation();
  }, []);

  if (!target) return { mode: "none", props: {}, error: null };
  if (ready)
    return {
      mode: "native",
      props: {
        draggable: false,
        // The browser's own drag (of a link, or of selected text) never starts.
        onDragStart: (event: DragEvent<HTMLElement>) => event.preventDefault(),
        onPointerDown,
        onClickCapture,
        "data-file-drag": preparing ? "preparing" : "ready",
      },
      error,
    };
  if (dragsOutAsFile())
    return {
      mode: "download",
      props: { draggable: true, onDragStart: (event: DragEvent<HTMLElement>) => downloadUrl(event, target) },
      error: null,
    };
  return { mode: "none", props: { draggable: false }, error: null };
}

/** The browser fetches the file as the page does (no credential in the
 * address) and saves it under Core's name, which never holds the format's
 * colons (Core keeps attachment names to `[\w.-]` and file names free of
 * `:`). */
function downloadUrl(event: DragEvent<HTMLElement>, target: DragTarget) {
  const type = target.mime.split(";")[0].trim() || "application/octet-stream";
  event.dataTransfer.setData("DownloadURL", `${type}:${target.file.name}:${new URL(target.url, window.location.href).href}`);
  event.dataTransfer.effectAllowed = "copy";
}
