import { CircleAlert } from "lucide-react";
import { strings, useStrings } from "../i18n";
import type { Arrival } from "./home-reply-model";
import "./home-reply.css";

const arrivalText = strings({
  changed: (ask: boolean, replied: number, current: number) => (
    <>You replied to <b>version {replied}</b> of this {ask ? "ask" : "card"}. It has changed since; this is <b>version {current}</b>, not the one you answered.</>
  ),
  resolved: (replied: number) => <>You replied to version {replied}. <b>Its author has resolved this ask</b>; it is under History on this project.</>,
  removed: (replied: number) => <>You replied to version {replied}. <b>Its author removed this card</b> from Home.</>,
  history: (replied: number) => <>You replied to version {replied}. This card is now under <b>History</b> on this project.</>,
  gone: <>The project this reply was about is <b>not on Home</b> now.</>,
  back: "Back to your reply",
}, {
  changed: (ask: boolean, replied: number, current: number) => (
    <>你回复的是这个{ask ? "提问" : "卡片"}的<b>第 {replied} 版</b>。它之后有了变化；这里是<b>第 {current} 版</b>，不是你回答的那一版。</>
  ),
  resolved: (replied: number) => <>你回复的是第 {replied} 版。<b>作者已处理完这个提问</b>，它在这个项目的历史里。</>,
  removed: (replied: number) => <>你回复的是第 {replied} 版。<b>作者已从 Home 移除这张卡片</b>。</>,
  history: (replied: number) => <>你回复的是第 {replied} 版。这张卡片现在在这个项目的<b>历史</b>里。</>,
  gone: <>这条回复所属的项目现在<b>不在 Home 上</b>。</>,
  back: "回到你的回复",
});

/**
 * Where "Open on Home" on a reply landed (T-9, hr5 frame E): what Home has
 * now of the version answered, decided on arrival, with the way back to the
 * reply where the card has changed. Nothing when it is still that version.
 */
export function ReplyArrival({ arrival, version, ask, onBack }: {
  arrival: Arrival;
  /** The version answered. */
  version: number | null;
  ask: boolean;
  onBack?: () => void;
}) {
  const t = useStrings(arrivalText);
  const replied = version ?? 0;
  const text =
    arrival.kind === "changed" ? t.changed(ask, replied, arrival.current)
      : arrival.kind === "resolved" ? t.resolved(replied)
        : arrival.kind === "removed" ? t.removed(replied)
          : arrival.kind === "history" ? t.history(replied)
            : arrival.kind === "gone" ? t.gone
              : null;
  if (!text) return null;
  return (
    <div className={`home-reply-arrival${arrival.kind === "changed" ? " in-card" : ""}`} role="status">
      <CircleAlert size={15} aria-hidden="true" />
      <div>
        {text}
        {arrival.kind === "changed" && onBack && (
          <div className="home-reply-arrival-actions">
            <button type="button" onClick={onBack}>{t.back}</button>
          </div>
        )}
      </div>
    </div>
  );
}
