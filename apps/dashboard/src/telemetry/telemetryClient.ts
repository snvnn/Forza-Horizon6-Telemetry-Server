import type { TransportMode } from "../settings/settingsTypes";
import type {
  TelemetryConnectionStatus,
  TelemetryClientMetrics,
  TelemetryMessage,
  TelemetrySnapshot
} from "./telemetryTypes";

type StatusListener = (status: TelemetryConnectionStatus) => void;

const MESSAGE_INTERVAL_EMA_ALPHA = 0.1;
const CLOCK_SYNC_EMA_ALPHA = 0.2;
const BINARY_TELEMETRY_VERSION = 1;
const BINARY_TELEMETRY_FRAME_LEN = 80;
const FLAG_CONNECTED = 0b0000_0001;
const FLAG_TIRES = 0b0000_0010;
const FLAG_MOTION = 0b0000_0100;

function createInitialMetrics(): TelemetryClientMetrics {
  return {
    receivedMessages: 0,
    parseErrors: 0,
    lastReceiveAt: null,
    lastReceivePerformanceMs: null,
    lastSnapshotTimestamp: null,
    snapshotAgeMs: null,
    messageIntervalEmaMs: null,
    estimatedMessageHz: null,
    maxMessageGapMs: 0,
    renderFrames: 0,
    receiveToRenderMs: null,
    renderSnapshotAgeMs: null,
    serverClockOffsetMs: null,
    serverClockRttMs: null
  };
}

export class TelemetryClient {
  private socket: WebSocket | null = null;
  private latest: TelemetrySnapshot | null = null;
  private metrics: TelemetryClientMetrics = createInitialMetrics();
  private status: TelemetryConnectionStatus = "connecting";
  private reconnectTimer: number | null = null;
  private shouldReconnect = false;
  private transportMode: TransportMode = "json";
  private readonly listeners = new Set<StatusListener>();

  start(): void {
    this.shouldReconnect = true;
    if (this.socket && this.socket.readyState !== WebSocket.CLOSED) {
      return;
    }
    this.connect();
  }

