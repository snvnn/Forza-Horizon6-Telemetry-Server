import type { TelemetrySnapshot } from "./telemetryTypes.js";

export type TelemetryPacketInfo = {
  length: number;
  format?: string;
  profile: string;
  dashShift: number | null;
  accepted: boolean;
  errors: string[];
  candidates?: Array<{
    profile: string;
    dashShift: number;
    accepted: boolean;
    score: number;
    errors: string[];
    warnings?: string[];
    values?: Record<string, number>;
  }>;
};

export class TelemetryStore {
  private latest: TelemetrySnapshot | null = null;
  private lastPacketAt = 0;
  private lastPacketInfo: TelemetryPacketInfo | null = null;

  constructor(private readonly connectionTimeoutMs: number) {}

  // The store keeps only the latest normalized state in memory. There is no DB,
  // queue, file export, or historical buffer in this MVP.
  update(snapshot: TelemetrySnapshot, packetInfo?: TelemetryPacketInfo | null): void {
    const now = Date.now();
    this.lastPacketAt = now;
    if (packetInfo) {
      this.lastPacketInfo = packetInfo;
    }
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

  getLastPacketInfo(): TelemetryPacketInfo | null {
    return this.lastPacketInfo;
  }

  setLastPacketInfo(packetInfo: TelemetryPacketInfo): void {
    this.lastPacketInfo = packetInfo;
  }

  hasTelemetry(): boolean {
    return this.latest !== null;
  }

  isConnected(now = Date.now()): boolean {
    return this.lastPacketAt > 0 && now - this.lastPacketAt <= this.connectionTimeoutMs;
  }
}
