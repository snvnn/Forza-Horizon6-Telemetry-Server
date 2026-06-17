import type { TelemetrySnapshot } from "../telemetry/telemetryTypes.js";

type PacketOffsets = {
  engineMaxRpm: number;
  currentRpm: number;
  accelX: number;
  accelY: number;
  accelZ: number;
  speedMs: number;
  powerW: number;
  torqueNm: number;
  tireTempFrontLeft: number;
  tireTempFrontRight: number;
  tireTempRearLeft: number;
  tireTempRearRight: number;
  boost: number;
  throttle: number;
  brake: number;
  clutch: number;
  handbrake: number;
  gear: number;
  steer: number;
};

type DashProfile = {
  name: string;
  dashShift: number;
  minimumLength: number;
  expectedLength?: number;
  priority: number;
  offsets: PacketOffsets;
};

type DashCandidate = {
  profile: DashProfile;
  accepted: boolean;
  score: number;
  errors: string[];
  warnings: string[];
  values?: Record<string, number>;
  snapshot?: TelemetrySnapshot;
};

export type ForzaParserDiagnostics = {
  length: number;
  format: string;
  profile: string;
  dashShift: number | null;
  accepted: boolean;
  errors: string[];
  candidates: Array<{
    profile: string;
    dashShift: number;
    accepted: boolean;
    score: number;
    errors: string[];
    warnings: string[];
    values?: Record<string, number>;
  }>;
};

const SLED_OFFSETS = {
  engineMaxRpm: 8,
  currentRpm: 16,
  accelX: 20,
  accelY: 24,
  accelZ: 28,
  velocityX: 32,
  velocityY: 36,
  velocityZ: 40
};

function createDashOffsets(dashShift: number): PacketOffsets {
  return {
    engineMaxRpm: 8,
    currentRpm: 16,
    accelX: 20,
    accelY: 24,
    accelZ: 28,
    speedMs: 244 + dashShift,
    powerW: 248 + dashShift,
    torqueNm: 252 + dashShift,
    tireTempFrontLeft: 256 + dashShift,
    tireTempFrontRight: 260 + dashShift,
    tireTempRearLeft: 264 + dashShift,
    tireTempRearRight: 268 + dashShift,
    boost: 272 + dashShift,
    throttle: 303 + dashShift,
    brake: 304 + dashShift,
    clutch: 305 + dashShift,
    handbrake: 306 + dashShift,
    gear: 307 + dashShift,
    steer: 308 + dashShift
  };
}

const DASH_PROFILES: DashProfile[] = [
  // FH6 has a single fixed 324-byte packet. It inserts CarGroup,
  // SmashableVelDiff, and SmashableMass after NumCylinders, which shifts the
  // Dash-like fields by 12 bytes compared with Motorsport Dash.
  {
    name: "forza-horizon-6-data-out",
    dashShift: 12,
    minimumLength: 324,
    expectedLength: 324,
    priority: 0,
    offsets: createDashOffsets(12)
  },
  {
    name: "forza-motorsport-dash",
    dashShift: 0,
    minimumLength: 311,
    expectedLength: 311,
    priority: 1,
    offsets: createDashOffsets(0)
  }
];

export type ForzaPacketParserOptions = {
  debugPacket: boolean;
};

function requireLength(packet: Buffer, offset: number, bytes: number): void {
  if (packet.length < offset + bytes) {
    throw new Error(`Packet length ${packet.length} is too short for offset ${offset}`);
  }
}

function readFloat(packet: Buffer, offset: number): number {
  requireLength(packet, offset, 4);
  return packet.readFloatLE(offset);
}

function readUInt8(packet: Buffer, offset: number): number {
  requireLength(packet, offset, 1);
  return packet.readUInt8(offset);
}

function readInt8(packet: Buffer, offset: number): number {
  requireLength(packet, offset, 1);
  return packet.readInt8(offset);
}

function byteToRatio(value: number): number {
  return Math.max(0, Math.min(1, value / 255));
}

function steerToRatio(value: number): number {
  return Math.max(-1, Math.min(1, value / 127));
}

