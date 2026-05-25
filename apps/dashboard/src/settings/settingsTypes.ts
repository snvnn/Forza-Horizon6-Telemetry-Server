export type ServerConfig = {
  gameAdapter: string;
  httpHost: string;
  httpPort: number;
  udpHost: string;
  udpPort: number;
  broadcastHz: number;
  connectionTimeoutMs: number;
  mockTelemetry: boolean;
  debugPacket: boolean;
};

export type DashboardUrls = {
  localDashboardUrl: string;
  localSettingsUrl: string;
  networkDashboardUrl?: string | null;
};

export type ConfigResponse = {
  ok: boolean;
  config: ServerConfig;
  supportedGameAdapters: string[];
  urls: DashboardUrls;
  warnings: string[];
};

export type StatusResponse = {
  ok: boolean;
  appRunning: boolean;
  telemetryRunning: boolean;
  connected: boolean;
  gameConnected: boolean;
  hasTelemetry: boolean;
  lastPacketAt: number | null;
  receivedPacketCount: number;
  websocketClients: number;
  udpListeningAddress?: string | null;
  httpListeningAddress: string;
  gameAdapter: string;
  broadcastHz: number;
  broadcastIntervalMs: number;
  mockTelemetry: boolean;
  connectionTimeoutMs: number;
  urls: DashboardUrls;
};

export type ConfigSaveResponse = {
  ok: boolean;
  config: ServerConfig;
  requiresTelemetryRestart: boolean;
  requiresAppRestart: boolean;
  warnings: string[];
};
