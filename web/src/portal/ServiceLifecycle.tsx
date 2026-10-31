import { useEffect, useRef, useState } from "react";
import { ArrowRight, Clock3, Globe, Hand, LoaderCircle, Play, RefreshCw, Server, Square, Activity } from "lucide-react";
import { api, errorText, HttpError, post } from "../api";
import { Modal } from "../components";
import { openJobs } from "../Jobs";
import { langTag, useLanguage, useStrings } from "../i18n";
import type { ProjectService } from "../ProjectServices";
import { useTimeDisplay } from "../time-preferences";
import { absolute } from "../home/format";
import { canStartService, controlReceiptMatches, controlRequest, serviceControlCurrent, serviceControlDraft, serviceIdle, userStoppedService, validServiceDuration, type ServiceControlDraft, type ServiceControlRequest } from "./service-lifecycle";
import { currentBrowserReach, endedServiceStatuses, serviceDeadline, validServiceTime, type ServiceBrowserReach } from "./service-observation";
import { serviceText } from "./service-text";
import "./service-lifecycle.css";

type Attempt = { draft: ServiceControlDraft; request: ServiceControlRequest; state: "sending" | "unknown" | "refused" | "recorded" };

/** Uses Core's service/Job facts, the client's proof, and a separate intent.
 * No poll, close action, time limit or UI state starts or stops a process. */