function clampNonNegative(value: number): number {
  return Number.isFinite(value) ? Math.max(0, value) : 0;
}

function zeroSmall(value: number, epsilon = 0.01): number {
  return Math.abs(value) < epsilon ? 0 : value;
}

function fahrenheitToCelsius(value: number): number {
  // Forza Data Out tire values are normalized to Celsius here so the web
  // dashboard matches the in-game tire telemetry screen.
  return (value - 32) * (5 / 9);
}

function finiteOr(value: number, fallback = 0): number {
  return Number.isFinite(value) ? value : fallback;
}

function normalizeGear(rawGear: number): number {
  // FH6 reports reverse as 0 and forward gears as their visible gear number.
  // Do not subtract one here: raw 1 is 1st gear, raw 2 is 2nd gear.
  if (rawGear === 0) {
    return -1;
  }
  return rawGear;
}

function inRange(value: number, min: number, max: number): boolean {
  return Number.isFinite(value) && value >= min && value <= max;
}

function validateRange(errors: string[], name: string, value: number, min: number, max: number): boolean {
  if (!inRange(value, min, max)) {
    errors.push(`${name}=${value} outside ${min}..${max}`);
    return false;
  }
  return true;
}

function tryParseDashProfile(packet: Buffer, profile: DashProfile): DashCandidate {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (profile.expectedLength != null && packet.length !== profile.expectedLength) {
    return {
      profile,
      accepted: false,
      score: 0,
      errors: [`length=${packet.length} expected ${profile.expectedLength}`],
      warnings
    };
  }

  if (packet.length < profile.minimumLength) {
    return {
      profile,
      accepted: false,
      score: 0,
      errors: [`length=${packet.length} shorter than ${profile.minimumLength}`],
      warnings
    };
  }

  try {
    const o = profile.offsets;
    const engineMaxRpm = readFloat(packet, o.engineMaxRpm);
    const currentRpm = readFloat(packet, o.currentRpm);
    const speedKmh = readFloat(packet, o.speedMs) * 3.6;
    const powerKw = readFloat(packet, o.powerW) / 1000;
    const torqueNm = readFloat(packet, o.torqueNm);
    const boost = readFloat(packet, o.boost);
    const tireTempsF = [
      readFloat(packet, o.tireTempFrontLeft),
      readFloat(packet, o.tireTempFrontRight),
      readFloat(packet, o.tireTempRearLeft),
      readFloat(packet, o.tireTempRearRight)
    ];
    const gearRaw = readUInt8(packet, o.gear);
    const values = {
      speedKmh,
      engineMaxRpm,
      currentRpm,
      powerKw,
      torqueNm,
      boost,
      tireTempFrontLeftF: tireTempsF[0],
      tireTempFrontRightF: tireTempsF[1],
      tireTempRearLeftF: tireTempsF[2],
      tireTempRearRightF: tireTempsF[3],
      gearRaw,
      throttleRaw: readUInt8(packet, o.throttle),
      brakeRaw: readUInt8(packet, o.brake),
      clutchRaw: readUInt8(packet, o.clutch),
      steerRaw: readInt8(packet, o.steer)
    };

    let score = 0;
    if (validateRange(warnings, "engineMaxRpm", engineMaxRpm, 100, 25000)) score += 2;
    if (validateRange(warnings, "currentRpm", currentRpm, 0, 25000)) score += 2;
    if (engineMaxRpm > 0 && currentRpm > engineMaxRpm * 1.5) {
      warnings.push(`currentRpm=${currentRpm} too high for engineMaxRpm=${engineMaxRpm}`);
    } else {
      score += 1;
    }
    if (validateRange(warnings, "speedKmh", speedKmh, -1, 650)) score += 3;
    if (validateRange(warnings, "powerKw", powerKw, -2500, 5000)) score += 1;
    if (validateRange(warnings, "torqueNm", torqueNm, -2000, 5000)) score += 1;
    if (validateRange(warnings, "boost", boost, -30, 60)) score += 2;
    for (const [index, tempF] of tireTempsF.entries()) {
      if (validateRange(warnings, `tireTempF[${index}]`, tempF, -40, 450)) score += 1;
    }
    if (gearRaw <= 12) {
      score += 2;
    } else {
      warnings.push(`gearRaw=${gearRaw} outside 0..12`);
    }

    const snapshot: TelemetrySnapshot = {
      timestamp: Date.now(),
      connected: true,
      vehicle: {
        speedKmh: clampNonNegative(zeroSmall(finiteOr(speedKmh))),
        rpm: clampNonNegative(finiteOr(currentRpm)),
        maxRpm: clampNonNegative(finiteOr(engineMaxRpm)),
        gear: normalizeGear(gearRaw),
        powerKw: clampNonNegative(finiteOr(powerKw)),
        torqueNm: clampNonNegative(finiteOr(torqueNm)),
        boost: clampNonNegative(finiteOr(boost))
      },
      input: {
        throttle: byteToRatio(readUInt8(packet, o.throttle)),
        brake: byteToRatio(readUInt8(packet, o.brake)),
        clutch: byteToRatio(readUInt8(packet, o.clutch)),
        steer: steerToRatio(readInt8(packet, o.steer)),
        handbrake: byteToRatio(readUInt8(packet, o.handbrake))
      },
      tires: {
        frontLeftTemp: finiteOr(fahrenheitToCelsius(tireTempsF[0])),
        frontRightTemp: finiteOr(fahrenheitToCelsius(tireTempsF[1])),
        rearLeftTemp: finiteOr(fahrenheitToCelsius(tireTempsF[2])),
        rearRightTemp: finiteOr(fahrenheitToCelsius(tireTempsF[3]))
      },
      motion: {
        accelX: readFloat(packet, o.accelX),
        accelY: readFloat(packet, o.accelY),
        accelZ: readFloat(packet, o.accelZ)
      }
    };

    return { profile, accepted: true, score, errors, warnings, values, snapshot };
  } catch (error) {
    return {
      profile,
      accepted: false,
      score: 0,
      errors: [error instanceof Error ? error.message : String(error)],
      warnings
    };
  }
}

