// Where to go back to in a conversation, as a list that can be read (T-15).
//
// The Turn dock on the conversation's right edge is a scale: it shows where
// the Turns are and holds the reading place, and on touch it is only that,
// so that a finger scrolls the conversation through it. The list here is the
// other half -- the words of each Turn, large enough to choose from -- and
// it takes the rail while it shows, with a way back to the Agents.
import { History, ArrowLeft } from "lucide-react";
import { userRequests } from "./CurrentTurnPrompt";
import { langTag, strings, useLanguage, useStrings } from "./i18n";
import type { NativeTurn } from "./types";
import "./rail-turn-index.css";

const text = strings({
  title: "Where you are",
  back: "Back to Agents",
  turn: (n: number) => `Turn ${n}`,
  noMessage: "No message",
  reading: "Where you are reading",
  empty: "This conversation has no Turns yet.",
}, {
  title: "阅读位置",
  back: "返回 Agent 列表",
  turn: (n) => `第 ${n} 轮`,
  noMessage: "没有消息",
  reading: "你正在读的位置",
  empty: "这个会话还没有轮次。",
});

export function RailTurnIndex({
  turns,
  readingTurnId,
  loadedNumbering = true,
  onNavigate,
  onBack,
}: {
  turns: readonly NativeTurn[];
  /** The Turn the conversation says is being read, if any. */
  readingTurnId?: string;
  /** False while only part of the conversation is loaded: then the numbers
   * are of what is here, not of the whole conversation. */
  loadedNumbering?: boolean;
  onNavigate: (turnId: string) => void;
  onBack: () => void;
}) {
  const t = useStrings(text);
  const language = useLanguage();
  return (
    <div className="rail-turn-index" lang={langTag(language)}>
      <div className="rail-turn-index-top">
        <button type="button" className="quiet-button rail-turn-index-back" onClick={onBack}>
          <ArrowLeft size={13} aria-hidden="true" />
          {t.back}
        </button>
      </div>
      <h2 className="rail-turn-index-title">
        <History size={13} aria-hidden="true" />
        {t.title}
      </h2>
      {turns.length === 0 ? (
        <p className="rail-turn-index-empty">{t.empty}</p>
      ) : (
        <ol className="rail-turn-index-list">
          {turns.map((turn, index) => {
            const here = !!readingTurnId && turn.id === readingTurnId;
            const asked = userRequests(turn)[0];
            const number = loadedNumbering ? index + 1 : index + 1;
            return (
              <li key={turn.id}>
                <button
                  type="button"
                  className="rail-turn-index-row"
                  data-here={here || undefined}
                  aria-current={here ? "location" : undefined}
                  onClick={() => onNavigate(turn.id)}
                >
                  <span className="rail-turn-index-number">
                    {t.turn(number)}
                    {here && <span className="rail-turn-index-dot" aria-label={t.reading} />}
                  </span>
                  {/* The words of the Turn, one line: enough to tell it from
                      the others without becoming a second conversation. */}
                  <span className="rail-turn-index-said">
                    {asked?.text?.trim() || t.noMessage}
                  </span>
                </button>
              </li>
            );
          })}
        </ol>
      )}
    </div>
  );
}
