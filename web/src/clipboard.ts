/** Writes text that may still be loading. The clipboard write starts during
 * the click, so browsers that require a user gesture still accept it. */
export async function copyText(text: string | Promise<string>) {
  if (typeof text === "string") return navigator.clipboard.writeText(text);
  if (typeof ClipboardItem !== "undefined" && navigator.clipboard.write)
    return navigator.clipboard.write([
      new ClipboardItem({
        "text/plain": text.then((value) => new Blob([value], { type: "text/plain" })),
      }),
    ]);
  return navigator.clipboard.writeText(await text);
}
