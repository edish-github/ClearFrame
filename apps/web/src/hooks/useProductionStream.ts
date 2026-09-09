import { useEffect, useRef } from "react";
import { api } from "@/api/client";
import type { StreamEvent } from "@clearframe/shared";

/**
 * Subscribes to a production's server-sent events and calls back on change.
 *
 * The stream carries notifications, not state. A frame means "something moved",
 * and the screen re-reads the database. That keeps one source of truth and
 * avoids a UI that drifts from what was actually persisted.
 */
export function useProductionStream(
  productionId: string | undefined,
  onChange: (event: StreamEvent) => void,
  enabled = true
): void {
  const handler = useRef(onChange);
  handler.current = onChange;

  useEffect(() => {
    if (!productionId || !enabled) return;
    let closed = false;
    let retry: number | undefined;

    const open = (): (() => void) =>
      api.stream(
        productionId,
        (event) => { if (!closed) handler.current(event); },
        () => {
          // EventSource reconnects on its own, but a dropped token or a deploy
          // needs a fresh handshake. Back off rather than hammering.
          if (closed) return;
          stop();
          retry = window.setTimeout(() => { if (!closed) stop = open(); }, 4000);
        }
      );

    let stop = open();
    return () => { closed = true; window.clearTimeout(retry); stop(); };
  }, [productionId, enabled]);
}