export function ServiceLifecycle({ service, browserReach, previewUrl = null, disconnected = false, readFailed = false, disabled = false, onRefresh, onDisconnect, onCheckPreview }: {
  service: ProjectService;
  browserReach?: ServiceBrowserReach;
  previewUrl?: string | null;
  disconnected?: boolean;
  readFailed?: boolean;
  disabled?: boolean;
  onRefresh: () => Promise<void>;
  onDisconnect?: () => Promise<void>;
  onCheckPreview?: () => Promise<void>;
}) {
  const t = useStrings(serviceText);
  const language = useLanguage();
  const time = useTimeDisplay();
  const job = service.job;
  const intent = service.lifecycle?.intent;
  const [confirmation, setConfirmation] = useState<ServiceControlDraft | null>(null);
  const [seconds, setSeconds] = useState(validServiceDuration(job?.timeoutSeconds) ? job.timeoutSeconds : 14400);
  const [attempt, setAttempt] = useState<Attempt | null>(null);
  const [actionError, setActionError] = useState("");
  const [notice, setNotice] = useState("");
  const [reading, setReading] = useState(false);
  const [showLogs, setShowLogs] = useState(false);
  const [log, setLog] = useState("");
  const [logError, setLogError] = useState("");
  const mounted = useRef(true);
  const busy = useRef(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    if (!showLogs || !job) return;
    let current = true;
    setLog(""); setLogError("");
    api<{ text: string }>(`/jobs/${encodeURIComponent(job.jobId)}/logs`).then(
      (value) => { if (current) setLog(value.text.split("\n").slice(-12).join("\n")); },
      (error) => { if (current) setLogError(errorText(error)); },
    );
    return () => { current = false; };
  }, [showLogs, job?.jobId]);
  useEffect(() => {
    if (!attempt || attempt.state === "sending") return;
    const recorded = service.lifecycle?.intent;
    // Once Core records another choice, the note about this one is history.
    if (attempt.state === "recorded") {
      if (recorded && recorded.requestId !== attempt.request.requestId) { setAttempt(null); setNotice(""); }
      return;
    }
    if (recorded?.requestId !== attempt.request.requestId || recorded.revision !== attempt.draft.expectedIntentRevision + 1) return;
    setAttempt({ ...attempt, state: "recorded" });
    setConfirmation(null); setActionError(""); setNotice(t.sent);
  }, [service, attempt]);
  if (!job || !service.lifecycle) return null;

  const ended = endedServiceStatuses.has(job.status);
  const stoppingIntent = intent?.desiredState === "stopped" && intent.appliesToJobId === job.jobId;
  const stoppedByUser = userStoppedService(service);
  const reach = disconnected ? { state: "notChecked" as const } : currentBrowserReach(browserReach, job.jobId, previewUrl);
  // A check of this browser's connection belongs to a live run. Once none
  // is, an earlier check is history, and it never confirms whose process
  // answers.
  const idle = serviceIdle(service);
  const browser = disconnected ? { label: t.disconnected, note: "", state: "notChecked" }
    : idle && idle !== "unknown" ? { label: t.browserIdle, state: "notChecked",
      note: idle === "queued" ? t.browserAfterReady : idle === "stopping" ? t.browserNotExit : t.browserAfterRun }
    : { label: ({ checking: t.checking, proven: t.connected, unproven: t.unreachable, notChecked: t.notChecked })[reach.state], state: reach.state,
      note: [validServiceTime(reach.checkedAt) ? t.observedAt(absolute(reach.checkedAt, time)) : t.timeUnknown,
        idle === "unknown" && reach.state === "proven" ? t.browserNotOwner : ""].filter(Boolean).join(" · ") };
  const expired = ended && (job.resultReason === "timeout" || job.reason === "timeout");
  const headline = job.status === "unknown" ? t.unknown
    : job.status === "cancelling" || (!ended && stoppingIntent) ? t.stopping
    : job.status === "cancelled" && stoppedByUser ? t.userStopped
    : expired ? t.expired
    : job.status === "failed" ? t.failed
    : job.status === "interrupted" ? t.interrupted
    : job.status === "rejected" ? t.notStarted
    : ended ? t.stopped
    : job.status === "running" ? (job.owner === "verified" && reach.state === "proven" ? t.ready : t.running)
    : t.queued;
  const deadline = serviceDeadline(job.startedAt, job.timeoutSeconds);
  const stateName = t.processStates[job.status] || job.status;
  const reason = job.status === "unknown" ? t.noDuplicate : job.reason || t.closeNote;
  const health = service.health;
  const healthTime = health?.declared && validServiceTime(health.checkedAt) ? absolute(health.checkedAt, time) : null;
  const terminalHealth = ended || job.status !== "running" || job.owner !== "verified";
  const ownerText = ({ verified: t.verified, otherProcess: t.otherProcess, notListening: t.notListening, unknown: t.ownerUnknown } as Record<string, string>)[job.owner] || t.ownerUnknown;
  const locked = attempt?.state === "sending" || attempt?.state === "unknown";
  const stale = !!confirmation && !serviceControlCurrent(service, confirmation);
  const allowed = !!confirmation && (confirmation.action === "start" ? canStartService(service) : job.canStop);
  const refused = attempt?.state === "refused";
  const currentTimeout = validServiceDuration(job.timeoutSeconds) ? job.timeoutSeconds : null;
  const durations = [...new Set([3600, 14400, 86400, ...(currentTimeout ? [currentTimeout] : []), seconds])].filter(validServiceDuration);
  const showDate = (at?: string | null) => validServiceTime(at) ? absolute(at, time) : t.timeUnknown;

  const refresh = async () => {
    if (reading) return;
    setReading(true);
    // A failed read is said by readFailed, and the next one clears it.
    try { await onRefresh(); } catch { /* readFailed */ }
    finally { if (mounted.current) setReading(false); }
  };
  const open = (action: "start" | "stop") => {
    if (disabled || readFailed || locked) return;
    const draft = serviceControlDraft(service, action);
    if (!draft) return;
    setConfirmation(draft);
    setAttempt(null); setActionError(""); setNotice("");
  };
  const submit = async (retry = false) => {
    if (busy.current || disabled) return;
    const previous = retry && attempt?.state === "unknown" ? attempt : null;
    const draft = previous?.draft || confirmation;
    if (!draft) return;
    // Retrying repeats one immutable request. A new action requires the
    // exact run and revision the user saw when opening its confirmation.
    if (!previous && (readFailed || !serviceControlCurrent(service, draft) || !(draft.action === "start" ? canStartService(service) : job.canStop))) {
      setActionError(t.actionChanged); return;
    }
    const request = previous?.request || controlRequest(draft, crypto.randomUUID(), seconds);
    busy.current = true;
    setAttempt({ draft, request, state: "sending" }); setActionError(""); setNotice("");
    let recorded = false;
    try {
      const receipt = await post<unknown>(`/services/${encodeURIComponent(draft.serviceId)}/${draft.action}`, request);
      if (!controlReceiptMatches(receipt, draft, request)) throw new Error(t.noResult);
      recorded = true;
      if (!mounted.current) return;
      setAttempt({ draft, request, state: "recorded" }); setConfirmation(null); setNotice(t.sent);
      // An idempotent reply is the receipt then, not today's run state.
      await onRefresh();
    } catch (error) {
      if (!mounted.current) return;
      if (recorded) {
        // A failed read after a confirmed mutation does not make that
        // mutation unconfirmed and must not offer to submit it again.
        setActionError(errorText(error));
        return;
      }
      const definitelyRefused = error instanceof HttpError && /\b(stale_service_state|source_unavailable|guarded_inputs_changed|service_busy)\b/.test(error.message);
      // A request-id conflict can concern an earlier, executed request.
      // Network/unknown failures keep the same id and body for explicit retry.
      setAttempt({ draft, request, state: definitelyRefused ? "refused" : "unknown" });
      setActionError(errorText(error));
    } finally { busy.current = false; }
  };
  const reviewCurrent = () => {
    if (!confirmation || locked || readFailed) return;
    const next = serviceControlDraft(service, confirmation.action);
    if (!next) { setActionError(t.notAvailable); return; }
    setConfirmation(next); setAttempt(null); setActionError("");
  };

  return <section className="portal-job portal-lifecycle" aria-label={t.title} data-service-id={service.id} data-job-id={job.jobId}>
    <header className="service-lifecycle-head">
      <span className={`service-lifecycle-mark state-${job.status}`}><Server size={18} /></span>
      <div className="service-lifecycle-heading"><h3>{headline}</h3><p title={reason}>{reason}</p></div>
      <div className="service-lifecycle-deadline"><Clock3 size={14} /><span>{ended
        ? <><small>{t.endedAt}</small><strong>{validServiceTime(job.finishedAt) ? absolute(job.finishedAt, time) : t.timeUnknown}</strong></>
        : <><small>{t.due}</small><strong>{deadline ? absolute(deadline, time) : currentTimeout && !job.startedAt ? t.durationFromStart(currentTimeout) : t.dueUnknown}</strong></>}</span></div>
    </header>
    {stoppingIntent && <p className="service-intent"><Hand size={13} />{stoppedByUser ? t.stoppedIntent : t.otherStopIntent}</p>}
    {readFailed && <p className="inline-error service-read-failed" role="status">{t.readFailed}</p>}
    <div className="portal-states service-lifecycle-facts">
      <div className="portal-fact" data-state={job.status} data-fact="process"><span className="service-fact-icon"><Server size={15} /></span><div><small>{t.process}</small><b>{stateName}</b><em>{ownerText}</em><em>{validServiceTime(job.ownerCheckedAt) ? t.observedAt(showDate(job.ownerCheckedAt)) : t.timeUnknown}</em></div></div>
      <div className="portal-fact" data-state={health?.declared ? health.state : "unset"} data-fact="health"><span className="service-fact-icon"><Activity size={15} /></span><div><small>{t.health}</small><b>{health?.declared ? ({ ok: t.healthy, failing: t.unhealthy, unknown: t.healthUnknown })[health.state] : t.healthNotSet}</b><em>{health?.declared && [terminalHealth && healthTime ? t.healthPast : "", health.path, health.httpStatus ? `HTTP ${health.httpStatus}` : "", healthTime || t.timeUnknown].filter(Boolean).join(" · ")}</em></div></div>
      <div className="portal-fact" data-state={browser.state} data-fact="browser"><span className="service-fact-icon"><Globe size={15} /></span><div><small>{t.browser}</small><b>{browser.label}</b>{browser.note && <em>{browser.note}</em>}</div></div>
    </div>
    <div className="service-lifecycle-actions"><span className="service-manual"><Hand size={13} />{t.manual}</span><button className="quiet-button" type="button" disabled={reading} onClick={() => void refresh()}>{reading ? <LoaderCircle className="spin" size={13} /> : <RefreshCw size={13} />}{t.refresh}</button><button className="quiet-button" type="button" onClick={() => openJobs({ jobId: job.jobId })}>{t.jobs}<ArrowRight size={13} /></button>{job.canStop && job.status !== "unknown" && <button className="quiet-button service-stop" type="button" disabled={disabled || readFailed || locked} onClick={() => open("stop")}><Square size={12} />{t.stop}</button>}{canStartService(service) && <button className="primary-button service-start" type="button" disabled={disabled || readFailed || locked} onClick={() => open("start")}><Play size={13} />{t.start}</button>}</div>
    {notice && <p className="service-action-note" role="status">{notice}</p>}
    {actionError && !confirmation && <p className="inline-error" role="alert">{actionError}</p>}
    {attempt?.state === "unknown" && !confirmation && <div className="service-action-note" role="status"><p>{t.noResult}</p><button type="button" className="secondary-button" disabled={disabled} onClick={() => void submit(true)}>{t.retrySame}</button></div>}
    <details className="service-lifecycle-details"><summary>{t.details}</summary><dl><dt>{t.job}</dt><dd><code>{job.jobId}</code>{job.attempt && <> · <code>{job.attempt}</code></>}</dd><dt>{t.location}</dt><dd>{service.machineId} · {service.port}{service.path}</dd><dt>{t.recovery}</dt><dd>{t.manualOnly}</dd><dt>{t.due}</dt><dd>{deadline ? absolute(deadline, time) : t.dueUnknown}<small>{t.deadlineOnly}</small></dd><dt>{t.connectionCheck}</dt><dd>{service.connection.state} · {showDate(service.connection.since)}{service.connection.httpStatus ? ` · HTTP ${service.connection.httpStatus}` : ""}</dd>{job.reason && <><dt>{stateName}</dt><dd>{job.reason}</dd></>}{!service.lifecycle.canStart && service.lifecycle.startBlockedReason && <><dt>{t.start}</dt><dd>{service.lifecycle.startBlockedReason}</dd></>}</dl><div className="portal-actions"><button type="button" className="quiet-button" aria-expanded={showLogs} onClick={() => setShowLogs((value) => !value)}>{t.logs}</button>{onDisconnect && !disconnected && <button className="quiet-button" type="button" disabled={disabled} onClick={() => { void onDisconnect().catch((error) => setActionError(errorText(error))); }}>{t.disconnect}</button>}{onCheckPreview && <button type="button" className="quiet-button" disabled={disabled || readFailed || reading} onClick={() => { void onCheckPreview().catch((error) => setActionError(errorText(error))); }}>{t.previewCheck}</button>}</div>{showLogs && <pre className="portal-logs">{logError || log}</pre>}</details>
    <Modal open={!!confirmation} onOpenChange={(openNow) => { if (!openNow) setConfirmation(null); }} title={confirmation?.action === "start" ? t.startTitle : t.stopTitle} description={confirmation?.action === "start" ? t.startNote : t.stopNote} className="service-control-dialog" lang={langTag(language)}>
      {confirmation && <div onKeyDown={(event) => { if (event.key === "Escape") event.stopPropagation(); }}>
        <p className="service-control-name">{confirmation.serviceName}</p><p className="service-control-reference"><span>{t.job}</span> <code>{confirmation.expectedJobId}</code></p>
        {confirmation.action === "start" && <fieldset disabled={locked}><legend>{t.lifetime}</legend><div className="service-lifetime-options">{durations.map((value) => <label key={value}><input type="radio" name="service-lifetime" value={value} checked={seconds === value} onChange={() => setSeconds(value)} /><span>{value === 3600 ? t.oneHour : value === 14400 ? t.fourHours : value === 86400 ? t.oneDay : t.currentDuration(value)}</span></label>)}</div></fieldset>}
        <div className="service-control-rule"><Hand size={15} /><p>{confirmation.action === "start" ? t.manualNote : t.keepStopped}</p></div>
        {(stale || refused || !allowed) && <p className="inline-error" role="status">{stale || refused ? t.actionChanged : t.notAvailable}</p>}
        {actionError && <p className="inline-error" role="alert">{actionError}</p>}
        {attempt?.state === "unknown" && <p className="service-action-note" role="status">{t.noResult}</p>}
        <div className="modal-actions"><button className="quiet-button" type="button" disabled={reading} onClick={() => void refresh()}>{t.refresh}</button>{(stale || refused) && <button className="secondary-button" type="button" disabled={locked || readFailed || reading} onClick={reviewCurrent}>{t.staleChoice}</button>}<button className="secondary-button" type="button" onClick={() => setConfirmation(null)}>{confirmation.action === "stop" ? t.stopKeep : t.cancel}</button>{attempt?.state === "unknown" ? <button className="primary-button" type="button" disabled={disabled} onClick={() => void submit(true)}>{t.retrySame}</button> : <button className={confirmation.action === "stop" ? "danger-button" : "primary-button"} type="button" disabled={disabled || readFailed || stale || refused || !allowed || locked || reading} onClick={() => void submit()}>{attempt?.state === "sending" ? t.submitting : confirmation.action === "start" ? t.startConfirm : t.stopConfirm}</button>}</div>
      </div>}
    </Modal>
  </section>;
}
