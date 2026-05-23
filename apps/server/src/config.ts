import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export type AppConfig = {
  udpPort: number;
  httpPort: number;
  host: string;
  broadcastHz: number;
  broadcastIntervalMs: number;
  mockTelemetry: boolean;
  debugPacket: boolean;
  connectionTimeoutMs: number;
};

const thisDir = fileURLToPath(new URL(".", import.meta.url));

for (const envPath of [
  resolve(process.cwd(), ".env"),
  resolve(process.cwd(), "../../.env"),
  resolve(thisDir, "../../../.env")
]) {
  if (existsSync(envPath)) {
    loadEnvFile(envPath);
  }
}

function loadEnvFile(envPath: string): void {
  const content = readFileSync(envPath, "utf8");

  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }

    const equalsIndex = trimmed.indexOf("=");
    if (equalsIndex === -1) {
      continue;
    }

    const key = trimmed.slice(0, equalsIndex).trim();
    const value = trimmed.slice(equalsIndex + 1).trim().replace(/^["']|["']$/g, "");

    if (key && process.env[key] == null) {
      process.env[key] = value;
    }
  }
}

function parsePort(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 && parsed <= 65535 ? parsed : fallback;
}

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value == null || value.trim() === "") {
    return fallback;
  }

  return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}

function parseHz(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 1 && parsed <= 120 ? parsed : fallback;
}

function parsePositiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export function loadConfig(): AppConfig {
  const broadcastHz = parseHz(process.env.TELEMETRY_BROADCAST_HZ, 60);

  return {
    udpPort: parsePort(process.env.UDP_PORT, 5400),
    httpPort: parsePort(process.env.HTTP_PORT, 3000),
    // Binding to 0.0.0.0 lets phones and tablets on the same LAN reach the PC.
    host: process.env.HOST?.trim() || "0.0.0.0",
    broadcastHz,
    broadcastIntervalMs: 1000 / broadcastHz,
    mockTelemetry: parseBoolean(process.env.MOCK_TELEMETRY, false),
    debugPacket: parseBoolean(process.env.DEBUG_PACKET, false),
    connectionTimeoutMs: parsePositiveInteger(process.env.CONNECTION_TIMEOUT_MS, 2000)
  };
}
