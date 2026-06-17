import { useEffect, useMemo, useState } from "react";
import type { ConfigResponse } from "../settings/settingsTypes";
import { TelemetryClient } from "./telemetryClient";
import type {
  TelemetryClientMetrics,
  TelemetryConnectionStatus,
  TelemetrySnapshot
} from "./telemetryTypes";

function parseRenderHz(): number {
  const value = Number(import.meta.env.VITE_RENDER_HZ);
  return Number.isFinite(value) && value >= 1 && value <= 240 ? value : 60;
}

export function useTelemetry() {
  const client = useMemo(() => new TelemetryClient(), []);
  const [renderHz, setRenderHz] = useState(parseRenderHz);
  const renderIntervalMs = 1000 / renderHz;
  const [snapshot, setSnapshot] = useState<TelemetrySnapshot | null>(null);
  const [clientMetrics, setClientMetrics] = useState<TelemetryClientMetrics>(() =>
    client.getMetrics()
  );
  const [connectionStatus, setConnectionStatus] =
    useState<TelemetryConnectionStatus>("connecting");

  useEffect(() => {
    let cancelled = false;
    const unsubscribe = client.subscribeStatus(setConnectionStatus);

    const refreshRuntimeConfig = async () => {
      const response = await fetch("/api/config");
      if (!response.ok) {
        throw new Error("Failed to read dashboard runtime config");
      }
      const data = (await response.json()) as ConfigResponse;
      if (cancelled) {
        return;
      }
      client.setTransportMode(data.config.transportMode);
      setRenderHz((current) =>
        current === data.config.dashboardRenderHz ? current : data.config.dashboardRenderHz
      );
    };

    client.syncServerClock().catch(() => undefined);
    refreshRuntimeConfig()
      .catch(() => undefined)
      .finally(() => {
        if (!cancelled) {
          client.start();
        }
      });

    const configTimerId = window.setInterval(() => {
      refreshRuntimeConfig().catch(() => undefined);
    }, 2000);
    const clockSyncTimerId = window.setInterval(() => {
      client.syncServerClock().catch(() => undefined);
    }, 5000);

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
      cancelled = true;
      window.clearInterval(configTimerId);
      window.clearInterval(clockSyncTimerId);
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
          latest?.timestamp == null ? null : client.getServerAlignedNow() - latest.timestamp;

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
