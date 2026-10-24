import type { ComposerDraft } from "./composer-draft.ts";

export type DraftImage = {
  id: string;
  agentId: string;
  name: string;
  width: number;
  height: number;
  bytes: number;
};
export const imageIdPattern = /^[a-f0-9]{64}\.(png|jpg|webp)$/;

/** Forked native history keeps the original owner's path. Extract only our
 * managed reference, never a caller path or URL. The existing image route
 * checks that owner and reads the opaque ID inside Core's image directory. */
export function messageImages(
  content: { type: string; path?: string }[] | undefined,
) {
  return (content || []).flatMap((part) => {
    if (part.type !== "localImage" || typeof part.path !== "string") return [];
    const path = part.path.replaceAll("\\", "/");
    if (!/^(\/|[A-Za-z]:\/)/.test(path) || path.includes("://")) return [];
    const parts = path.split("/");
    if (parts.some((segment) => segment === "." || segment === "..")) return [];
    const [directory, agentId, id] = parts.slice(-3);
    return directory === "input-images" &&
      /^[A-Za-z0-9-]{1,100}$/.test(agentId || "") &&
      imageIdPattern.test(id || "")
      ? [{ agentId, id }]
      : [];
  });
}
export const IMAGE_TYPES = ["image/png", "image/jpeg", "image/webp"];
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
export const MAX_IMAGES = 8;
export const MAX_IMAGE_TOTAL = 40 * 1024 * 1024;

/** Clipboard items and files are two views of the same payload. Never concatenate them. */
export function clipboardImages(data: DataTransfer | null): File[] {
  if (!data) return [];
  const items = Array.from(data.items || [])
    .filter((item) => item.kind === "file")
    .map((item) => item.getAsFile())
    .filter((file): file is File => !!file);
  return (items.length ? items : Array.from(data.files || [])).filter((file) =>
    file.type.startsWith("image/"),
  );
}
/** What can be checked before any image is read: how many, and their types. */
export function validateImageChoice(
  files: readonly File[],
  current: readonly DraftImage[],
) {
  if (files.length + current.length > MAX_IMAGES)
    throw new Error("Attach at most 8 images per message.");
  for (const file of files)
    if (!IMAGE_TYPES.includes(file.type))
      throw new Error(`${file.name || "Image"}: choose PNG, JPEG or WebP.`);
}
export function validateImageFiles(
  files: readonly File[],
  current: readonly DraftImage[],
) {
  validateImageChoice(files, current);
  for (const file of files) {
    if (!file.size || file.size > MAX_IMAGE_BYTES)
      throw new Error(
        `${file.name || "Image"}: each image must be between 1 byte and 10 MiB.`,
      );
  }
  if (
    files.reduce((n, f) => n + f.size, 0) +
      current.reduce((n, f) => n + f.bytes, 0) >
    MAX_IMAGE_TOTAL
  )
    throw new Error("Images in one message must total at most 40 MiB.");
}
export function validDraftImages(value: unknown): value is DraftImage[] {
  return (
    Array.isArray(value) &&
    value.length <= MAX_IMAGES &&
    value.every(
      (image) =>
        image &&
        typeof image.id === "string" &&
        imageIdPattern.test(image.id) &&
        typeof image.agentId === "string" &&
        typeof image.name === "string" &&
        image.name.length <= 200 &&
        Number.isSafeInteger(image.bytes) &&
        image.bytes > 0 &&
        image.bytes <= MAX_IMAGE_BYTES &&
        Number.isSafeInteger(image.width) &&
        image.width > 0 &&
        image.width <= 8192 &&
        Number.isSafeInteger(image.height) &&
        image.height > 0 &&
        image.height <= 8192,
    )
  );
}
export function appendImage(
  draft: ComposerDraft,
  image: DraftImage,
): ComposerDraft {
  if (
    draft.images?.some(
      (saved) => saved.id === image.id && saved.agentId === image.agentId,
    )
  )
    return draft;
  if (
    (draft.images?.length || 0) >= MAX_IMAGES ||
    (draft.images || []).reduce((n, i) => n + i.bytes, image.bytes) >
      MAX_IMAGE_TOTAL
  )
    throw new Error(
      "The draft already contains the maximum image count or size.",
    );
  return { ...draft, images: [...(draft.images || []), image] };
}
export function sameMessageImages(
  a: readonly string[] | undefined,
  b: readonly string[],
) {
  return (a?.length || 0) === b.length && b.every((id, i) => a?.[i] === id);
}