  stop(): void {
    this.shouldReconnect = false;

    if (this.reconnectTimer !== null) {
      window.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    this.socket?.close();
    this.socket = null;
    this.setStatus("disconnected");
  }

  getLatest(): TelemetrySnapshot | null {
    return this.latest;
  }

  getMetrics(): TelemetryClientMetrics {
    return { ...this.metrics };
  }

  setLatest(snapshot: TelemetrySnapshot): void {
    this.latest = snapshot;
  }

  getStatus(): TelemetryConnectionStatus {
    return this.status;
  }

  getServerAlignedNow(): number {
    return Date.now() + (this.metrics.serverClockOffsetMs ?? 0);
  }

  async syncServerClock(): Promise<void> {
    const requestClientTimeMs = Date.now();
    const requestPerformanceMs = performance.now();
    const response = await fetch("/api/time", { cache: "no-store" });
    const responseClientTimeMs = Date.now();
    const rttMs = performance.now() - requestPerformanceMs;

    if (!response.ok) {
      throw new Error("Failed to sync server clock");
    }

    const payload = (await response.json()) as { ok?: boolean; serverTimeMs?: number };
    const serverTimeMs = payload.serverTimeMs;
    if (payload.ok !== true || typeof serverTimeMs !== "number" || !Number.isFinite(serverTimeMs)) {
      throw new Error("Invalid server clock response");
    }

    // Estimate server-client clock offset from the midpoint of the HTTP round trip.
    // This removes tablet/PC wall-clock offset from Age without changing telemetry timestamps.
    const clientMidpointMs = (requestClientTimeMs + responseClientTimeMs) / 2;
    const measuredOffsetMs = serverTimeMs - clientMidpointMs;
    this.metrics.serverClockOffsetMs =
      this.metrics.serverClockOffsetMs == null
        ? measuredOffsetMs
        : this.metrics.serverClockOffsetMs * (1 - CLOCK_SYNC_EMA_ALPHA) +
          measuredOffsetMs * CLOCK_SYNC_EMA_ALPHA;
    this.metrics.serverClockRttMs = rttMs;
  }

  setTransportMode(mode: TransportMode): void {
    if (this.transportMode === mode) {
      return;
    }

    this.transportMode = mode;
    if (!this.shouldReconnect) {
      return;
    }

    if (this.reconnectTimer !== null) {
      window.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    const socket = this.socket;
    this.socket = null;
    socket?.close();
    this.connect();
  }

  subscribeStatus(listener: StatusListener): () => void {
    this.listeners.add(listener);
    listener(this.status);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private connect(): void {
    const protocol = window.location.protocol === "https:" ? "wss" : "ws";
    const path = this.transportMode === "binary" ? "/ws/telemetry.bin" : "/ws/telemetry";
    const url = `${protocol}://${window.location.host}${path}`;

    this.setStatus(this.latest ? "reconnecting" : "connecting");
    const socket = new WebSocket(url);
    socket.binaryType = "arraybuffer";
    this.socket = socket;

    socket.addEventListener("open", () => {
      if (this.socket !== socket) {
        return;
      }
      this.setStatus("connected");
    });

    socket.addEventListener("message", (event) => {
      if (this.socket !== socket) {
        return;
      }

      try {
        const snapshot = this.parseTelemetryEvent(event.data);
        if (snapshot) {
          // WebSocket messages only update the latest snapshot reference. React
          // state is updated by useTelemetry at the configured render Hz, not per packet.
          this.latest = snapshot;
          this.recordMessage(snapshot);
        }
      } catch (error) {
        this.metrics.parseErrors += 1;
        console.error("[telemetry] Failed to parse WebSocket message", error);
      }
    });

    socket.addEventListener("close", () => {
      if (this.socket !== socket) {
        return;
      }

      this.socket = null;
      this.scheduleReconnect();
    });

    socket.addEventListener("error", () => {
      if (this.socket === socket) {
        socket.close();
      }
    });
  }

  private parseTelemetryEvent(data: unknown): TelemetrySnapshot | null {
    if (this.transportMode === "binary") {
      if (!(data instanceof ArrayBuffer)) {
        throw new Error("Expected binary telemetry ArrayBuffer");
      }
      return parseBinaryTelemetryFrame(data);
    }

    if (typeof data !== "string") {
      throw new Error("Expected JSON telemetry string");
    }
    const message = JSON.parse(data) as TelemetryMessage;
    return message.type === "telemetry" ? message.snapshot : null;
  }

  private scheduleReconnect(): void {
    if (!this.shouldReconnect) {
      return;
    }

    if (this.reconnectTimer !== null) {
      return;
    }

    // Automatic reconnect keeps tablet dashboards alive when the server restarts
    // or Wi-Fi briefly drops.
    this.setStatus("reconnecting");
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, 1000);
  }

  private setStatus(status: TelemetryConnectionStatus): void {
    if (this.status === status) {
      return;
    }

    this.status = status;
    for (const listener of this.listeners) {
      listener(status);
    }
  }

  private recordMessage(snapshot: TelemetrySnapshot): void {
    const receiveAt = Date.now();
    const receivePerformanceMs = performance.now();
    const previousReceivePerformanceMs = this.metrics.lastReceivePerformanceMs;

    if (previousReceivePerformanceMs != null) {
      const gapMs = receivePerformanceMs - previousReceivePerformanceMs;
      this.metrics.maxMessageGapMs = Math.max(this.metrics.maxMessageGapMs, gapMs);
      this.metrics.messageIntervalEmaMs =
        this.metrics.messageIntervalEmaMs == null
          ? gapMs
          : this.metrics.messageIntervalEmaMs * (1 - MESSAGE_INTERVAL_EMA_ALPHA) +
            gapMs * MESSAGE_INTERVAL_EMA_ALPHA;
      this.metrics.estimatedMessageHz =
        this.metrics.messageIntervalEmaMs > 0 ? 1000 / this.metrics.messageIntervalEmaMs : null;
    }

    this.metrics.receivedMessages += 1;
    this.metrics.lastReceiveAt = receiveAt;
    this.metrics.lastReceivePerformanceMs = receivePerformanceMs;
    this.metrics.lastSnapshotTimestamp = snapshot.timestamp;
    this.metrics.snapshotAgeMs = this.getServerAlignedNow() - snapshot.timestamp;
  }
}

export function parseBinaryTelemetryFrame(buffer: ArrayBuffer): TelemetrySnapshot {
  if (buffer.byteLength !== BINARY_TELEMETRY_FRAME_LEN) {
    throw new Error(`Invalid binary telemetry frame length: ${buffer.byteLength}`);
  }

  const view = new DataView(buffer);
  const version = view.getUint8(0);
  if (version !== BINARY_TELEMETRY_VERSION) {
    throw new Error(`Unsupported binary telemetry version: ${version}`);
  }

  const flags = view.getUint8(1);
  const gear = view.getInt8(2);
  const timestamp = readU64LeAsNumber(view, 8);
  let offset = 16;
  const nextF32 = () => {
    const value = view.getFloat32(offset, true);
    offset += 4;
    return value;
  };
  const optional = (value: number) => (Number.isFinite(value) ? value : undefined);

  const speedKmh = nextF32();
  const rpm = nextF32();
  const maxRpm = optional(nextF32());
  const throttle = nextF32();
  const brake = nextF32();
  const steer = nextF32();
  const powerKw = optional(nextF32());
  const torqueNm = optional(nextF32());
  const boost = optional(nextF32());
  const frontLeftTemp = nextF32();
  const frontRightTemp = nextF32();
  const rearLeftTemp = nextF32();
  const rearRightTemp = nextF32();
  const accelX = optional(nextF32());
  const accelY = optional(nextF32());
  const accelZ = optional(nextF32());

  return {
    timestamp,
    connected: (flags & FLAG_CONNECTED) !== 0,
    vehicle: {
      speedKmh,
      rpm,
      maxRpm,
      gear,
      powerKw,
      torqueNm,
      boost
    },
    input: {
      throttle,
      brake,
      steer
    },
    tires:
      (flags & FLAG_TIRES) !== 0
        ? {
            frontLeftTemp,
            frontRightTemp,
            rearLeftTemp,
            rearRightTemp
          }
        : undefined,
    motion:
      (flags & FLAG_MOTION) !== 0
        ? {
            accelX,
            accelY,
            accelZ
          }
        : undefined
  };
}

function readU64LeAsNumber(view: DataView, offset: number): number {
  return Number(view.getBigUint64(offset, true));
}
