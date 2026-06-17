import type {
  TelemetryConnectionStatus,
  TelemetryClientMetrics,
  TelemetryMessage,
  TelemetrySnapshot
} from "./telemetryTypes";

type StatusListener = (status: TelemetryConnectionStatus) => void;

const MESSAGE_INTERVAL_EMA_ALPHA = 0.1;

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
    renderSnapshotAgeMs: null
  };
}

export class TelemetryClient {
  private socket: WebSocket | null = null;
  private latest: TelemetrySnapshot | null = null;
  private metrics: TelemetryClientMetrics = createInitialMetrics();
  private status: TelemetryConnectionStatus = "connecting";
  private reconnectTimer: number | null = null;
  private shouldReconnect = false;
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

  subscribeStatus(listener: StatusListener): () => void {
    this.listeners.add(listener);
    listener(this.status);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private connect(): void {
    const protocol = window.location.protocol === "https:" ? "wss" : "ws";
    const url = `${protocol}://${window.location.host}/ws/telemetry`;

    this.setStatus(this.latest ? "reconnecting" : "connecting");
    const socket = new WebSocket(url);
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
        const message = JSON.parse(event.data as string) as TelemetryMessage;
        if (message.type === "telemetry") {
          // WebSocket messages only update the latest snapshot reference. React
          // state is updated by useTelemetry at VITE_RENDER_HZ, not per packet.
          this.latest = message.snapshot;
          this.recordMessage(message.snapshot);
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
    this.metrics.snapshotAgeMs = receiveAt - snapshot.timestamp;
  }
}
