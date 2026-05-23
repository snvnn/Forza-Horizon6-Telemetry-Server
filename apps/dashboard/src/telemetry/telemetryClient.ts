import type {
  TelemetryConnectionStatus,
  TelemetryMessage,
  TelemetrySnapshot
} from "./telemetryTypes";

type StatusListener = (status: TelemetryConnectionStatus) => void;

export class TelemetryClient {
  private socket: WebSocket | null = null;
  private latest: TelemetrySnapshot | null = null;
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
        }
      } catch (error) {
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
}
