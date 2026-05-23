import type { IncomingMessage } from "node:http";
import { WebSocket, WebSocketServer } from "ws";
import type { Duplex } from "node:stream";
import { TelemetryStore } from "../telemetry/telemetryStore.js";

export type TelemetryWebSocketServer = {
  wss: WebSocketServer;
  handleUpgrade: (request: IncomingMessage, socket: Duplex, head: Buffer) => void;
  broadcastLatest: () => void;
  clientCount: () => number;
};

export function createTelemetryWebSocketServer(store: TelemetryStore): TelemetryWebSocketServer {
  const wss = new WebSocketServer({ noServer: true });

  wss.on("connection", (socket) => {
    const latest = store.getLatest();
    if (latest) {
      socket.send(JSON.stringify({ type: "telemetry", snapshot: latest }));
    }
  });

  return {
    wss,
    handleUpgrade(request, socket, head) {
      const url = new URL(request.url || "/", `http://${request.headers.host || "localhost"}`);

      if (url.pathname !== "/ws/telemetry") {
        socket.destroy();
        return;
      }

      wss.handleUpgrade(request, socket, head, (client) => {
        wss.emit("connection", client, request);
      });
    },
    broadcastLatest() {
      const latest = store.getLatest();
      if (!latest) {
        return;
      }

      const payload = JSON.stringify({ type: "telemetry", snapshot: latest });

      for (const client of wss.clients) {
        if (client.readyState === WebSocket.OPEN) {
          client.send(payload);
        }
      }
    },
    clientCount() {
      return wss.clients.size;
    }
  };
}
