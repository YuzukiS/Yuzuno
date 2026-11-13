/**
 * Home's "needs you" count on the desktop app's taskbar button or dock icon
 * (YN-43, YN-94): the same count as Home's tab and the window title, handed
 * to the desktop shell's `desktop_badge` command with the language of its
 * words for screen readers. Windows shows a bubble on the taskbar button;
 * macOS shows the system's own red number on the dock icon; the desktop app
 * on other systems takes the count and shows nothing. Outside the desktop
 * app there is no command, and nothing is sent.
 *
 * A count is sent only when it or the language changes. An older desktop
 * app has no such command; its refusal is ignored, and nothing else
 * depends on the badge.
 */

export type DesktopInvoke = (command: string, args?: Record<string, unknown>) => Promise<unknown>;

/** The words' language: the page's own. */
export type BadgeLanguage = "en" | "zh";

/** The desktop window's command bridge, if this page runs inside it. */
export const desktopInvoke = (): DesktopInvoke | undefined =>
  typeof window === "undefined"
    ? undefined
    : (window as Window & { __TAURI__?: { core?: { invoke?: DesktopInvoke } } }).__TAURI__?.core?.invoke;

/** A sender for one page: call it with the count whenever it may have
 * changed; it hands on only a change. */
export function desktopBadge(invoke: DesktopInvoke | undefined = desktopInvoke()) {
  let sent: string | null = null;
  return (count: number, language: BadgeLanguage): void => {
    if (!invoke) return;
    const n = Number.isSafeInteger(count) && count > 0 ? count : 0;
    const key = `${n} ${language}`;
    if (key === sent) return;
    sent = key;
    invoke("desktop_badge", { count: n, lang: language }).catch(() => {
      // Not taken: the same count may be offered again.
      if (sent === key) sent = null;
    });
  };
}
