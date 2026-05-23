import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { extname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { AppConfig } from "../config.js";
import { TelemetryStore } from "../telemetry/telemetryStore.js";
import type { TelemetryWebSocketServer } from "../websocket/telemetryWebSocket.js";

const dashboardDistPath = fileURLToPath(new URL("../../../dashboard/dist/", import.meta.url));

const contentTypes: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon"
};

function sendJson(response: ServerResponse, statusCode: number, body: unknown): void {
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store"
  });
  response.end(JSON.stringify(body));
}

function isPathInside(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}

function serveStatic(request: IncomingMessage, response: ServerResponse): void {
  if (!existsSync(dashboardDistPath)) {
    sendJson(response, 404, {
      error: "Dashboard build not found. Run npm run build before npm start, or use npm run dev."
    });
    return;
  }

  const url = new URL(request.url || "/", "http://localhost");
  const requestedPath = url.pathname === "/" ? "/index.html" : url.pathname;
  let decodedPath: string;

  try {
    decodedPath = decodeURIComponent(requestedPath);
  } catch {
    sendJson(response, 400, { error: "Bad request" });
    return;
  }

  let filePath = resolve(dashboardDistPath, `.${decodedPath}`);

  if (!isPathInside(dashboardDistPath, filePath)) {
    sendJson(response, 403, { error: "Forbidden" });
    return;
  }

  if (!existsSync(filePath) || statSync(filePath).isDirectory()) {
    filePath = join(dashboardDistPath, "index.html");
  }

  const extension = extname(filePath);
  response.writeHead(200, {
    "content-type": contentTypes[extension] || "application/octet-stream"
  });

  if (request.method === "HEAD") {
    response.end();
    return;
  }

  createReadStream(filePath).pipe(response);
}

export function createTelemetryHttpServer(
  config: AppConfig,
  store: TelemetryStore,
  wsServer: TelemetryWebSocketServer
) {
  const server = createServer((request, response) => {
    const url = new URL(request.url || "/", `http://${request.headers.host || "localhost"}`);

    if (request.method === "GET" && url.pathname === "/api/status") {
      sendJson(response, 200, {
        ok: true,
        connected: store.isConnected(),
        hasTelemetry: store.hasTelemetry(),
        lastPacketAt: store.getLastPacketAt() || null,
        websocketClients: wsServer.clientCount(),
        udpPort: config.udpPort,
        httpPort: config.httpPort,
        host: config.host,
        broadcastHz: config.broadcastHz,
        broadcastIntervalMs: config.broadcastIntervalMs,
        mockTelemetry: config.mockTelemetry,
        connectionTimeoutMs: config.connectionTimeoutMs
      });
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/telemetry") {
      sendJson(response, 200, {
        snapshot: store.getLatest()
      });
      return;
    }

    if (request.method === "GET" || request.method === "HEAD") {
      serveStatic(request, response);
      return;
    }

    sendJson(response, 405, { error: "Method not allowed" });
  });

  server.on("upgrade", wsServer.handleUpgrade);

  return server;
}
