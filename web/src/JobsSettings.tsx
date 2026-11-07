// Settings › Machines › Core host (T-55, YN-8 S3): this Core host's Job
// settings, which the Jobs card showed in place before. An SSH machine's are
// in its own editor, on its page. Read when shown and saved through Core's
// existing routes; Core's refusals are shown as they came.
import { useEffect, useRef, useState } from "react";
import { RefreshCw } from "lucide-react";
import { api, errorText } from "./api";
import { langTag, strings, useLanguage } from "./i18n";
import {
  BudgetSettings,
  DiskReserveSettings,
  GpuDeviceSettings,
  maxActiveOf,
  validBudget,
  WindowsJobsSettings,
  type JobsBudgetView,
} from "./JobBudget";
import "./jobs-settings.css";

const text = strings({
  hostTitle: "Core host budget",
  hostSection: "Core host Job budget",
  hostIntro: (name: string | null) =>
    `Managed jobs on this Core's host${name ? `, ${name}` : ""}: what they may reserve together, how many run at once, the disk space they leave free, Windows' ceiling and each GPU. The Jobs panel shows what they use now.`,
  readingHost: "Reading this host's budget…",
  updatedCore: "Local jobs require an updated Core.",
  readAgain: "Read again",
}, {
  hostTitle: "Core 主机预算",
  hostSection: "Core 主机 Job 预算",
  hostIntro: (name) =>
    `此 Core 主机${name ? ` ${name} ` : ""}上的托管 Job：它们合计可预留多少、同时运行多少个、保留多少磁盘空闲，以及 Windows 的上限和每个 GPU 的设置。Job 面板显示它们现在的用量。`,
  readingHost: "正在读取此主机的预算…",
  updatedCore: "本地 Job 需要更新的 Core。",
  readAgain: "重新读取",
});

/** This Core host's Job settings: its budget with how many Jobs run at once,
 * the disk reserve, Windows' ceiling and each GPU's admission and sharing.
 * Read when shown, and again after each save; a read again keeps what is
 * being typed unless Core's value changed. */
export function JobsBudgetEditor({ active }: { active: boolean }) {
  const language = useLanguage();
  const t = text(language);
  const [view, setView] = useState<JobsBudgetView | null>(null);
  const [error, setError] = useState("");
  const [reading, setReading] = useState(false);
  const generation = useRef(0);
  const read = (signal?: AbortSignal) => {
    const stamp = ++generation.current;
    setReading(true);
    return api<JobsBudgetView>("/jobs/budget", { signal })
      .then((next) => {
        if (stamp !== generation.current) return;
        if (!validBudget(next)) throw new Error(t.updatedCore);
        setView(next);
        setError("");
      })
      .catch((e: unknown) => {
        if (stamp === generation.current && !signal?.aborted) setError(errorText(e));
      })
      .finally(() => {
        if (stamp === generation.current) setReading(false);
      });
  };
  useEffect(() => {
    if (!active) return;
    const controller = new AbortController();
    void read(controller.signal);
    return () => {
      controller.abort();
      generation.current++;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);
  const refresh = () => void read();
  return (
    <section id="settings-jobs-budget" className="settings-section jobs-settings" aria-label={t.hostSection} lang={langTag(language)}>
      <header className="settings-section-heading">
        <div>
          <h3>{t.hostTitle}</h3>
          <p>{t.hostIntro(view?.machine.name ?? null)}</p>
        </div>
      </header>
      {!view && !error && <p className="settings-row-help" role="status">{t.readingHost}</p>}
      {view && (
        <>
          <BudgetSettings
            budget={view.budget}
            bounds={view.budgetBounds}
            host={view.machine}
            suggested={view.machine.suggestedBudget}
            collector={view.collectorOverhead}
            maxActive={maxActiveOf(view)}
            reserved={view.reserved}
            active={view.activeCount}
            onSaved={refresh}
          />
          {view.disk && <DiskReserveSettings disk={view.disk} onSaved={refresh} />}
          {view.windows?.available && <WindowsJobsSettings windows={view.windows} onSaved={refresh} />}
          {view.gpus && <GpuDeviceSettings gpus={view.gpus} onSaved={refresh} />}
        </>
      )}
      {error && (
        <div className="jobs-settings-read-error">
          <p className="inline-error" role="alert">
            {error}
          </p>
          <button type="button" className="quiet-button" disabled={reading} onClick={refresh}>
            <RefreshCw size={13} aria-hidden="true" />
            {t.readAgain}
          </button>
        </div>
      )}
    </section>
  );
}
