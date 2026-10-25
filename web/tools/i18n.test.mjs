// The interface language (T-189), pure modules: which language System
// shows, English for what a table lacks, Settings' directory in Chinese
// and found by its words in either language.
import test from "node:test";
import assert from "node:assert/strict";

const { systemLanguage, strings } = await import("../src/i18n.ts");
const { findSettings, localizedCategory, localizedEntry, settingsCatalog, settingsCategories, translatedEditors } = await import("../src/settings-catalog.ts");
const { categoriesZh, entriesZh } = await import("../src/settings-catalog-zh.ts");

test("System shows Simplified Chinese for Simplified Chinese only, and English otherwise, naming what it couldn't show", () => {
  for (const tag of ["zh", "zh-CN", "zh-cn", "zh-SG", "zh-Hans", "zh-Hans-CN"]) assert.deepEqual(systemLanguage([tag, "en"]), { language: "zh-Hans", unavailable: null }, tag);
  for (const tag of ["en", "en-US", "en-GB"]) assert.deepEqual(systemLanguage([tag, "zh-CN"]), { language: "en", unavailable: null }, tag);
  // The first the browser asks for decides; this version has no other.
  for (const tag of ["zh-TW", "zh-Hant", "zh-HK", "ja-JP", "fr"]) assert.deepEqual(systemLanguage([tag, "zh-CN"]), { language: "en", unavailable: tag }, tag);
  assert.deepEqual(systemLanguage([]), { language: "en", unavailable: null });
});

test("a string a table lacks is shown in English", () => {
  const table = strings({ a: "One", b: (n) => `${n} left` }, { a: "一" });
  assert.equal(table("zh-Hans").a, "一");
  assert.equal(table("zh-Hans").b(2), "2 left");
  assert.equal(table("en").a, "One");
});

test("every category and directory entry has its Chinese text; English stays as it was", () => {
  for (const category of settingsCategories) {
    assert.ok(categoriesZh[category.id]?.label && categoriesZh[category.id]?.description, category.id);
    assert.deepEqual(localizedCategory(category.id, "en"), category);
  }
  for (const entry of settingsCatalog) {
    const zh = entriesZh[entry.id];
    assert.ok(zh?.title && zh.scope && zh.source && zh.effect, entry.id);
    if (entry.target.kind === "unavailable") assert.ok(zh.reason, `${entry.id} reason`);
    assert.equal(localizedEntry(entry, "en"), entry);
    const shown = localizedEntry(entry, "zh-Hans");
    assert.equal(shown.id, entry.id);
    assert.deepEqual(shown.target.kind, entry.target.kind);
  }
  // An entry the table lacks keeps its English.
  const unknown = { ...settingsCatalog[0], id: "not-in-the-table" };
  assert.equal(localizedEntry(unknown, "zh-Hans").title, settingsCatalog[0].title);
});

test("Settings' search finds an entry by its words in either language", () => {
  const titles = (query) => findSettings(query).map((entry) => entry.title);
  assert.deepEqual(titles("clock"), ["Clock & time zone"]);
  assert.deepEqual(titles("时钟与时区"), ["Clock & time zone"]);
  assert.deepEqual(titles("界面语言"), ["Language"]);
  assert.deepEqual(titles("language"), ["Language"]);
  assert.deepEqual(titles("键盘快捷键"), ["Keyboard shortcuts"]);
  assert.deepEqual(titles("外观与交互 发送键"), ["Sending messages"]);
});

test("the editors this version translates: Language, Sending messages, Clock & time zone, Keyboard shortcuts, Appearance, Move preferences, Data & storage, Copy diagnostics, Notification preferences, About & help, Home presentation, Code review, Phone & remote access, Runtime & versions, New Agent defaults", () => {
  assert.deepEqual([...translatedEditors], ["language", "input", "time", "shortcuts", "appearance", "transfer", "storage", "diagnostics", "notifications", "about", "home", "review", "remote", "runtime", "agent-defaults"]);
  for (const editor of translatedEditors) assert.ok(settingsCatalog.some((entry) => entry.target.kind === "editor" && entry.target.editor === editor), editor);
});
