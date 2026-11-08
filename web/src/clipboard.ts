/** Writes text that may still be loading. The clipboard write starts during
 * the click, so browsers that require a user gesture still accept it.
 *
 * A page that is not a secure context (plain http at a LAN or tailnet
 * address, YN-36) has no Clipboard API: there the browser's copy command
 * copies the text instead, still in the click when the text is ready. Where
 * that copies nothing either, this throws, and the caller says the
 * clipboard is unavailable. */
export async function copyText(text: string | Promise<string>) {
  if (!navigator.clipboard) return copyByCommand(typeof text === "string" ? text : await text);
  if (typeof text === "string") return navigator.clipboard.writeText(text);
  if (typeof ClipboardItem !== "undefined" && navigator.clipboard.write)
    return navigator.clipboard.write([
      new ClipboardItem({
        "text/plain": text.then((value) => new Blob([value], { type: "text/plain" })),
      }),
    ]);
  return navigator.clipboard.writeText(await text);
}

/** Copies through a field of its own, gone again at once; the focus and the
 * page's selection are put back as they were. */
function copyByCommand(text: string) {
  const field = document.createElement("textarea");
  field.value = text;
  field.readOnly = true;
  field.setAttribute("aria-hidden", "true");
  field.tabIndex = -1;
  field.dataset.copyFallback = "";
  field.style.cssText = "position:fixed;top:0;left:0;width:1px;height:1px;padding:0;border:0;opacity:0;pointer-events:none";
  const focused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const selection = document.getSelection();
  const ranges = selection ? Array.from({ length: selection.rangeCount }, (_, i) => selection.getRangeAt(i)) : [];
  document.body.append(field);
  let copied = false;
  try {
    field.focus({ preventScroll: true });
    field.select();
    field.setSelectionRange(0, text.length);
    copied = typeof document.execCommand === "function" && document.execCommand("copy");
  } finally {
    field.remove();
    focused?.focus({ preventScroll: true });
    if (selection && ranges.length) {
      selection.removeAllRanges();
      for (const range of ranges) selection.addRange(range);
    }
  }
  if (!copied) throw new Error("The clipboard is not available on this page.");
}
