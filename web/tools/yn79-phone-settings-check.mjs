// YN-79: the settings a phone may now change, at a phone's size in isolated
// Chromium. Every request is answered by synthetic fixtures; no Core, no real
// storage. What the jsdom tests cannot see: that Settings → Phone access is
// editable there with its actions on screen, and that Accounts & keys lays
// out on a 390 px screen without sideways overflow. Screenshots go to
// YUZUNO_BROWSER_OUTPUT.
import assert from "node:assert/strict";
import { mkdir, readFile } from "node:fs/promises";
import { resolve, extname } from "node:path";
import { chromium } from "playwright-core";
import { unmanagedUpdates, noJobs, noCiRuns, noReviews, noLiveJobs, idleJobsBudget } from "./browser-fixtures.mjs";

assert.ok(process.env.YUZUNO_UI_DIST && process.env.YUZUNO_BROWSER_OUTPUT, "Explicit isolated assets/output required");
const dist = resolve(process.env.YUZUNO_UI_DIST), output = resolve(process.env.YUZUNO_BROWSER_OUTPUT);
assert.ok(!dist.endsWith("/web/dist"), "Use a separate build");
await mkdir(output, { recursive: true });
const origin = "http://yn79-phone.test";
const agent = {
  id: "cedar", name: "Cedar", harness: "codex", cwd: "/fixture/garden", threadId: "fixture-thread", connectionState: "connected",
  status: "idle", model: "fixture-model", color: "sage", createdAt: "", updatedAt: "", unreadCount: 0, pendingCount: 0,
  lastSeq: 1, reviewedSeq: 1, goal: "",
};
const projects = [{ id: "garden", name: "Garden", defaultDirs: { local: "/fixture/garden" }, createdAt: "", updatedAt: "" }];
const machines = [{ id: "local", name: "Fixture Core", kind: "local", defaultCwd: "/fixture", lastCheck: null }];
const entry = "https://pc.tail0.ts.net:8444";
const phoneView = {
  support: {
    state: "supported",
    coreHost: { kind: "wsl", name: "Ubuntu", networking: "mirrored" },
    tailscaleHost: { kind: "windows", cli: "/mnt/c/Tailscale/tailscale.exe", version: "1.90.0" },
  },
  saved: { enabled: true, login: "owner@example.com", servePort: 8444, localPort: 4318, origin: entry, savedAt: "2026-11-09T09:00:00Z", applied: true },
  environment: null,
  listening: { port: 4318, origin: entry, login: "owner@example.com", since: "2026-11-09T09:00:01Z", source: "settings" },
  serve: { state: "ours", port: 8444, target: "http://127.0.0.1:4318", otherEntries: 0, observedAt: "2026-11-09T09:00:02Z" },
  tailscale: { state: "running", dnsName: "pc.tail0.ts.net", ownerLogin: "owner@example.com", https: true, observedAt: "2026-11-09T09:00:00Z" },
  verification: { ok: true, at: "2026-11-09T09:00:02Z", steps: [] },
  operation: null,
  url: `${entry}/`,
  qr: null,
  startupError: null,
  defaults: { servePort: 8444, localPort: 4318 },
  previews: { included: false, available: false, legacy: null },
};
const routingKeys = {
  keys: [
    { id: "deepseek", provider: "deepseek", source: "local", set: true, setAt: "2026-11-09T08:00:00Z" },
    { id: "anthropic", provider: "anthropic", source: "1password", set: true, setAt: "2026-11-09T08:00:00Z", reference: "op://Vault/Anthropic/credential" },
  ],
  onePasswordToken: { set: true, setAt: "2026-11-09T08:00:00Z" },
};
const onePassword = { token: { set: true, setAt: "2026-11-09T08:00:00Z" }, op: { installed: true, version: "2.30.0", serviceAccounts: true } };
const accounts = {
  cswap: { command: "cswap", pinned: "1.0.0", accounts: [{ number: 1, fingerprint: "0123456789abcdef", active: true }] },
  codexHomes: [],
};

const errors = [];
const checks = [];
const check = (name) => { checks.push(name); console.log(`PASS ${name}`); };
const mime = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".woff2": "font/woff2", ".png": "image/png" };
const browser = await chromium.launch({ headless: true, executablePath: process.env.YUZUNO_BROWSER_BIN || "/usr/bin/chromium" });

