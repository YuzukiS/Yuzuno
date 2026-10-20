// Third-party notices for what a bundle actually contains (T-90). Every npm
// package that one of the bundle's modules or assets came from is listed with
// the license its package.json declares and the license texts the package
// ships, reproduced as they are. Nothing is chosen, inferred or filled in: a
// package that ships no license text is listed as such. Shared by the web
// build (vite.config.ts) and the result validator's generator.
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";

const LICENSE_FILE = /^(licen[cs]e|copying|notice|copyright|unlicense)([-._]|$)/i;

/** The package directory a bundled file came from: the deepest
 * node_modules/<name> (or node_modules/@scope/<name>) above it, or null for
 * the project's own files and virtual modules. */
export function packageDir(file) {
  const path = file.replace(/^\0/, "").split("?")[0];
  const marker = "/node_modules/";
  const at = path.lastIndexOf(marker);
  if (at < 0) return null;
  const parts = path.slice(at + marker.length).split("/");
  const depth = parts[0].startsWith("@") ? 2 : 1;
  if (parts.length <= depth) return null;
  return path.slice(0, at + marker.length) + parts.slice(0, depth).join("/");
}

/** The files a Rollup-style bundle contains: modules with rendered code and
 * the original files of emitted assets (fonts, images), which the bundler
 * names relative to `root`. */
export function bundledFiles(bundle, root) {
  const files = [];
  for (const item of Object.values(bundle)) {
    if (item.type === "chunk") {
      for (const [id, info] of Object.entries(item.modules)) if (info.renderedLength > 0) files.push(id);
    } else {
      for (const name of item.originalFileNames ?? []) files.push(isAbsolute(name) ? name : resolve(root, name));
    }
  }
  return files;
}

function declaredLicense(manifest) {
  if (typeof manifest.license === "string") return manifest.license;
  if (typeof manifest.license?.type === "string") return manifest.license.type;
  if (Array.isArray(manifest.licenses))
    return `listed in the legacy "licenses" field: ${manifest.licenses.map((item) => item?.type ?? item).join(", ")}`;
  return "none declared";
}

function repository(manifest) {
  const value = typeof manifest.repository === "string" ? manifest.repository : manifest.repository?.url;
  return value ?? manifest.homepage ?? "not declared";
}

/** One package's name, version, declared license, repository and the license
 * texts it ships at its top level. */
export function packageInfo(dir) {
  const manifest = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
  const texts = readdirSync(dir)
    .filter((name) => LICENSE_FILE.test(name) && statSync(join(dir, name)).isFile())
    .sort()
    .map((name) => ({ name, text: readFileSync(join(dir, name), "utf8") }));
  return { name: manifest.name, version: manifest.version, license: declaredLicense(manifest), repository: repository(manifest), texts };
}

/** The packages the files came from, each once. A package reached through a
 * symlinked node_modules (lab copies) is the same package as its target. */
export function bundledPackages(files) {
  const dirs = new Set();
  for (const file of files) {
    const dir = packageDir(file);
    if (dir) dirs.add(realpathSync(dir));
  }
  const packages = new Map();
  for (const dir of dirs) {
    const info = packageInfo(dir);
    packages.set(`${info.name}@${info.version}`, info);
  }
  return [...packages.values()].sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version));
}

/** The notices text: a package list, then each distinct license text once,
 * with the package files it came from. */
export function noticesText(title, intro, packages) {
  const texts = new Map();
  const lines = [title, "=".repeat(title.length), "", ...intro, ""];
  const missing = packages.filter((p) => !p.texts.length);
  lines.push(`Packages (${packages.length})`, "");
  for (const p of packages) {
    const refs = p.texts.map(({ name, text }) => {
      const key = createHash("sha256").update(text).digest("hex");
      if (!texts.has(key)) texts.set(key, { number: texts.size + 1, text, from: [] });
      const entry = texts.get(key);
      entry.from.push(`${p.name} ${p.version} ${name}`);
      return `[${entry.number}] ${name}`;
    });
    lines.push(`${p.name} ${p.version}`, `  License (as declared): ${p.license}`, `  Repository: ${p.repository}`,
      `  License texts: ${refs.length ? refs.join(", ") : "none shipped in the package"}`, "");
  }
  if (missing.length) {
    lines.push("These packages ship no license text; only their declared license is listed above:",
      ...missing.map((p) => `  ${p.name} ${p.version} (${p.license})`), "");
  }
  lines.push(`License texts (${texts.size})`, "");
  for (const { number, text, from } of texts.values())
    lines.push("-".repeat(78), `[${number}] from:`, ...from.map((source) => `  ${source}`), "", text.replace(/\s+$/, ""), "");
  return `${lines.join("\n")}\n`;
}