function parseSledFallback(packet: Buffer): TelemetrySnapshot {
  const velocityX = readFloat(packet, SLED_OFFSETS.velocityX);
  const velocityY = readFloat(packet, SLED_OFFSETS.velocityY);
  const velocityZ = readFloat(packet, SLED_OFFSETS.velocityZ);
  const speedKmh = Math.hypot(velocityX, velocityY, velocityZ) * 3.6;
  const currentRpm = readFloat(packet, SLED_OFFSETS.currentRpm);
  const engineMaxRpm = readFloat(packet, SLED_OFFSETS.engineMaxRpm);

  const errors: string[] = [];
  validateRange(errors, "sledSpeedKmh", speedKmh, 0, 650);
  validateRange(errors, "sledCurrentRpm", currentRpm, 0, 25000);
  validateRange(errors, "sledEngineMaxRpm", engineMaxRpm, 0, 25000);

  if (errors.length > 0) {
    throw new Error(`No valid Forza parser profile. ${errors.join("; ")}`);
  }

  return {
    timestamp: Date.now(),
    connected: true,
    vehicle: {
      speedKmh: clampNonNegative(zeroSmall(speedKmh)),
      rpm: clampNonNegative(currentRpm),
      maxRpm: clampNonNegative(engineMaxRpm),
      gear: 0
    },
    input: {
      throttle: 0,
      brake: 0,
      steer: 0
    },
    motion: {
      accelX: readFloat(packet, SLED_OFFSETS.accelX),
      accelY: readFloat(packet, SLED_OFFSETS.accelY),
      accelZ: readFloat(packet, SLED_OFFSETS.accelZ)
    }
  };
}

function toDiagnostics(
  packet: Buffer,
  profile: string,
  dashShift: number | null,
  accepted: boolean,
  errors: string[],
  candidates: DashCandidate[]
): ForzaParserDiagnostics {
  return {
    length: packet.length,
    format: profile,
    profile,
    dashShift,
    accepted,
    errors,
    candidates: candidates.map((candidate) => ({
      profile: candidate.profile.name,
      dashShift: candidate.profile.dashShift,
      accepted: candidate.accepted,
      score: candidate.score,
      errors: candidate.errors,
      warnings: candidate.warnings,
      values: candidate.values
    }))
  };
}

