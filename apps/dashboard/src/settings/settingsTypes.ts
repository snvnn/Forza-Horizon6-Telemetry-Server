export type TransportMode = "json" | "binary";
export type DashboardLayout =
  | "race"
  | "time-attack"
  | "engineer"
  | "mobile-race"
  | "minimal"
  | "gforce";

export type ServerConfig = {
  gameAdapter: string;
  httpHost: string;
  httpPort: number;
  udpHost: string;
  udpPort: number;
  udpReceiveBufferBytes: number;
  broadcastHz: number;
  transportMode: TransportMode;
  dashboardLayout: DashboardLayout;
  dashboardRenderHz: number;
  websocketSendTimeoutMs: number;
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
  supportedDashboardLayouts: DashboardLayout[];
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
  lastPacketInfoAt?: number | null;
  lastPacketAgeMs?: number | null;
  packetIntervalEmaMs?: number | null;
  estimatedPacketHz?: number | null;
  maxPacketGapMs?: number;
  packetGapCount?: number;
  packetGapWarningMs?: number;
  packetGapHistogram?: {
    le8Ms: number;
    le16Ms: number;
    le33Ms: number;
    le50Ms: number;
    le100Ms: number;
    le250Ms: number;
    gt250Ms: number;
  };
  recentPacketGaps?: Array<{
    at: number;
    gapMs: number;
  }>;
  receivedPacketCount: number;
  websocketClients: number;
  udpListeningAddress?: string | null;
  udpReceiveBufferBytes?: number;
  httpListeningAddress: string;
  gameAdapter: string;
  broadcastHz: number;
  broadcastIntervalMs: number;
  transportMode: TransportMode;
  dashboardLayout: DashboardLayout;
  dashboardRenderHz: number;
  websocketSendTimeoutMs: number;
  broadcastStats?: {
    broadcastRequestCount: number;
    broadcastCount: number;
    coalescedBroadcastRequests: number;
    lastBroadcastAt?: number | null;
    broadcastIntervalEmaMs?: number | null;
    estimatedBroadcastHz?: number | null;
    lastSnapshotAgeMsAtBroadcast?: number | null;
    maxSnapshotAgeMsAtBroadcast: number;
    lastPayloadBytes: number;
    maxPayloadBytes: number;
    serializationErrors: number;
    websocketSendCount: number;
    websocketSendErrors: number;
    websocketSendTimeouts: number;
    lastWebsocketSendMs?: number | null;
    maxWebsocketSendMs: number;
  };
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
