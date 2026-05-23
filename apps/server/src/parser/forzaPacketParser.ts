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

const FORZA_DASH_OFFSETS: PacketOffsets = {
  engineMaxRpm: 8,
  currentRpm: 16,
  accelX: 20,
  accelY: 24,
  accelZ: 28,
  speedMs: 244,
  powerW: 248,
  torqueNm: 252,
  tireTempFrontLeft: 256,
  tireTempFrontRight: 260,
  tireTempRearLeft: 264,
  tireTempRearRight: 268,
  boost: 272,
  throttle: 303,
  brake: 304,
  clutch: 305,
  handbrake: 306,
  gear: 307,
  steer: 308
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

export class ForzaPacketParser {
  constructor(
    private readonly options: ForzaPacketParserOptions,
    private readonly offsets: PacketOffsets = FORZA_DASH_OFFSETS
  ) {}

  // The parser is intentionally offset-based so FH5, FH6, Motorsport, or a
  // changed Dash packet can be supported by swapping the offset map.
  parse(packet: Buffer): TelemetrySnapshot {
    const o = this.offsets;

    const snapshot: TelemetrySnapshot = {
      timestamp: Date.now(),
      connected: true,
      vehicle: {
        speedKmh: Math.max(0, readFloat(packet, o.speedMs) * 3.6),
        rpm: Math.max(0, readFloat(packet, o.currentRpm)),
        maxRpm: Math.max(0, readFloat(packet, o.engineMaxRpm)),
        gear: normalizeGear(readUInt8(packet, o.gear)),
        powerKw: readFloat(packet, o.powerW) / 1000,
        torqueNm: readFloat(packet, o.torqueNm),
        boost: readFloat(packet, o.boost)
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
