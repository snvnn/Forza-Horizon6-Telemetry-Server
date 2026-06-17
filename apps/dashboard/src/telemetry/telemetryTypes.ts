export type TelemetrySnapshot = {
  timestamp: number;
  connected: boolean;
  vehicle: {
    speedKmh: number;
    rpm: number;
    maxRpm?: number;
    gear: number;
    powerKw?: number;
    torqueNm?: number;
    boost?: number;
  };
  input: {
    throttle: number;
    brake: number;
    clutch?: number;
    steer: number;
    handbrake?: number;
  };
  tires?: {
    frontLeftTemp: number;
    frontRightTemp: number;
    rearLeftTemp: number;
    rearRightTemp: number;
  };
  motion?: {
    accelX?: number;
    accelY?: number;
    accelZ?: number;
  };
  race?: {
    active: boolean;
    bestLapSeconds?: number;
    lastLapSeconds?: number;
    currentLapSeconds?: number;
    currentRaceTimeSeconds?: number;
    lapNumber?: number;
    position?: number;
    fuel?: number;
    distanceTraveledMeters?: number;
  };
};

export type TelemetryConnectionStatus = "connecting" | "connected" | "reconnecting" | "disconnected";

export type TelemetryClientMetrics = {
  receivedMessages: number;
  parseErrors: number;
  lastReceiveAt: number | null;
  lastReceivePerformanceMs: number | null;
  lastSnapshotTimestamp: number | null;
  snapshotAgeMs: number | null;
  messageIntervalEmaMs: number | null;
  estimatedMessageHz: number | null;
  maxMessageGapMs: number;
  renderFrames: number;
  receiveToRenderMs: number | null;
  renderSnapshotAgeMs: number | null;
};

export type TelemetryMessage = {
  type: "telemetry";
  snapshot: TelemetrySnapshot;
};
