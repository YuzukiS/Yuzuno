import { useEffect, useRef } from "react";
import { readSnapshot } from "./snapshot-request";

/** Refreshes coalesce behind the current request. Continuous events must not
 * invalidate every response before it can render, even on a slow connection. */
export function useSnapshot<T>(
  path: string | null,
  revision: number,
  onData: (data: T) => void,
  onError: (error: unknown) => void,
  onSettled?: () => void,
) {
  const callbacks = useRef({ onData, onError, onSettled });
  callbacks.current = { onData, onError, onSettled };
  const request = useRef(() => {});
  useEffect(() => {
    if (!path) return;
    let disposed = false;
    let running = false;
    let queued = false;
    const controller = new AbortController();
    const run = async () => {
      if (disposed) return;
      if (running) {
        queued = true;
        return;
      }
      running = true;
      queued = false;
      try {
        const data = await readSnapshot<T>(path, controller.signal);
        if (!disposed) callbacks.current.onData(data);
      } catch (error) {
        if (!disposed) callbacks.current.onError(error);
      } finally {
        running = false;
        if (!disposed) {
          callbacks.current.onSettled?.();
          if (queued) void run();
        }
      }
    };
    request.current = run;
    return () => {
      disposed = true;
      controller.abort();
      if (request.current === run) request.current = () => {};
    };
  }, [path]);
  useEffect(() => {
    request.current();
  }, [path, revision]);
}
