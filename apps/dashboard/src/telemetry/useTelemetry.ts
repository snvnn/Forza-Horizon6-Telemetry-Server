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
    // React rendering is throttled separately from WebSocket receive. The client
    // may receive 60Hz messages, but state updates happen only at VITE_RENDER_HZ.
    const timer = window.setInterval(() => {
      setSnapshot(client.getLatest());
    }, renderIntervalMs);

    return () => {
      window.clearInterval(timer);
    };
  }, [client, renderIntervalMs]);

  return {
    snapshot,
    connectionStatus,
    renderHz,
    renderIntervalMs
  };
}
