import { useId, useRef, useState } from "react";
import { HomeComposer, type ReplyWords } from "./home/HomeComposer";
import { ReplyLength } from "./home/reply-limit";
import { measured, type CoreLimit } from "./core-limits";
import { strings, useStrings } from "./i18n";
import "./long-text-field.css";

const n = (value: number) => value.toLocaleString("en-US");
const text = strings({
  bytesLeft: (left: number, most: number) =>
    `${n(left)} ${left === 1 ? "byte" : "bytes"} left of ${n(most)} (UTF-8: a Chinese character is 3).`,
  bytesOver: (over: number, most: number) =>
    `${n(over)} ${over === 1 ? "byte" : "bytes"} too long: this field takes at most ${n(most)} bytes in UTF-8, where a Chinese character is 3. Nothing is sent until it is shorter; what you wrote is kept.`,
  charsLeft: (left: number, most: number) =>
    `${n(left)} ${left === 1 ? "character" : "characters"} left of ${n(most)}.`,
  charsOver: (over: number, most: number) =>
    `${n(over)} ${over === 1 ? "character" : "characters"} too long: this field takes at most ${n(most)} characters. Nothing is sent until it is shorter; what you wrote is kept.`,
}, {
  bytesLeft: (left, most) => `还能输入 ${n(left)} 字节，上限 ${n(most)} 字节（UTF-8，一个汉字 3 字节）。`,
  bytesOver: (over, most) =>
    `超出 ${n(over)} 字节：这一栏最多 ${n(most)} 字节（UTF-8，一个汉字 3 字节）。删减之前不会提交，已写的内容不会丢。`,
  charsLeft: (left, most) => `还能输入 ${n(left)} 个字，上限 ${n(most)} 个字。`,
  charsOver: (over, most) => `超出 ${n(over)} 个字：这一栏最多 ${n(most)} 个字。删减之前不会提交，已写的内容不会丢。`,
});

/**
 * Submits `form` as Return in one of its inputs would (HTML's implicit
 * submission): through its default button, and not at all while that button
 * is disabled, so the keys never send what the button would not.
 */
function implicitSubmit(form: HTMLFormElement | null | undefined) {
  const button = form?.querySelector<HTMLButtonElement | HTMLInputElement>(
    "button:not([type]), button[type=submit], input[type=submit]",
  );
  if (!form || !button || button.disabled || button.matches(":disabled")) return;
  form.requestSubmit(button);
}

/**
 * A form's field for long text (YN-106): the conversation's composer, as
 * Home's replies have it (HomeComposer), so a long paste folds into a block
 * that opens to be read or edited, and the form sends the whole text. The
 * field has no length limit of its own: near Core's (`limit`) it says how
 * much is left, and over it by how much; the form's own submit refuses it
 * (core-limits.ts overLimit). The value stays a string: where its pastes
 * are is kept here while the form gives back the text this field wrote.
 *
 * Return: `send` sends as the conversation does on this device; `newline`
 * makes a new line, and Ctrl/⌘+Return submits. Either submits as the
 * form's default button does, never while it is disabled, and Return is an
 * input method's own while it composes.
 */
export function LongTextField({
  slot,
  label,
  optional,
  placeholder = "",
  value,
  onChange,
  limit,
  returnKey,
  readOnly = false,
  required = false,
  error = "",
  fieldId,
  className = "collab-field",
}: {
  /** Which field it is: the editor keeps its undo history per slot. */
  slot: string;
  label: string;
  /** Said beside the label, as an optional field's label says it. */
  optional?: string;
  placeholder?: string;
  value: string;
  onChange: (value: string) => void;
  limit: CoreLimit;
  returnKey: "send" | "newline";
  readOnly?: boolean;
  required?: boolean;
  /** Why the form did not take this field, said under it. */
  error?: string;
  /** The editor's id, for a form that moves focus to it. */
  fieldId?: string;
  /** The field's place: a task's form, unless another form draws it (long-text-field.css). */
  className?: string;
}) {
  const t = useStrings(text);
  const id = useId();
  const box = useRef<HTMLDivElement>(null);
  const [kept, setKept] = useState<ReplyWords>({ text: value });
  // Its blocks while the text is the one written here; another text (sent
  // and cleared, another task's) is drawn as plain text.
  const words = kept.text === value ? kept : { text: value };
  const used = measured(value, limit);
  const over = used > limit.max;
  return (
    <div className={className ? `long-text-field ${className}` : "long-text-field"} ref={box}>
      <span>
        {label}
        {optional && <> <small>{optional}</small></>}
      </span>
      <HomeComposer
        slot={slot}
        label={label}
        placeholder={placeholder}
        words={words}
        onWords={(next) => {
          setKept(next);
          onChange(next.text);
        }}
        onSubmit={() => {
          if (!readOnly) implicitSubmit(box.current?.closest("form"));
        }}
        readOnly={readOnly}
        sendKey={returnKey === "newline" ? "modEnter" : undefined}
        attributes={{
          ...(fieldId ? { id: fieldId } : {}),
          "aria-describedby": `${id}-note`,
          "aria-invalid": String(over || !!error),
          ...(required ? { "aria-required": "true" } : {}),
        }}
      />
      <div id={`${id}-note`} className="long-text-note">
        {error && <p className="long-text-error" role="alert">{error}</p>}
        <ReplyLength
          bytes={used}
          max={limit.max}
          words={limit.unit === "chars" ? { left: t.charsLeft, over: t.charsOver } : { left: t.bytesLeft, over: t.bytesOver }}
        />
      </div>
    </div>
  );
}
