import { api } from "./api";

export const SNAPSHOT_TIMEOUT_MS = 10_000;

export class SnapshotTimeoutError extends Error {
  constructor() {
    super("The snapshot did not respond within 10 seconds.");
    this.name = "SnapshotTimeoutError";
  }
}

/** Only snapshot GETs use this deadline. A stalled fetch/body cannot hold the
 * refresh queue forever, even if a transport ignores AbortSignal. */
export async function readSnapshot<T>(path: string, signal: AbortSignal, headers?: HeadersInit) {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let cancel = () => {};
  const interrupted = new Promise<never>((_, reject) => {
    cancel = () => {
      reject(new DOMException("Snapshot cancelled", "AbortError"));
      controller.abort();
    };
    if (signal.aborted) cancel();
    else signal.addEventListener("abort", cancel, { once: true });
    timer = setTimeout(() => {
      reject(new SnapshotTimeoutError());
      controller.abort();
    }, SNAPSHOT_TIMEOUT_MS);
  });
  try {
    return await Promise.race([
      api<T>(path, { signal: controller.signal, headers }),
      interrupted,
    ]);
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", cancel);
  }
}
