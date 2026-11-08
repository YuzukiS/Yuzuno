// An OpenCode Agent's model, chosen from what its OpenCode lists (YN-47, the
// user's choice A on design/yn47-model-picker): one list in the dialog,
// grouped by provider, logged-in providers first and OpenCode's own last,
// with a search that also takes a `provider/model` the list lacks and says
// why OpenCode can't run it. Native radios in one group underneath, as
// ChoiceChips has them: arrow keys move between models, and forms and screen
// readers see one value.
import { useId, useState, type ReactNode } from "react";
import { Image as ImageIcon, LoaderCircle, Search } from "lucide-react";
import { strings, useLanguage } from "./i18n";
import type { Model, OpenCodeProvider } from "./types";
import "./opencode-model-picker.css";

const text = strings({
  model: "Model",
  saved: "Saved",
  savedDefault: "OpenCode default",
  search: (count: number) => `Search ${count} models, or type provider/model`,
  harnessDefault: "OpenCode default",
  defaultNote: "its own config decides",
  credential: "Logged in",
  env: "From the environment",
  ready: "No login needed",
  image: "Reads images",
  loading: "Loading this agent’s model catalog…",
  notListed: "OpenCode doesn’t list it now",
  current: "current",
  none: (query: string) => `No model matches “${query}”.`,
  unlisted: (id: string, provider: string, name: string): ReactNode => <>OpenCode doesn’t list <code>{id}</code>, so it can’t run it: it would answer “Model unavailable”. Add <code>{name}</code> to <code>{`provider.${provider}.models`}</code> in your OpenCode config, then open these settings again.</>,
  noProvider: (provider: string): ReactNode => <>OpenCode has no provider <code>{provider}</code>. Log in to it below, or add it to your OpenCode config.</>,
  loginHint: "Log in to a provider below to choose its models.",
}, {
  model: "模型",
  saved: "已保存",
  savedDefault: "OpenCode 默认",
  search: (count) => `搜索 ${count} 个模型，或输入 提供方/模型`,
  harnessDefault: "OpenCode 默认",
  defaultNote: "由它自己的配置决定",
  credential: "已登录",
  env: "来自环境变量",
  ready: "无需登录",
  image: "能读图片",
  loading: "正在读取这个 Agent 的模型目录…",
  notListed: "OpenCode 现在没有列出它",
  current: "当前",
  none: (query) => `没有匹配“${query}”的模型。`,
  unlisted: (id, provider, name) => <>OpenCode 没有列出 <code>{id}</code>，所以不能用它运行：它会回答 “Model unavailable”。请在你的 OpenCode 配置的 <code>{`provider.${provider}.models`}</code> 里加上 <code>{name}</code>，再重新打开设置。</>,
  noProvider: (provider) => <>OpenCode 没有名为 <code>{provider}</code> 的提供方。请在下面登录它，或把它加进你的 OpenCode 配置。</>,
  loginHint: "在下面登录一个提供方，就能选它的模型。",
});

/** A model's value, provider and names, from Core's fields; a catalog without them (an older Core's) gives its id and
 * displayName ("Provider · Model") instead. */
export function described(m: Model) {
  const value = m.model || m.id;
  const [shownProvider, ...rest] = m.displayName.split(" · ");
  return {
    value,
    provider: m.providerId || value.split("/")[0],
    providerName: m.providerName || shownProvider,
    name: m.name || rest.join(" · ") || m.displayName,
  };
}

/** A context window as a few characters: 1M, 200K. */
const windowSize = (tokens: number) => tokens >= 1_000_000 ? `${+(tokens / 1_000_000).toFixed(1)}M`
  : tokens >= 1000 ? `${Math.round(tokens / 1000)}K` : String(tokens);

type Group = { id: string; name: string; source: OpenCodeProvider["source"]; models: Model[] };

/** Providers by where their access comes from: a login, then an environment variable, then the rest, OpenCode's own
 * (its free models) last; by name within each. Models stay in Core's order. */
function grouped(models: Model[], providers: OpenCodeProvider[] | undefined): Group[] {
  const groups = new Map<string, Group>();
  for (const m of models) {
    const d = described(m);
    const group = groups.get(d.provider) ?? { id: d.provider, name: d.providerName,
      source: providers?.find((p) => p.id === d.provider)?.source ?? null, models: [] };
    group.models.push(m);
    groups.set(d.provider, group);
  }
  const rank = (g: Group) => [g.source === "credential" ? 0 : g.source === "env" ? 1 : 2, g.id === "opencode" ? 1 : 0] as const;
  return [...groups.values()].sort((a, b) => {
    const [x, y] = [rank(a), rank(b)];
    return x[0] - y[0] || x[1] - y[1] || a.name.localeCompare(b.name);
  });
}

/** Where `query` first appears in `value`, marked. */
function marked(value: string, query: string): ReactNode {
  const at = query ? value.toLowerCase().indexOf(query.toLowerCase()) : -1;
  if (at < 0) return value;
  return <>{value.slice(0, at)}<mark>{value.slice(at, at + query.length)}</mark>{value.slice(at + query.length)}</>;
}

