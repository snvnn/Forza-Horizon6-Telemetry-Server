import { loadConfig } from "./config.js";
import { createTelemetryHttpServer } from "./http/createHttpServer.js";
import { createMockTelemetrySnapshot, ForzaPacketParser } from "./parser/forzaPacketParser.js";
import { TelemetryStore } from "./telemetry/telemetryStore.js";
import { startTelemetryBroadcaster } from "./telemetry/telemetryBroadcaster.js";
import { startForzaUdpReceiver } from "./udp/forzaUdpReceiver.js";
import { createTelemetryWebSocketServer } from "./websocket/telemetryWebSocket.js";

const config = loadConfig();
const store = new TelemetryStore(config.connectionTimeoutMs);
const parser = new ForzaPacketParser({ debugPacket: config.debugPacket });
const wsServer = createTelemetryWebSocketServer(store);
const httpServer = createTelemetryHttpServer(config, store, wsServer);

const udpSocket = startForzaUdpReceiver({
  host: config.host,
  port: config.udpPort,
  parser,
  store
});

const broadcasterTimer = startTelemetryBroadcaster(config, wsServer);

let mockTimer: NodeJS.Timeout | undefined;
if (config.mockTelemetry) {
  // Mock mode makes the full UI and WebSocket pipeline testable without Forza
  // packets. It still uses the same in-memory store and broadcast throttle.
  mockTimer = setInterval(() => {
    store.update(createMockTelemetrySnapshot());
  }, 1000 / 60);
  console.log("[mock] Mock telemetry enabled at 60Hz");
}

httpServer.listen(config.httpPort, config.host, () => {
  // 0.0.0.0 binding is required for local-network tablet access. If Windows
  // Firewall blocks Node.js, allow private-network inbound access for this port.
  console.log(`[http] Server listening on http://${config.host}:${config.httpPort}`);
  console.log(`[http] Tablet URL example: http://PC_LOCAL_IP:${config.httpPort}`);
});

function shutdown(): void {
  console.log("[server] Shutting down");
  clearInterval(broadcasterTimer);
  if (mockTimer) {
    clearInterval(mockTimer);
  }
  udpSocket.close();
  wsServer.wss.close();
  httpServer.close(() => {
    process.exit(0);
  });
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
