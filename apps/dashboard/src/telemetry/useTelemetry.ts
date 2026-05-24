import { useEffect, useMemo, useState } from "react";
import { TelemetryClient } from "./telemetryClient";
import type { TelemetryConnectionStatus, TelemetrySnapshot } from "./telemetryTypes";

function parseRenderHz(): number {
  const value = Number(import.meta.env.VITE_RENDER_HZ);
  return Number.isFinite(value) && value >= 1 && value <= 120 ? value : 60;
}

export function useTelemetry() {
  const client = useMemo(() => new TelemetryClient(), []);
  const renderHz = useMemo(parseRenderHz, []);
  const renderIntervalMs = 1000 / renderHz;
  const [snapshot, setSnapshot] = useState<TelemetrySnapshot | null>(null);
  const [connectionStatus, setConnectionStatus] =
    useState<TelemetryConnectionStatus>("connecting");

  useEffect(() => {
    const unsubscribe = client.subscribeStatus(setConnectionStatus);
    client.start();

    return () => {
      unsubscribe();
      client.stop();
    };
  }, [client]);

  useEffect(() => {
    let animationFrameId = 0;
    let lastRenderAt = performance.now();

    const renderLoop = (now: number) => {
      // React rendering is throttled separately from WebSocket receive. Messages
      // update the latest ref immediately; requestAnimationFrame only copies it
      // into React state when the VITE_RENDER_HZ budget allows a new frame.
      if (now - lastRenderAt >= renderIntervalMs) {
        setSnapshot(client.getLatest());
        lastRenderAt = now;
      }

      animationFrameId = window.requestAnimationFrame(renderLoop);
    };

    animationFrameId = window.requestAnimationFrame(renderLoop);

    return () => {
      window.cancelAnimationFrame(animationFrameId);
    };
  }, [client, renderIntervalMs]);

  return {
    snapshot,
    connectionStatus,
    renderHz,
    renderIntervalMs
  };
}
