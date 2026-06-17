import { useEffect, useMemo, useState } from "react";
import { TelemetryClient } from "./telemetryClient";
import type {
  TelemetryClientMetrics,
  TelemetryConnectionStatus,
  TelemetrySnapshot
} from "./telemetryTypes";

function parseRenderHz(): number {
  const value = Number(import.meta.env.VITE_RENDER_HZ);
  return Number.isFinite(value) && value >= 1 && value <= 120 ? value : 60;
}

export function useTelemetry() {
  const client = useMemo(() => new TelemetryClient(), []);
  const renderHz = useMemo(parseRenderHz, []);
  const renderIntervalMs = 1000 / renderHz;
  const [snapshot, setSnapshot] = useState<TelemetrySnapshot | null>(null);
  const [clientMetrics, setClientMetrics] = useState<TelemetryClientMetrics>(() =>
    client.getMetrics()
  );
  const [connectionStatus, setConnectionStatus] =
    useState<TelemetryConnectionStatus>("connecting");

  useEffect(() => {
    const unsubscribe = client.subscribeStatus(setConnectionStatus);
    client.start();

    // Initial HTTP snapshot fallback keeps the dashboard useful while the
    // WebSocket handshake is still connecting, and makes design screenshots
    // deterministic without changing the realtime WebSocket data path.
    fetch("/api/telemetry")
      .then((response) => (response.ok ? response.json() : null))
      .then((data: { snapshot?: TelemetrySnapshot } | null) => {
        if (data?.snapshot) {
          client.setLatest(data.snapshot);
          setSnapshot(data.snapshot);
        }
      })
      .catch(() => {
        // WebSocket remains the primary realtime source; a failed fallback read
        // should never interrupt the dashboard.
      });

    return () => {
      unsubscribe();
      client.stop();
    };
  }, [client]);

  useEffect(() => {
    let animationFrameId = 0;
    let lastRenderAt = performance.now();
    let renderFrames = 0;

    const renderLoop = (now: number) => {
      // React rendering is throttled separately from WebSocket receive. Messages
      // update the latest ref immediately; requestAnimationFrame only copies it
      // into React state when the VITE_RENDER_HZ budget allows a new frame.
      if (now - lastRenderAt >= renderIntervalMs) {
        const latest = client.getLatest();
        const metrics = client.getMetrics();
        renderFrames += 1;

        metrics.renderFrames = renderFrames;
        metrics.receiveToRenderMs =
          metrics.lastReceivePerformanceMs == null ? null : now - metrics.lastReceivePerformanceMs;
        metrics.renderSnapshotAgeMs =
          latest?.timestamp == null ? null : Date.now() - latest.timestamp;

        setSnapshot(latest);
        setClientMetrics(metrics);
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
    clientMetrics,
    connectionStatus,
    renderHz,
    renderIntervalMs
  };
}
