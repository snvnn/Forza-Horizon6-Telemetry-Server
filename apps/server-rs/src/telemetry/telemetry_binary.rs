use bytes::{BufMut, Bytes, BytesMut};

use super::telemetry_types::TelemetrySnapshot;

pub const BINARY_TELEMETRY_VERSION: u8 = 1;
pub const BINARY_TELEMETRY_FRAME_LEN: usize = 80;

const FLAG_CONNECTED: u8 = 0b0000_0001;
const FLAG_TIRES: u8 = 0b0000_0010;
const FLAG_MOTION: u8 = 0b0000_0100;

pub fn encode_binary_telemetry_frame(snapshot: &TelemetrySnapshot, sequence: u32) -> Bytes {
    let mut buffer = BytesMut::with_capacity(BINARY_TELEMETRY_FRAME_LEN);
    let flags = binary_flags(snapshot);

    buffer.put_u8(BINARY_TELEMETRY_VERSION);
    buffer.put_u8(flags);
    buffer.put_i8(clamp_i8(snapshot.vehicle.gear));
    buffer.put_u8(0);
    buffer.put_u32_le(sequence);
    buffer.put_u64_le(snapshot.timestamp);

    // Binary v1 intentionally contains only the hot-path dashboard fields.
    // Race/lap fields stay in JSON mode for now so the frontend is not coupled
    // to a game-specific timing layout.
    put_f32(&mut buffer, snapshot.vehicle.speed_kmh);
    put_f32(&mut buffer, snapshot.vehicle.rpm);
    put_optional_f32(&mut buffer, snapshot.vehicle.max_rpm);
    put_f32(&mut buffer, snapshot.input.throttle);
    put_f32(&mut buffer, snapshot.input.brake);
    put_f32(&mut buffer, snapshot.input.steer);
    put_optional_f32(&mut buffer, snapshot.vehicle.power_kw);
    put_optional_f32(&mut buffer, snapshot.vehicle.torque_nm);
    put_optional_f32(&mut buffer, snapshot.vehicle.boost);

    if let Some(tires) = &snapshot.tires {
        put_f32(&mut buffer, tires.front_left_temp);
        put_f32(&mut buffer, tires.front_right_temp);
        put_f32(&mut buffer, tires.rear_left_temp);
        put_f32(&mut buffer, tires.rear_right_temp);
    } else {
        put_nan_fields(&mut buffer, 4);
    }

    if let Some(motion) = &snapshot.motion {
        put_optional_f32(&mut buffer, motion.accel_x);
        put_optional_f32(&mut buffer, motion.accel_y);
        put_optional_f32(&mut buffer, motion.accel_z);
    } else {
        put_nan_fields(&mut buffer, 3);
    }

    debug_assert_eq!(buffer.len(), BINARY_TELEMETRY_FRAME_LEN);
    buffer.freeze()
}

fn binary_flags(snapshot: &TelemetrySnapshot) -> u8 {
    let mut flags = 0;
    if snapshot.connected {
        flags |= FLAG_CONNECTED;
    }
    if snapshot.tires.is_some() {
        flags |= FLAG_TIRES;
    }
    if snapshot.motion.is_some() {
        flags |= FLAG_MOTION;
    }
    flags
}

fn clamp_i8(value: i32) -> i8 {
    value.clamp(i8::MIN as i32, i8::MAX as i32) as i8
}

fn put_f32(buffer: &mut BytesMut, value: f64) {
    buffer.put_f32_le(value as f32);
}

fn put_optional_f32(buffer: &mut BytesMut, value: Option<f64>) {
    match value {
        Some(value) => put_f32(buffer, value),
        None => buffer.put_f32_le(f32::NAN),
    }
}

fn put_nan_fields(buffer: &mut BytesMut, count: usize) {
    for _ in 0..count {
        buffer.put_f32_le(f32::NAN);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::telemetry::telemetry_types::{
        InputTelemetry, MotionTelemetry, TelemetrySnapshot, TireTelemetry, VehicleTelemetry,
    };

    const FLOAT_FIELD_COUNT: usize = 16;

    fn read_f32(bytes: &[u8], field_index: usize) -> f32 {
        let offset = 16 + field_index * 4;
        f32::from_le_bytes(bytes[offset..offset + 4].try_into().unwrap())
    }

    #[test]
    fn encodes_binary_frame_v1_layout() {
        let snapshot = TelemetrySnapshot {
            timestamp: 1_725_000_000_123,
            connected: true,
            vehicle: VehicleTelemetry {
                speed_kmh: 123.4,
                rpm: 6789.0,
                max_rpm: Some(8500.0),
                gear: 4,
                power_kw: Some(321.0),
                torque_nm: Some(456.0),
                boost: Some(1.25),
            },
            input: InputTelemetry {
                throttle: 0.75,
                brake: 0.125,
                clutch: Some(0.0),
                steer: -0.5,
                handbrake: Some(0.0),
            },
            tires: Some(TireTelemetry {
                front_left_temp: 37.1,
                front_right_temp: 34.8,
                rear_left_temp: 42.1,
                rear_right_temp: 39.8,
            }),
            motion: Some(MotionTelemetry {
                accel_x: Some(1.0),
                accel_y: Some(2.0),
                accel_z: Some(3.0),
            }),
            race: None,
        };

        let frame = encode_binary_telemetry_frame(&snapshot, 42);
        let bytes = frame.as_ref();

        assert_eq!(bytes.len(), BINARY_TELEMETRY_FRAME_LEN);
        assert_eq!(bytes[0], BINARY_TELEMETRY_VERSION);
        assert_eq!(bytes[1], FLAG_CONNECTED | FLAG_TIRES | FLAG_MOTION);
        assert_eq!(bytes[2] as i8, 4);
        assert_eq!(u32::from_le_bytes(bytes[4..8].try_into().unwrap()), 42);
        assert_eq!(
            u64::from_le_bytes(bytes[8..16].try_into().unwrap()),
            snapshot.timestamp
        );
        assert!((read_f32(bytes, 0) - 123.4).abs() < 0.01);
        assert!((read_f32(bytes, 1) - 6789.0).abs() < 0.01);
        assert!((read_f32(bytes, 5) - -0.5).abs() < 0.01);
        assert!((read_f32(bytes, 15) - 3.0).abs() < 0.01);
    }

    #[test]
    fn encodes_missing_optional_fields_as_nan() {
        let snapshot = TelemetrySnapshot {
            timestamp: 1,
            connected: false,
            vehicle: VehicleTelemetry {
                speed_kmh: 0.0,
                rpm: 0.0,
                max_rpm: None,
                gear: 0,
                power_kw: None,
                torque_nm: None,
                boost: None,
            },
            input: InputTelemetry {
                throttle: 0.0,
                brake: 0.0,
                clutch: None,
                steer: 0.0,
                handbrake: None,
            },
            tires: None,
            motion: None,
            race: None,
        };

        let frame = encode_binary_telemetry_frame(&snapshot, 7);
        let bytes = frame.as_ref();

        assert_eq!(bytes[1], 0);
        assert!(read_f32(bytes, 2).is_nan());
        assert!(read_f32(bytes, 6).is_nan());
        assert!(read_f32(bytes, 9).is_nan());
        assert!(read_f32(bytes, FLOAT_FIELD_COUNT - 1).is_nan());
    }
}
