import type { TelemetrySnapshot } from "./telemetryTypes.js";

export class TelemetryStore {
  private latest: TelemetrySnapshot | null = null;
  private lastPacketAt = 0;

  constructor(private readonly connectionTimeoutMs: number) {}

  // The store keeps only the latest normalized state in memory. There is no DB,
  // queue, file export, or historical buffer in this MVP.
  update(snapshot: TelemetrySnapshot): void {
    const now = Date.now();
    this.lastPacketAt = now;
    this.latest = {
      ...snapshot,
      timestamp: snapshot.timestamp || now,
      connected: true
    };
  }

  getLatest(): TelemetrySnapshot | null {
    if (!this.latest) {
      return null;
    }

    return {
      ...this.latest,
      connected: this.isConnected()
    };
  }

  getLastPacketAt(): number {
    return this.lastPacketAt;
  }

  hasTelemetry(): boolean {
    return this.latest !== null;
  }

  isConnected(now = Date.now()): boolean {
    return this.lastPacketAt > 0 && now - this.lastPacketAt <= this.connectionTimeoutMs;
  }
}
