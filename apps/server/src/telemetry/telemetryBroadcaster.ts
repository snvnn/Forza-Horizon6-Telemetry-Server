import type { AppConfig } from "../config.js";
import type { TelemetryWebSocketServer } from "../websocket/telemetryWebSocket.js";

export function startTelemetryBroadcaster(
  config: AppConfig,
  wsServer: TelemetryWebSocketServer
): NodeJS.Timeout {
  // WebSocket broadcast is throttled independently from UDP receive. The UDP
  // listener can update the latest store on every packet while clients receive
  // snapshots at TELEMETRY_BROADCAST_HZ.
  const timer = setInterval(() => {
    wsServer.broadcastLatest();
  }, config.broadcastIntervalMs);

  console.log(
    `[ws] Broadcasting telemetry at ${config.broadcastHz}Hz (${config.broadcastIntervalMs.toFixed(2)}ms)`
  );

  return timer;
}
