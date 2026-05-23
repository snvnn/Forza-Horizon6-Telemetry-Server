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
};

export type TelemetryConnectionStatus = "connecting" | "connected" | "reconnecting" | "disconnected";

export type TelemetryMessage = {
  type: "telemetry";
  snapshot: TelemetrySnapshot;
};