export function OpenCodeModelPicker({
  models,
  providers,
  value,
  saved,
  savedVariant,
  loading,
  disabled,
  onChange,
}: {
  models: Model[];
  providers?: OpenCodeProvider[];
  /** The model chosen in the dialog; "" for OpenCode's default. */
  value: string;
  /** The model and variant saved for the Agent. */
  saved: string;
  savedVariant: string | null;
  loading: boolean;
  disabled: boolean;
  onChange: (value: string) => void;
}) {
  const t = text(useLanguage());
  const name = `opencode-model-${useId()}`;
  const [query, setQuery] = useState("");
  const asked = query.trim();
  const lower = asked.toLowerCase();
  const groups = grouped(models, providers);
  const matches = (m: Model) => {
    if (!asked) return true;
    const d = described(m);
    return [d.providerName, d.name, d.value].some((s) => s.toLowerCase().includes(lower));
  };
  const shown = groups.map((g) => ({ ...g, models: g.models.filter(matches) })).filter((g) => g.models.length > 0);
  const listed = (id: string) => models.some((m) => described(m).value === id);
  const defaultShown = !asked || t.harnessDefault.toLowerCase().includes(lower);
  // A typed `provider/model` OpenCode doesn't list: OpenCode would take it for a session and fail its run.
  const typed = /^[^\s/]+\/\S+$/.test(asked) && !loading && !listed(asked) ? asked : "";
  const typedProvider = typed.split("/")[0];
  const knownProvider = groups.some((g) => g.id === typedProvider);
  // The model chosen and not listed stays shown, first: while the catalog loads, or once it no longer lists it.
  const orphan = !!value && !listed(value);
  const savedRow = models.find((m) => described(m).value === saved);
  const savedName = saved ? (savedRow ? `${described(savedRow).providerName} · ${described(savedRow).name}` : saved) : t.savedDefault;
  // With sources read and nothing logged in, the login below is how a provider's models arrive.
  const noLogin = !!providers?.length && !providers.some((p) => p.source === "credential" || p.source === "env");
  const row = (m: Model) => {
    const d = described(m);
    return (
      <label key={d.value} className="opencode-model-row" data-value={d.value}>
        <input type="radio" name={name} value={d.value} checked={value === d.value} onChange={() => onChange(d.value)} />
        <span className="opencode-model-dot" aria-hidden="true" />
        <span className="opencode-model-main">
          <span className="opencode-model-name" lang="">{marked(d.name, asked)}</span>
          <span className="opencode-model-id" lang="">{marked(d.value, asked)}</span>
        </span>
        <span className="opencode-model-facts">
          {m.status && m.status !== "active" && <span className="opencode-model-status" lang="">{m.status}</span>}
          {m.image && <span title={t.image} aria-label={t.image} role="img"><ImageIcon size={13} /></span>}
          {typeof m.context === "number" && m.context > 0 && <span>{windowSize(m.context)}</span>}
        </span>
      </label>
    );
  };
  return (
    <fieldset className="opencode-model-picker" disabled={disabled}>
      <legend>
        <span>{t.model}</span>
        <span className="opencode-model-saved">{t.saved}: <b lang="">{savedName}</b>{savedVariant ? <> · <span lang="">{savedVariant}</span></> : null}</span>
      </legend>
      <div className="opencode-model-search">
        <Search size={15} aria-hidden="true" />
        <input type="search" value={query} placeholder={t.search(models.length)} aria-label={t.search(models.length)}
          autoComplete="off" spellCheck={false} onChange={(e) => setQuery(e.target.value)}
          // Enter in the search must not submit the settings form, which saves.
          onKeyDown={(e) => { if (e.key === "Enter") e.preventDefault(); }} />
      </div>
      <div className="opencode-model-list" role="radiogroup" aria-label={t.model}>
        {orphan && (
          <label className="opencode-model-row opencode-model-orphan" data-value={value}>
            <input type="radio" name={name} value={value} checked onChange={() => onChange(value)} />
            <span className="opencode-model-dot" aria-hidden="true" />
            <span className="opencode-model-main">
              <span className="opencode-model-name" lang="">{value}</span>
              <span className="opencode-model-sub">{loading ? t.current : t.notListed}</span>
            </span>
            <span className="opencode-model-facts" />
          </label>
        )}
        {defaultShown && (
          <label className="opencode-model-row" data-value="">
            <input type="radio" name={name} value="" checked={value === ""} onChange={() => onChange("")} />
            <span className="opencode-model-dot" aria-hidden="true" />
            <span className="opencode-model-main">
              <span className="opencode-model-name">{marked(t.harnessDefault, asked)}</span>
              <span className="opencode-model-sub">{t.defaultNote}</span>
            </span>
            <span className="opencode-model-facts" />
          </label>
        )}
        {shown.map((g) => (
          <div key={g.id} className="opencode-model-group" role="group" aria-label={g.name}>
            <div className="opencode-model-group-head">
              <span className="opencode-model-provider" lang="">{g.name}</span>
              {g.source && <span className={`opencode-model-source ${g.source}`}>{t[g.source]}</span>}
              <span className="opencode-model-count">{g.models.length}</span>
            </div>
            {g.models.map(row)}
          </div>
        ))}
        {loading && (
          <p className="opencode-model-status-line" role="status"><LoaderCircle size={14} className="spin" /> {t.loading}</p>
        )}
        {typed && (
          <p className="opencode-model-unlisted" role="status">
            {knownProvider ? t.unlisted(typed, typedProvider, typed.slice(typedProvider.length + 1)) : t.noProvider(typedProvider)}
          </p>
        )}
        {asked && !typed && !loading && !shown.length && !defaultShown && (
          <p className="opencode-model-empty" role="status">{t.none(asked)}</p>
        )}
        {noLogin && !asked && !loading && <p className="opencode-model-login-hint">{t.loginHint}</p>}
      </div>
    </fieldset>
  );
}
