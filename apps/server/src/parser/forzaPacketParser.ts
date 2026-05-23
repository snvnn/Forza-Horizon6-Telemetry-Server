import type { TelemetrySnapshot } from "../telemetry/telemetryTypes.js";

type PacketOffsets = {
  name: string;
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

function createDashOffsets(name: string, dashShift = 0): PacketOffsets {
  return {
    name,
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

const FORZA_DASH_OFFSETS: PacketOffsets = createDashOffsets("forza-dash", 0);

// Forza Horizon 5 Dash packets include a 12-byte Horizon-specific placeholder
// after the Sled section, so dashboard fields such as speed, gear, and torque
// are shifted by 12 bytes compared with the Motorsport/FM7 Dash layout.
const FORZA_HORIZON_DASH_OFFSETS: PacketOffsets = createDashOffsets("forza-horizon-dash", 12);

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

function normalizeGear(rawGear: number): number {
  // Common Forza Data Out mapping is 0=reverse, 1=neutral, 2=first gear.
  if (rawGear === 0) {
    return -1;
  }
  if (rawGear === 1) {
    return 0;
  }
  return rawGear - 1;
}

function isReasonable(value: number, min: number, max: number): boolean {
  return Number.isFinite(value) && value >= min && value <= max;
}

function scoreOffsets(packet: Buffer, offsets: PacketOffsets): number {
  try {
    const speedKmh = readFloat(packet, offsets.speedMs) * 3.6;
    const powerKw = readFloat(packet, offsets.powerW) / 1000;
    const torqueNm = readFloat(packet, offsets.torqueNm);
    const tireTemps = [
      readFloat(packet, offsets.tireTempFrontLeft),
      readFloat(packet, offsets.tireTempFrontRight),
      readFloat(packet, offsets.tireTempRearLeft),
      readFloat(packet, offsets.tireTempRearRight)
    ];
    const boost = readFloat(packet, offsets.boost);
    const gearRaw = readUInt8(packet, offsets.gear);

    let score = 0;
    if (isReasonable(speedKmh, 0, 650)) score += 3;
    if (isReasonable(powerKw, -1500, 2500)) score += 2;
    if (isReasonable(torqueNm, -2000, 3000)) score += 2;
    score += tireTemps.filter((value) => isReasonable(value, -50, 350)).length;
    if (isReasonable(boost, -5, 20)) score += 1;
    if (gearRaw >= 0 && gearRaw <= 12) score += 2;
    return score;
  } catch {
    return -1;
  }
}

function chooseOffsets(packet: Buffer): PacketOffsets | null {
  const candidates = [FORZA_HORIZON_DASH_OFFSETS, FORZA_DASH_OFFSETS];
  const ranked = candidates
    .map((offsets) => ({ offsets, score: scoreOffsets(packet, offsets) }))
    .sort((left, right) => right.score - left.score);

  return ranked[0]?.score >= 0 ? ranked[0].offsets : null;
}

export class ForzaPacketParser {
  constructor(
    private readonly options: ForzaPacketParserOptions,
    private readonly offsets?: PacketOffsets
  ) {}

  // The parser is intentionally offset-based so FH5, FH6, Motorsport, or a
  // changed Dash packet can be supported by swapping the offset map.
  parse(packet: Buffer): TelemetrySnapshot {
    const o = this.offsets ?? chooseOffsets(packet);

    if (!o) {
      const velocityX = readFloat(packet, SLED_OFFSETS.velocityX);
      const velocityY = readFloat(packet, SLED_OFFSETS.velocityY);
      const velocityZ = readFloat(packet, SLED_OFFSETS.velocityZ);
      const speedMs = Math.hypot(velocityX, velocityY, velocityZ);

      return {
        timestamp: Date.now(),
        connected: true,
        vehicle: {
          speedKmh: Math.max(0, speedMs * 3.6),
          rpm: Math.max(0, readFloat(packet, SLED_OFFSETS.currentRpm)),
          maxRpm: Math.max(0, readFloat(packet, SLED_OFFSETS.engineMaxRpm)),
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

    const snapshot: TelemetrySnapshot = {
      timestamp: Date.now(),
      connected: true,
      vehicle: {
        speedKmh: Math.max(0, readFloat(packet, o.speedMs) * 3.6),
        rpm: Math.max(0, readFloat(packet, o.currentRpm)),
        maxRpm: Math.max(0, readFloat(packet, o.engineMaxRpm)),
        gear: normalizeGear(readUInt8(packet, o.gear)),
        powerKw: readFloat(packet, o.powerW) / 1000,
        torqueNm: clampNonNegative(readFloat(packet, o.torqueNm)),
        boost: clampNonNegative(readFloat(packet, o.boost))
      },
      input: {
        throttle: byteToRatio(readUInt8(packet, o.throttle)),
        brake: byteToRatio(readUInt8(packet, o.brake)),
        clutch: byteToRatio(readUInt8(packet, o.clutch)),
        steer: steerToRatio(readInt8(packet, o.steer)),
        handbrake: byteToRatio(readUInt8(packet, o.handbrake))
      },
      tires: {
        frontLeftTemp: readFloat(packet, o.tireTempFrontLeft),
        frontRightTemp: readFloat(packet, o.tireTempFrontRight),
        rearLeftTemp: readFloat(packet, o.tireTempRearLeft),
        rearRightTemp: readFloat(packet, o.tireTempRearRight)
      },
      motion: {
        accelX: readFloat(packet, o.accelX),
        accelY: readFloat(packet, o.accelY),
        accelZ: readFloat(packet, o.accelZ)
      }
    };

    if (this.options.debugPacket) {
      console.debug("[packet]", {
        format: o.name,
        length: packet.length,
        speedKmh: snapshot.vehicle.speedKmh,
        rpm: snapshot.vehicle.rpm,
        gear: snapshot.vehicle.gear,
        throttle: snapshot.input.throttle,
        brake: snapshot.input.brake
      });
    }

    return snapshot;
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
