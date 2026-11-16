// A machine's Job environment (YN-194): variables every managed Job on that
// machine gets, as the user writes them, one NAME=value a line. Core merges
// them under each new Job's own env (core/src/jobs/machine_env.rs); nothing
// here guesses a path. On a page with a save bar the change joins it.
import { useEffect, useId, useRef, useState } from "react";
import { api, errorText, post } from "./api";
import { strings, useStrings } from "./i18n";
import { useSaveBarPart } from "./SettingsSaveBar";
import "./job-env.css";

type Saved = { env: Record<string, string>; updatedAt: string };
export type MachineEnvView = {
  machines: Record<string, Saved>;
  defaults: { PATH: string; LANG: string };
};

const text = strings(
  {
    title: "Job environment",
    windowsTitle: "Windows Job environment",
    intro: "Every managed Job on this machine gets these variables. A variable the Job gives itself wins. One NAME=value a line; empty leaves Jobs as they are.",
    defaults: (path: string, lang: string) =>
      `Core's defaults where this sets none: PATH=${path} and LANG=${lang}. A PATH here replaces the default whole; $PATH is not expanded. Names starting with YUZUNO_ are Core's own.`,
    windowsDefaults: "Windows' own environment is kept; a variable here replaces the one of the same name. Names starting with YUZUNO_ are Core's own.",
    caution: "These values are written into every Job's record, which Agents that read Jobs see: never put a key or token here.",
    reading: "Reading the Job environment…",
    badLine: (n: number) => `Line ${n} is not NAME=value.`,
    twice: (name: string) => `${name} is set twice.`,
    save: "Save",
    saved: "Saved. Jobs created from now on get it.",
    unsaved: "Not saved yet.",
  },
  {
    title: "Job 环境",
    windowsTitle: "Windows Job 环境",
    intro: "这台机器上的每个托管 Job 都会带上这些变量；Job 自己给的同名变量优先。每行一个 名称=值；留空则 Job 和现在一样。",
    defaults: (path, lang) =>
      `这里没写时用 Core 的默认值：PATH=${path}、LANG=${lang}。这里写了 PATH 就整个替换默认值，不展开 $PATH。以 YUZUNO_ 开头的名字由 Core 设置。`,
    windowsDefaults: "保留 Windows 自己的环境；这里的变量会替换同名的那个。以 YUZUNO_ 开头的名字由 Core 设置。",
    caution: "这些值会写进每个 Job 的记录，能读 Job 的 Agent 都看得到：不要放密钥或令牌。",
    reading: "正在读取 Job 环境…",
    badLine: (n) => `第 ${n} 行不是 名称=值。`,
    twice: (name) => `${name} 写了两次。`,
    save: "保存",
    saved: "已保存。之后新建的 Job 会带上它。",
    unsaved: "尚未保存。",
  },
);

/** The saved variables as the field shows them: one NAME=value a line. */
export const envText = (env: Record<string, string>) =>
  Object.entries(env)
    .map(([name, value]) => `${name}=${value}`)
    .join("\n");

/** The field's lines as variables, or the first line that is not one.
 * Blank lines are skipped; everything after the first = is the value. */
export function parseEnv(
  value: string,
  t: { badLine: (n: number) => string; twice: (name: string) => string },
): { env: Record<string, string> } | { problem: string } {
  const env: Record<string, string> = {};
  const lines = value.split("\n");
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index].replace(/\r$/, "");
    if (!line.trim()) continue;
    const at = line.indexOf("=");
    const name = at > 0 ? line.slice(0, at).trim() : "";
    if (!name) return { problem: t.badLine(index + 1) };
    if (name in env) return { problem: t.twice(name) };
    env[name] = line.slice(at + 1);
  }
  return { env };
}

/** One machine's Job environment: `local` (this Core's host), `windows`, or
 * a registered machine's ID. Read when shown; saved whole. */
export function JobEnvSettings({ machine, windows = false }: { machine: string; windows?: boolean }) {
  const t = useStrings(text);
  const id = useId();
  const [view, setView] = useState<MachineEnvView | null>(null);
  const [value, setValue] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const live = useRef(true);
  const saved = view ? envText(view.machines[machine]?.env ?? {}) : "";
  const read = () =>
    api<MachineEnvView>("/jobs/machine-env")
      .then((answer) => {
        if (!live.current) return;
        // Whatever Core left out reads as nothing saved, with its own defaults.
        const next = { machines: answer?.machines ?? {}, defaults: answer?.defaults ?? { PATH: "", LANG: "" } };
        setView(next);
        setValue(envText(next.machines[machine]?.env ?? {}));
      })
      .catch((e: unknown) => live.current && setError(errorText(e)));
  useEffect(() => {
    live.current = true;
    void read();
    return () => {
      live.current = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [machine]);
  const parsed = parseEnv(value, t);
  const save = async (): Promise<boolean> => {
    if ("problem" in parsed) {
      setError(parsed.problem);
      return false;
    }
    setBusy(true);
    setError("");
    setDone(false);
    try {
      await post("/jobs/machine-env", { machine, env: parsed.env });
      setDone(true);
      await read();
      return true;
    } catch (e) {
      // What was typed stays, so it can be corrected and saved again.
      setError(errorText(e));
      return false;
    } finally {
      setBusy(false);
    }
  };
  const changed = !!view && value !== saved;
  const inBar = useSaveBarPart(`jobs-env-${machine}`, changed ? { save, discard: () => { setError(""); setValue(saved); } } : null);
  const title = windows ? t.windowsTitle : t.title;
  return (
    <form
      className="settings-group job-env-settings"
      aria-label={title}
      onSubmit={(e) => {
        e.preventDefault();
        if (!inBar) void save();
      }}
    >
      <label className="job-env-label" htmlFor={id}>
        {title}
      </label>
      <p className="settings-row-help">{t.intro}</p>
      {!view && !error && <p className="settings-row-help" role="status">{t.reading}</p>}
      {view && (
        <>
          <textarea
            id={id}
            name={`job-env-${machine}`}
            className="job-env-field"
            rows={4}
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            placeholder={windows ? "CARGO_HOME=C:\\Users\\example\\.cargo" : "HOME=/home/example"}
            value={value}
            disabled={busy}
            onChange={(e) => {
              setDone(false);
              setError("");
              setValue(e.target.value);
            }}
          />
          <p className="settings-row-help">
            {windows ? t.windowsDefaults : t.defaults(view.defaults.PATH, view.defaults.LANG)}
          </p>
          <p className="job-env-caution">{t.caution}</p>
        </>
      )}
      <div className="job-env-actions">
        {view && !inBar && (
          <button className="secondary-button" disabled={busy || !changed}>
            {t.save}
          </button>
        )}
        {error ? (
          <p className="inline-error" role="alert">
            {error}
          </p>
        ) : done ? (
          <span className="settings-row-help" role="status">
            {t.saved}
          </span>
        ) : changed && !inBar ? (
          <span className="settings-row-help">{t.unsaved}</span>
        ) : null}
      </div>
    </form>
  );
}
