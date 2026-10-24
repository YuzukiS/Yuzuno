import { IMAGE_TYPES, MAX_IMAGE_BYTES } from "./image-input.ts";

/** What Core takes as an input image besides its bytes (core/src/input_images.rs). */
export const MAX_IMAGE_SIDE = 8192;
export const MAX_IMAGE_PIXELS = 24_000_000;
/** A photo Core would refuse is redrawn with its longer side this long (T-170):
 * plenty for a model to read, and inside the canvas a phone's browser allows
 * (iOS Safari: about 16.7 million pixels). An iPhone 15 or later takes 24 MP
 * (5712 × 4284) or 48 MP photos by default, both over Core's limit. */
export const FIT_SIDE = 4096;
const JPEG_QUALITY = 0.9;
const HEADER_BYTES = 1024 * 1024;

export type ImageSize = { width: number; height: number };

/** Width and height from a PNG, JPEG or WebP file's header, as stored (before
 * any EXIF rotation, which does not change the side or pixel limits), or null
 * when the header is not one of those. */
export function imageSize(bytes: Uint8Array): ImageSize | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const ascii = (at: number, text: string) =>
    bytes.length >= at + text.length && [...text].every((c, i) => bytes[at + i] === c.charCodeAt(0));
  const size = (width: number, height: number) => (width > 0 && height > 0 ? { width, height } : null);
  // PNG: the signature, then IHDR's width and height.
  if (bytes.length >= 24 && bytes[0] === 0x89 && ascii(1, "PNG") && ascii(12, "IHDR"))
    return size(view.getUint32(16), view.getUint32(20));
  // JPEG: walk the segments to the first start-of-frame marker.
  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    let at = 2;
    while (at + 4 <= bytes.length) {
      if (bytes[at] !== 0xff) return null;
      const marker = bytes[at + 1];
      if (marker === 0xff) { at += 1; continue; }
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { at += 2; continue; }
      const length = view.getUint16(at + 2);
      if (length < 2) return null;
      const frame = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
      if (frame) return at + 9 <= bytes.length ? size(view.getUint16(at + 7), view.getUint16(at + 5)) : null;
      if (marker === 0xd9 || marker === 0xda) return null;
      at += 2 + length;
    }
    return null;
  }
  // WebP: lossy (VP8), lossless (VP8L) or extended (VP8X).
  if (ascii(0, "RIFF") && ascii(8, "WEBP")) {
    if (ascii(12, "VP8 ") && bytes.length >= 30) return size(view.getUint16(26, true) & 0x3fff, view.getUint16(28, true) & 0x3fff);
    if (ascii(12, "VP8L") && bytes.length >= 25) {
      const bits = view.getUint32(21, true);
      return size((bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1);
    }
    if (ascii(12, "VP8X") && bytes.length >= 30) {
      const u24 = (at: number) => bytes[at] | (bytes[at + 1] << 8) | (bytes[at + 2] << 16);
      return size(u24(24) + 1, u24(27) + 1);
    }
  }
  return null;
}

/** Whether Core takes an image of this size and byte count as it is. */
export function fitsCore({ width, height }: ImageSize, bytes: number) {
  return bytes > 0 && bytes <= MAX_IMAGE_BYTES && width <= MAX_IMAGE_SIDE && height <= MAX_IMAGE_SIDE && width * height <= MAX_IMAGE_PIXELS;
}

/** The size a too-large image is redrawn at: the same shape, its longer side
 * at most FIT_SIDE, in whole pixels. */
export function fittedSize({ width, height }: ImageSize): ImageSize {
  const scale = Math.min(1, FIT_SIDE / Math.max(width, height));
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

/** A decoded image, upright as it is shown, and how to make a JPEG of it. */
export type DecodedImage = ImageSize & {
  jpeg(size: ImageSize, quality: number): Promise<Blob | null>;
  close(): void;
};

/** The browser's decoder: createImageBitmap applies a photo's EXIF rotation,
 * and the canvas is filled white first, since a JPEG has no transparency. */
async function decode(file: File): Promise<DecodedImage> {
  if (typeof createImageBitmap !== "function") throw new Error("This browser cannot make the image smaller.");
  const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
  return {
    width: bitmap.width,
    height: bitmap.height,
    jpeg: ({ width, height }, quality) => {
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext("2d");
      if (!context) return Promise.resolve(null);
      context.fillStyle = "#fff";
      context.fillRect(0, 0, width, height);
      context.imageSmoothingQuality = "high";
      context.drawImage(bitmap, 0, 0, width, height);
      return new Promise((done) => canvas.toBlob(done, "image/jpeg", quality));
    },
    close: () => bitmap.close(),
  };
}

const jpegName = (name: string) => `${(name || "Photo").replace(/\.[^./\\]*$/, "") || "Photo"}.jpg`;

/** The file to upload for a chosen or pasted image. One Core takes as it is,
 * or one whose header this cannot read, is the same file, never decoded or
 * changed; Core checks it as before. One too large (bytes, pixels or a side)
 * is redrawn upright as a JPEG at fittedSize. */
export async function fitImage(file: File, open: (file: File) => Promise<DecodedImage> = decode): Promise<File> {
  if (!IMAGE_TYPES.includes(file.type)) return file;
  // The header is near the start; the whole file is read only when it is not
  // found there (a JPEG with unusually large metadata).
  const head = file.size > HEADER_BYTES ? file.slice(0, HEADER_BYTES) : file;
  const stored = imageSize(new Uint8Array(await head.arrayBuffer())) ??
    (head === file ? null : imageSize(new Uint8Array(await file.arrayBuffer())));
  if (!stored || fitsCore(stored, file.size)) return file;
  const label = file.name || "Image";
  let image: DecodedImage;
  try {
    image = await open(file);
  } catch (error) {
    throw new Error(`${label}: too large to send, and it could not be made smaller here (${error instanceof Error ? error.message : String(error)}).`);
  }
  try {
    const blob = await image.jpeg(fittedSize(image), JPEG_QUALITY);
    if (!blob || !blob.size) throw new Error(`${label}: too large to send, and it could not be made smaller here.`);
    if (blob.size > MAX_IMAGE_BYTES) throw new Error(`${label}: still over 10 MiB when made smaller.`);
    return new File([blob], jpegName(file.name), { type: "image/jpeg", lastModified: file.lastModified });
  } finally {
    image.close();
  }
}
