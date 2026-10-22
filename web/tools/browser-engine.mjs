// The browser a check drives: the system Chromium, or Playwright's Linux
// WebKit through a server started elsewhere (YUZUNO_WEBKIT_WS), such as a
// sandbox that has WebKit's libraries (T-170). Linux WebKit is not iOS Safari.
import { chromium, webkit } from "playwright-core";

export const engine = process.env.YUZUNO_WEBKIT_WS ? "webkit" : "chromium";

export function launchBrowser() {
  if (engine === "webkit") return webkit.connect(process.env.YUZUNO_WEBKIT_WS);
  return chromium.launch({ headless: true, executablePath: process.env.YUZUNO_BROWSER_BIN || "/usr/sbin/chromium" });
}
