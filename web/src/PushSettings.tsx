import { useEffect, useRef, useState } from "react";
import { errorText, HttpError } from "./api";
import { strings, useLanguage } from "./i18n";
import type { NotificationPrefs } from "./notification-prefs";
import {
  browserPushHost,
  chosenPushKinds,
  corePushes,
  deviceSubscription,
  disablePush,
  enablePush,
  pushState,
  pushSupport,
  updatePushKinds,
  type PushHost,
  type PushState,
} from "./push-client";

// The settings' own words (T-189); what a push says is Core's (T-200).
const text = strings({
  title: "Push notifications on this device",
  on: "On",
  off: "Off",
  help: {
    available: "While Yuzuno is closed: an Agent needs you, or a Turn ends, as chosen below. Only who and why, never what was written. Turning this on asks iOS first. Other devices keep their own.",
    active: "On for this device, for what you choose below. Other devices keep their own.",
    "home-screen": "Push notifications come to the Yuzuno app on your Home Screen. In Safari, tap Share, then Add to Home Screen; open Yuzuno from there and turn this on.",
    "iphone-only": "Only in the Yuzuno app on an iPhone or iPad Home Screen.",
    insecure: "Only from a secure page: an https:// address.",
    oldCore: "This Core can’t send push notifications. A newer Core can.",
    denied: "iOS doesn’t allow Yuzuno’s notifications. To allow them: Settings → Notifications → Yuzuno, then turn this on here.",
  },
  stopped: (reason?: string | null) => `Stopped${reason ? `: ${reason}` : ""}. Core no longer sends to this device; turn it on again to subscribe again.`,
  forgotten: "Core has no subscription for this device. Turn it on again to subscribe again.",
  unsupportedService: "Core accepts push notifications only through Apple’s push service, which this device didn’t use.",
  failed: (message: string) => `Couldn’t change it: ${message}`,
}, {
  title: "此设备上的推送通知",
  on: "开",
  off: "关",
  help: {
    available: "Yuzuno 关闭时：有 Agent 需要你，或 Turn 结束，按下方的选择。只写是谁、为什么，从不写内容。开启时会先询问 iOS。其他设备各自设置。",
    active: "此设备已开启，按下方的选择通知。其他设备各自设置。",
    "home-screen": "推送通知发到主屏幕上的 Yuzuno App。在 Safari 中点“共享”，再点“添加到主屏幕”；从那里打开 Yuzuno 后在这里开启。",
    "iphone-only": "仅限 iPhone 或 iPad 主屏幕上的 Yuzuno App。",
    insecure: "仅限安全页面：https:// 地址。",
    oldCore: "此 Core 不能发送推送通知。更新的 Core 可以。",
    denied: "iOS 不允许 Yuzuno 的通知。要允许：设置 → 通知 → Yuzuno，然后回到这里开启。",
  },
  stopped: (reason?: string | null) => `已停止${reason ? `：${reason}` : ""}。Core 不再向此设备发送；重新开启即可重新订阅。`,
  forgotten: "Core 没有此设备的订阅。重新开启即可重新订阅。",
  unsupportedService: "Core 只接受通过 Apple 推送服务的推送通知，而此设备没有使用它。",
  failed: (message: string) => `没能更改：${message}`,
});

type Device = { subscription: PushSubscription | null; state: PushState | null };

/** The one switch for push on this device (T-200), and what Core says of it.
 * Nothing is asked, registered or created before the switch is turned on. */
export function PushSettings({ prefs, host = browserPushHost() }: { prefs: NotificationPrefs; host?: PushHost }) {
  const t = text(useLanguage());
  const support = pushSupport(host);
  const [core, setCore] = useState<boolean | null>(null);
  const [device, setDevice] = useState<Device>({ subscription: null, state: null });
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const kinds = chosenPushKinds(prefs);
  const kindsKey = kinds.join(",");
  const sent = useRef<string | null>(null);

  // What this Core and this device have now: read when Settings opens.
  useEffect(() => {
    if (support !== "available") return;
    let live = true;
    void (async () => {
      try {
        const pushes = await corePushes();
        if (!live) return;
        setCore(pushes);
        const subscription = pushes ? await deviceSubscription(host) : null;
        const state = subscription ? await pushState(subscription) : null;
        if (!live) return;
        setDevice({ subscription, state });
        if (state?.state === "active") sent.current = state.kinds.join(",");
      } catch (error) {
        if (live) setProblem(t.failed(errorText(error)));
      }
    })();
    return () => { live = false; };
  }, [support]);

  const active = device.subscription && device.state?.state === "active";
  // Changing what to be notified about tells Core, for this subscription.
  useEffect(() => {
    if (!active || !device.subscription || sent.current === kindsKey) return;
    sent.current = kindsKey;
    void updatePushKinds(device.subscription, kinds)
      .then((state) => setDevice((now) => ({ ...now, state })))
      .catch((error) => setProblem(t.failed(errorText(error))));
  }, [active, kindsKey]);

  const turn = async (on: boolean) => {
    setBusy(true);
    setProblem(null);
    try {
      if (on) {
        // A subscription Core stopped sending to (or forgot) is dropped
        // after iOS answers: a new one starts clean.
        const stale = device.subscription && device.state?.state !== "active" ? device.subscription : null;
        const { permission, state } = await enablePush(host, kinds, stale);
        if (permission !== "granted") return;
        sent.current = kindsKey;
        setDevice({ subscription: await deviceSubscription(host), state: state ?? null });
      } else if (device.subscription) {
        await disablePush(device.subscription);
        sent.current = null;
        setDevice({ subscription: null, state: null });
      }
    } catch (error) {
      setProblem(error instanceof HttpError && error.code === "push_service_unsupported" ? t.unsupportedService : t.failed(errorText(error)));
    } finally {
      setBusy(false);
    }
  };

  const denied = host.Notification?.permission === "denied";
  // Refused in iOS, it can't be turned on; but a subscription Core still
  // holds can always be turned off from here (off needs no permission).
  const usable = support === "available" && core === true && (!denied || !!active);
  const help = support !== "available" ? t.help[support]
    : core === false ? t.help.oldCore
      : denied ? t.help.denied
        : device.state?.state === "expired" || device.state?.state === "failed" ? t.stopped(device.state.reason)
          : device.subscription && device.state?.state === "none" ? t.forgotten
            : active ? t.help.active : t.help.available;
  return (
    <div className="settings-group push-settings" data-support={support} data-state={device.state?.state ?? "none"}>
      <label className="settings-row">
        <span className="settings-row-main">
          <span className="settings-row-title">{t.title}</span>
          <span className="settings-row-help">{help}</span>
          {problem && <span className="settings-row-help notification-ask-result" role="status">{problem}</span>}
        </span>
        {usable && (
          <input type="checkbox" checked={!!active} disabled={busy} aria-label={t.title}
            onChange={(event) => void turn(event.target.checked)} />
        )}
      </label>
    </div>
  );
}