async function open({ language, theme }) {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor: 1, locale: language === "zh-Hans" ? "zh-CN" : "en-US" });
  await context.addInitScript(([language, theme]) => {
    localStorage.setItem("yuzuno.language", JSON.stringify({ language }));
    localStorage.setItem("yuzuno.appearance", JSON.stringify({ theme, fontSize: 16, palette: "garden" }));
    localStorage.setItem("yuzuno.selected", JSON.stringify("cedar"));
  }, [language, theme]);
  await context.route("**/*", async (route) => {
    const request = route.request(), url = new URL(request.url());
    assert.equal(url.origin, origin, "No real or third-party services");
    if (!url.pathname.startsWith("/api/")) {
      const path = resolve(dist, "." + (url.pathname === "/" ? "/index.html" : url.pathname));
      assert.ok(path.startsWith(dist + "/"));
      try { return await route.fulfill({ body: await readFile(path), contentType: mime[extname(path)] || "application/octet-stream" }); }
      catch { return route.fulfill({ status: 404, body: "" }); }
    }
    const respond = (value) => route.fulfill({ contentType: "application/json", body: JSON.stringify(value) });
    switch (url.pathname) {
      case "/api/health": return respond({ product: "yuzuno", application: "yuzuno-next", workspaceId: "yn79-phone", releaseId: "fixture" });
      case "/api/workspace": return respond({ agents: [agent], projects, projectUsage: {}, runtime: { connected: true }, defaultCwd: "/fixture", workspace: { id: "yn79-phone" } });
      case "/api/agents/cedar": return respond({ agent, turns: [], pending: [], artifacts: [], messages: [] });
      case "/api/updates": case "/api/updates/check": return respond(unmanagedUpdates);
      case "/api/models": return respond({ models: [] });
      case "/api/machines": return respond({ machines });
      case "/api/home/presentation": return respond({ style: "default", note: "", agentText: null });
      case "/api/jobs": return respond(noJobs);
      case "/api/jobs/budget": return respond(idleJobsBudget);
      case "/api/jobs/live": return respond(noLiveJobs);
      case "/api/ci": return respond(noCiRuns);
      case "/api/reviews": return respond(noReviews);
      case "/api/catchup": return respond({ items: [], agents: [] });
      case "/api/projects/garden/home-editors": return respond({ version: 0, editorAgentIds: null });
      case "/api/projects/garden/leads": return respond({ version: 0, leadAgentIds: [] });
      case "/api/projects/garden/services": return respond({ services: [] });
      case "/api/remote-access": return respond(phoneView);
      case "/api/routing/keys": return respond(routingKeys);
      case "/api/routing/1password": return respond(onePassword);
      case "/api/routing/accounts": return respond(accounts);
      default: return respond(url.pathname.includes("/collaboration/") ? { tasks: [], messages: [], agents: [] } : {});
    }
  });
  const page = await context.newPage();
  page.on("pageerror", (error) => errors.push(`${language} ${theme}: ${error.message}`));
  page.on("console", (message) => { if (message.type() === "error" && /TypeError|ReferenceError|Minified React error/.test(message.text())) errors.push(message.text()); });
  await page.goto(origin);
  await page.locator(".agent-list").waitFor();
  return { page, context };
}

const dialog = (page) => page.locator(".modal.settings-modal");
async function openSettings(page) {
  await page.locator(".workspace-settings").click();
  await dialog(page).locator(".settings-center").waitFor();
  await page.waitForTimeout(250);
}
async function noOverflow(page, label) {
  const parts = await dialog(page).evaluate((el) => [el, el.querySelector(".settings-pane"), el.querySelector(".settings-editor:not([hidden])")]
    .filter(Boolean).map((part) => ({ name: part.className, scroll: part.scrollWidth, client: part.clientWidth })));
  for (const part of parts) assert.ok(part.scroll <= part.client + 1, `${label}: ${part.name} overflows sideways (${part.scroll} > ${part.client})`);
}
const words = {
  en: { phone: "Phone access", routing: "Executor routing", accounts: "Accounts & keys", off: "Turn off", check: "Check", apply: "Save and apply", keys: "Accounts & keys" },
  "zh-Hans": { phone: "手机访问", routing: "执行者路由", accounts: "账号与密钥", off: "关闭", check: "检查", apply: "保存并应用", keys: "账号与密钥" },
};

try {
  for (const language of ["en", "zh-Hans"]) {
    for (const theme of ["light", "dark"]) {
      const label = `390 ${language} ${theme}`;
      const { page, context } = await open({ language, theme });
      const t = words[language];
      await openSettings(page);
      // Phone access: editable on the phone entry, with no read-only note.
      await dialog(page).locator("#settings-tab-phone").click();
      const remote = dialog(page).locator("#settings-editor-remote:not([hidden])");
      await remote.waitFor();
      await page.waitForTimeout(150);
      for (const label of [t.check, t.apply, t.off]) assert.ok(await remote.getByRole("button", { name: label }).isVisible(), `${label}: ${label}`);
      assert.equal(await remote.getByText(/open through the phone entry, so it cannot change it/).count(), 0, `${label}: no read-only note`);
      assert.equal(await remote.locator(".remote-access-confirm").count(), 0, `${label}: no confirmation panel`);
      await noOverflow(page, `${label} phone access`);
      await page.screenshot({ path: resolve(output, `phone-access-${language}-${theme}.png`) });
      await dialog(page).locator(".settings-back").click();
      // Accounts & keys: its own page after routing (YN-84 S2), read and changed on a phone.
      await dialog(page).locator("#settings-tab-accounts").click();
      const routing = dialog(page).locator("#settings-editor-routing-keys:not([hidden])");
      await routing.waitFor();
      await page.waitForTimeout(200);
      assert.ok(await routing.getByText(t.keys).first().isVisible(), `${label}: its title`);
      assert.equal(await routing.locator(".routing-read-error").count(), 0, `${label}: no boundary error`);
      assert.ok(await routing.getByText("DeepSeek").first().isVisible(), `${label}: a key row`);
      await noOverflow(page, `${label} accounts and keys`);
      await page.screenshot({ path: resolve(output, `routing-keys-${language}-${theme}.png`) });
      await context.close();
      check(`${label}: phone access is editable, accounts and keys lays out`);
    }
  }
  assert.deepEqual(errors, [], "no page errors");
  console.log(`PASS ${checks.length} checks; screenshots in ${output}`);
} finally {
  await browser.close();
}
