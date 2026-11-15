/** A file Core saved for a message: its content-addressed ID, the safe name
 * Core kept and its size (core/src/input_files.rs). Apart from the rest of
 * file-input.ts, so a hook can compare two messages' files without reading
 * the interface or a browser API. */
export type SavedFile = { id: string; name: string; bytes: number };

export function sameMessageFiles(
  a: readonly SavedFile[] | undefined,
  b: readonly SavedFile[],
) {
  return (
    (a?.length || 0) === b.length &&
    b.every(
      (file, i) =>
        a?.[i]?.id === file.id &&
        a?.[i]?.name === file.name &&
        a?.[i]?.bytes === file.bytes,
    )
  );
}