export class ForzaPacketParser {
  private lastDiagnostics: ForzaParserDiagnostics | null = null;

  constructor(private readonly options: ForzaPacketParserOptions) {}

  getLastDiagnostics(): ForzaParserDiagnostics | null {
    return this.lastDiagnostics;
  }

  // Packet parsing is profile-first and validation-first. We never expose a
  // Dash field until one complete candidate layout passes sanity checks.
  parse(packet: Buffer): TelemetrySnapshot {
    const candidates = DASH_PROFILES.map((profile) => tryParseDashProfile(packet, profile)).sort(
      (left, right) =>
        Number(right.accepted) - Number(left.accepted) ||
        right.score - left.score ||
        left.profile.priority - right.profile.priority
    );
    const selected = candidates.find((candidate) => candidate.accepted && candidate.snapshot);

    if (selected?.snapshot) {
      this.lastDiagnostics = toDiagnostics(
        packet,
        selected.profile.name,
        selected.profile.dashShift,
        true,
        [],
        candidates
      );

      if (this.options.debugPacket) {
        console.debug("[packet]", {
          ...this.lastDiagnostics,
          speedKmh: selected.snapshot.vehicle.speedKmh,
          rpm: selected.snapshot.vehicle.rpm,
          gear: selected.snapshot.vehicle.gear
        });
      }

      return selected.snapshot;
    }

    const fallback = parseSledFallback(packet);
    const errors = candidates.flatMap((candidate) =>
      candidate.errors.map((error) => `${candidate.profile.name}: ${error}`)
    );
    this.lastDiagnostics = toDiagnostics(
      packet,
      "forza-sled-fallback",
      null,
      true,
      errors,
      candidates
    );

    if (this.options.debugPacket) {
      console.debug("[packet]", {
        ...this.lastDiagnostics,
        speedKmh: fallback.vehicle.speedKmh,
        rpm: fallback.vehicle.rpm
      });
    }

    return fallback;
  }
}

export function createMockTelemetrySnapshot(now = Date.now()): TelemetrySnapshot {
  const seconds = now / 1000;
  const rpm = 2800 + Math.sin(seconds * 2.4) * 1800 + Math.sin(seconds * 0.7) * 600;
  const speed = 90 + Math.sin(seconds * 0.9) * 45 + Math.max(0, Math.sin(seconds * 0.18)) * 70;
  const throttle = Math.max(0, Math.min(1, 0.55 + Math.sin(seconds * 1.8) * 0.42));
  const brake = Math.max(0, Math.min(1, Math.sin(seconds * 0.85 + 2.4) * 0.5 - 0.2));

  return {
    timestamp: now,
    connected: true,
    vehicle: {
      speedKmh: Math.max(0, speed),
      rpm: Math.max(900, rpm),
      maxRpm: 7500,
      gear: Math.max(1, Math.min(6, Math.floor(speed / 45) + 1)),
      powerKw: 210 + throttle * 180,
      torqueNm: 320 + throttle * 220,
      boost: Math.max(0, throttle * 1.2 - brake * 0.4)
    },
    input: {
      throttle,
      brake,
      clutch: 0,
      steer: Math.sin(seconds * 1.2) * 0.85,
      handbrake: 0
    },
    tires: {
      frontLeftTemp: 78 + Math.sin(seconds * 0.8) * 6,
      frontRightTemp: 80 + Math.cos(seconds * 0.7) * 5,
      rearLeftTemp: 84 + Math.sin(seconds * 0.95) * 7,
      rearRightTemp: 83 + Math.cos(seconds * 0.9) * 7
    },
    motion: {
      accelX: Math.sin(seconds * 1.2) * 2.5,
      accelY: throttle * 5 - brake * 7,
      accelZ: 9.8
    }
  };
}
