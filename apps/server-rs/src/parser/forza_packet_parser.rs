use std::collections::BTreeMap;

use crate::telemetry::telemetry_types::{
    now_millis, InputTelemetry, MotionTelemetry, RaceTelemetry, TelemetryPacketCandidate,
    TelemetryPacketInfo, TelemetrySnapshot, TireTelemetry, VehicleTelemetry,
};

use super::fh6_offsets::{
    dash_profiles, DashProfile, SLED_ACCEL_X, SLED_ACCEL_Y, SLED_ACCEL_Z, SLED_CURRENT_RPM,
    SLED_ENGINE_MAX_RPM, SLED_VELOCITY_X, SLED_VELOCITY_Y, SLED_VELOCITY_Z,
};

const TIRE_TEMP_FIELD_NAMES: [&str; 4] = [
    "tireTempF[0]",
    "tireTempF[1]",
    "tireTempF[2]",
    "tireTempF[3]",
];

#[derive(Clone)]
pub struct ForzaPacketParser {
    debug_packet: bool,
}

#[derive(Clone)]
struct DashCandidate {
    profile: DashProfile,
    accepted: bool,
    score: i32,
    errors: Vec<String>,
    warnings: Vec<String>,
    values: Option<BTreeMap<String, f64>>,
    snapshot: Option<TelemetrySnapshot>,
}

impl ForzaPacketParser {
    pub fn new(debug_packet: bool) -> Self {
        Self { debug_packet }
    }

    pub fn parse_snapshot(&self, packet: &[u8]) -> Result<TelemetrySnapshot, String> {
        if !self.debug_packet {
            if let Some(profile) = profile_for_packet_length(packet.len()) {
                let mut warnings = Vec::new();
                let (_score, _values, snapshot) =
                    parse_dash_values(packet, profile, &mut warnings, false)?;
                return Ok(snapshot);
            }
        }

        self.parse(packet).map(|(snapshot, _info)| snapshot)
    }

    pub fn parse(&self, packet: &[u8]) -> Result<(TelemetrySnapshot, TelemetryPacketInfo), String> {
        if !self.debug_packet {
            if let Some(profile) = profile_for_packet_length(packet.len()) {
                return parse_fast_dash_profile(packet, profile);
            }
        }

        // The parser is profile-first and offset-based. Changing FH6/FM layouts
        // later should only require editing fh6_offsets.rs or adding a new profile.
        let mut candidates = dash_profiles()
            .into_iter()
            .map(|profile| try_parse_dash_profile(packet, profile, self.debug_packet))
            .collect::<Vec<_>>();

        candidates.sort_by(|left, right| {
            right
                .accepted
                .cmp(&left.accepted)
                .then(right.score.cmp(&left.score))
                .then(left.profile.priority.cmp(&right.profile.priority))
        });

        if let Some(selected) = candidates
            .iter()
            .find(|candidate| candidate.accepted && candidate.snapshot.is_some())
        {
            let snapshot = selected.snapshot.clone().expect("checked above");
            let info = to_packet_info(
                packet,
                selected.profile.name,
                Some(selected.profile.dash_shift),
                true,
                Vec::new(),
                &candidates,
            );

            if self.debug_packet {
                tracing::debug!(
                    packet_len = packet.len(),
                    profile = selected.profile.name,
                    speed_kmh = snapshot.vehicle.speed_kmh,
                    rpm = snapshot.vehicle.rpm,
                    gear = snapshot.vehicle.gear,
                    "parsed Forza telemetry packet"
                );
            }

            return Ok((snapshot, info));
        }

        let fallback = parse_sled_fallback(packet)?;
        let errors = candidates
            .iter()
            .flat_map(|candidate| {
                candidate
                    .errors
                    .iter()
                    .map(|error| format!("{}: {error}", candidate.profile.name))
            })
            .collect::<Vec<_>>();
        let info = to_packet_info(
            packet,
            "forza-sled-fallback",
            None,
            true,
            errors,
            &candidates,
        );

        Ok((fallback, info))
    }
}

fn profile_for_packet_length(packet_len: usize) -> Option<DashProfile> {
    dash_profiles()
        .into_iter()
        .find(|profile| profile.expected_length == Some(packet_len))
}

fn parse_fast_dash_profile(
    packet: &[u8],
    profile: DashProfile,
) -> Result<(TelemetrySnapshot, TelemetryPacketInfo), String> {
    let mut warnings = Vec::new();
    let (_score, _values, snapshot) = parse_dash_values(packet, profile, &mut warnings, false)?;
    let candidates = if warnings.is_empty() {
        None
    } else {
        Some(vec![TelemetryPacketCandidate {
            profile: profile.name.to_string(),
            dash_shift: profile.dash_shift,
            accepted: true,
            score: 0,
            errors: Vec::new(),
            warnings,
            values: None,
        }])
    };
    let info = TelemetryPacketInfo {
        length: packet.len(),
        format: Some(profile.name.to_string()),
        profile: profile.name.to_string(),
        dash_shift: Some(profile.dash_shift),
        accepted: true,
        errors: Vec::new(),
        candidates,
    };

    Ok((snapshot, info))
}

fn try_parse_dash_profile(
    packet: &[u8],
    profile: DashProfile,
    capture_debug_values: bool,
) -> DashCandidate {
    let mut warnings = Vec::new();

    if let Some(expected_length) = profile.expected_length {
        if packet.len() != expected_length {
            return DashCandidate {
                profile,
                accepted: false,
                score: 0,
                errors: vec![format!(
                    "length={} expected {expected_length}",
                    packet.len()
                )],
                warnings,
                values: None,
                snapshot: None,
            };
        }
    }

    if packet.len() < profile.minimum_length {
        return DashCandidate {
            profile,
            accepted: false,
            score: 0,
            errors: vec![format!(
                "length={} shorter than {}",
                packet.len(),
                profile.minimum_length
            )],
            warnings,
            values: None,
            snapshot: None,
        };
    }

    match parse_dash_values(packet, profile, &mut warnings, capture_debug_values) {
        Ok((score, values, snapshot)) => DashCandidate {
            profile,
            accepted: true,
            score,
            errors: Vec::new(),
            warnings,
            values,
            snapshot: Some(snapshot),
        },
        Err(error) => DashCandidate {
            profile,
            accepted: false,
            score: 0,
            errors: vec![error],
            warnings,
            values: None,
            snapshot: None,
        },
    }
}

fn parse_dash_values(
    packet: &[u8],
    profile: DashProfile,
    warnings: &mut Vec<String>,
    capture_debug_values: bool,
) -> Result<(i32, Option<BTreeMap<String, f64>>, TelemetrySnapshot), String> {
    let o = profile.offsets;
    let is_race_on = read_i32(packet, 0)? != 0;
    let engine_max_rpm = read_f32(packet, o.engine_max_rpm)?;
    let current_rpm = read_f32(packet, o.current_rpm)?;
    let speed_kmh = read_f32(packet, o.speed_ms)? * 3.6;
    let power_kw = read_f32(packet, o.power_w)? / 1000.0;
    let torque_nm = read_f32(packet, o.torque_nm)?;
    let boost = read_f32(packet, o.boost)?;
    let fuel = read_f32(packet, o.fuel)?;
    let distance_traveled = read_f32(packet, o.distance_traveled)?;
    let best_lap = read_f32(packet, o.best_lap)?;
    let last_lap = read_f32(packet, o.last_lap)?;
    let current_lap = read_f32(packet, o.current_lap)?;
    let current_race_time = read_f32(packet, o.current_race_time)?;
    let lap_number = read_u16(packet, o.lap_number)?;
    let race_position = read_u8(packet, o.race_position)?;
    let tire_temps_f = [
        read_f32(packet, o.tire_temp_front_left)?,
        read_f32(packet, o.tire_temp_front_right)?,
        read_f32(packet, o.tire_temp_rear_left)?,
        read_f32(packet, o.tire_temp_rear_right)?,
    ];
    let throttle_raw = read_u8(packet, o.throttle)?;
    let brake_raw = read_u8(packet, o.brake)?;
    let clutch_raw = read_u8(packet, o.clutch)?;
    let handbrake_raw = read_u8(packet, o.handbrake)?;
    let gear_raw = read_u8(packet, o.gear)?;
    let steer_raw = read_i8(packet, o.steer)?;

    let values = if capture_debug_values {
        let mut values = BTreeMap::new();
        values.insert("speedKmh".to_string(), speed_kmh);
        values.insert("isRaceOn".to_string(), if is_race_on { 1.0 } else { 0.0 });
        values.insert("engineMaxRpm".to_string(), engine_max_rpm);
        values.insert("currentRpm".to_string(), current_rpm);
        values.insert("powerKw".to_string(), power_kw);
        values.insert("torqueNm".to_string(), torque_nm);
        values.insert("boost".to_string(), boost);
        values.insert("fuel".to_string(), fuel);
        values.insert("distanceTraveledMeters".to_string(), distance_traveled);
        values.insert("bestLapSeconds".to_string(), best_lap);
        values.insert("lastLapSeconds".to_string(), last_lap);
        values.insert("currentLapSeconds".to_string(), current_lap);
        values.insert("currentRaceTimeSeconds".to_string(), current_race_time);
        values.insert("lapNumber".to_string(), f64::from(lap_number));
        values.insert("racePosition".to_string(), f64::from(race_position));
        values.insert("tireTempFrontLeftF".to_string(), tire_temps_f[0]);
        values.insert("tireTempFrontRightF".to_string(), tire_temps_f[1]);
        values.insert("tireTempRearLeftF".to_string(), tire_temps_f[2]);
        values.insert("tireTempRearRightF".to_string(), tire_temps_f[3]);
        values.insert("gearRaw".to_string(), f64::from(gear_raw));
        values.insert("throttleRaw".to_string(), f64::from(throttle_raw));
        values.insert("brakeRaw".to_string(), f64::from(brake_raw));
        values.insert("clutchRaw".to_string(), f64::from(clutch_raw));
        values.insert("steerRaw".to_string(), f64::from(steer_raw));
        Some(values)
    } else {
        None
    };

    let mut score = 0;
    if validate_range(warnings, "engineMaxRpm", engine_max_rpm, 100.0, 25000.0) {
        score += 2;
    }
    if validate_range(warnings, "currentRpm", current_rpm, 0.0, 25000.0) {
        score += 2;
    }
    if engine_max_rpm > 0.0 && current_rpm > engine_max_rpm * 1.5 {
        warnings.push(format!(
            "currentRpm={current_rpm} too high for engineMaxRpm={engine_max_rpm}"
        ));
    } else {
        score += 1;
    }
    if validate_range(warnings, "speedKmh", speed_kmh, -1.0, 650.0) {
        score += 3;
    }
    if validate_range(warnings, "powerKw", power_kw, -2500.0, 5000.0) {
        score += 1;
    }
    if validate_range(warnings, "torqueNm", torque_nm, -2000.0, 5000.0) {
        score += 1;
    }
    if validate_range(warnings, "boost", boost, -30.0, 60.0) {
        score += 2;
    }
    for (name, temp_f) in TIRE_TEMP_FIELD_NAMES.iter().zip(tire_temps_f.iter()) {
        if validate_range(warnings, name, *temp_f, -40.0, 450.0) {
            score += 1;
        }
    }
    if gear_raw <= 10 {
        score += 2;
    } else if gear_raw <= 12 {
        warnings.push(format!(
            "gearRaw={gear_raw} looks like a transient shift value"
        ));
    } else {
        warnings.push(format!("gearRaw={gear_raw} outside 0..10"));
    }

    // FH6's IsRaceOn can be true during normal freeroam driving. Treat the
    // dashboard race panel as active only when race-only context is present.
    let race_active = is_actual_race_session(
        is_race_on,
        best_lap,
        last_lap,
        current_lap,
        current_race_time,
        lap_number,
        race_position,
    );
    let race_timing = normalized_race_telemetry(
        race_active,
        best_lap,
        last_lap,
        current_lap,
        current_race_time,
        lap_number,
        race_position,
        fuel,
        distance_traveled,
    );

    let snapshot = TelemetrySnapshot {
        timestamp: now_millis(),
        connected: true,
        vehicle: VehicleTelemetry {
            speed_kmh: clamp_non_negative(zero_small(finite_or(speed_kmh, 0.0), 0.01)),
            rpm: clamp_non_negative(finite_or(current_rpm, 0.0)),
            max_rpm: Some(clamp_non_negative(finite_or(engine_max_rpm, 0.0))),
            gear: normalize_gear(gear_raw),
            power_kw: Some(clamp_non_negative(finite_or(power_kw, 0.0))),
            torque_nm: Some(clamp_non_negative(finite_or(torque_nm, 0.0))),
            boost: Some(clamp_non_negative(finite_or(boost, 0.0))),
        },
        input: InputTelemetry {
            throttle: byte_to_ratio(throttle_raw),
            brake: byte_to_ratio(brake_raw),
            clutch: Some(byte_to_ratio(clutch_raw)),
            steer: steer_to_ratio(steer_raw),
            handbrake: Some(byte_to_ratio(handbrake_raw)),
        },
        tires: Some(TireTelemetry {
            front_left_temp: finite_or(fahrenheit_to_celsius(tire_temps_f[0]), 0.0),
            front_right_temp: finite_or(fahrenheit_to_celsius(tire_temps_f[1]), 0.0),
            rear_left_temp: finite_or(fahrenheit_to_celsius(tire_temps_f[2]), 0.0),
            rear_right_temp: finite_or(fahrenheit_to_celsius(tire_temps_f[3]), 0.0),
        }),
        motion: Some(MotionTelemetry {
            accel_x: Some(read_f32(packet, o.accel_x)?),
            accel_y: Some(read_f32(packet, o.accel_y)?),
            accel_z: Some(read_f32(packet, o.accel_z)?),
        }),
        race: Some(race_timing),
    };

    Ok((score, values, snapshot))
}

fn parse_sled_fallback(packet: &[u8]) -> Result<TelemetrySnapshot, String> {
    let velocity_x = read_f32(packet, SLED_VELOCITY_X)?;
    let velocity_y = read_f32(packet, SLED_VELOCITY_Y)?;
    let velocity_z = read_f32(packet, SLED_VELOCITY_Z)?;
    let speed_kmh = (velocity_x.powi(2) + velocity_y.powi(2) + velocity_z.powi(2)).sqrt() * 3.6;
    let current_rpm = read_f32(packet, SLED_CURRENT_RPM)?;
    let engine_max_rpm = read_f32(packet, SLED_ENGINE_MAX_RPM)?;

    let mut errors = Vec::new();
    validate_range(&mut errors, "sledSpeedKmh", speed_kmh, 0.0, 650.0);
    validate_range(&mut errors, "sledCurrentRpm", current_rpm, 0.0, 25000.0);
    validate_range(
        &mut errors,
        "sledEngineMaxRpm",
        engine_max_rpm,
        0.0,
        25000.0,
    );

    if !errors.is_empty() {
        return Err(format!(
            "No valid Forza parser profile. {}",
            errors.join("; ")
        ));
    }

    Ok(TelemetrySnapshot {
        timestamp: now_millis(),
        connected: true,
        vehicle: VehicleTelemetry {
            speed_kmh: clamp_non_negative(zero_small(speed_kmh, 0.01)),
            rpm: clamp_non_negative(current_rpm),
            max_rpm: Some(clamp_non_negative(engine_max_rpm)),
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
        motion: Some(MotionTelemetry {
            accel_x: Some(read_f32(packet, SLED_ACCEL_X)?),
            accel_y: Some(read_f32(packet, SLED_ACCEL_Y)?),
            accel_z: Some(read_f32(packet, SLED_ACCEL_Z)?),
        }),
        race: Some(RaceTelemetry {
            active: false,
            best_lap_seconds: None,
            last_lap_seconds: None,
            current_lap_seconds: None,
            current_race_time_seconds: None,
            lap_number: None,
            position: None,
            fuel: None,
            distance_traveled_meters: None,
        }),
    })
}

pub fn create_mock_telemetry_snapshot(now: u64) -> TelemetrySnapshot {
    let seconds = now as f64 / 1000.0;
    let rpm = 2800.0 + (seconds * 2.4).sin() * 1800.0 + (seconds * 0.7).sin() * 600.0;
    let speed = 90.0 + (seconds * 0.9).sin() * 45.0 + (seconds * 0.18).sin().max(0.0) * 70.0;
    let throttle = (0.55 + (seconds * 1.8).sin() * 0.42).clamp(0.0, 1.0);
    let brake = ((seconds * 0.85 + 2.4).sin() * 0.5 - 0.2).clamp(0.0, 1.0);
    let race_active = ((seconds / 8.0).floor() as i64) % 2 == 0;

    TelemetrySnapshot {
        timestamp: now,
        connected: true,
        vehicle: VehicleTelemetry {
            speed_kmh: speed.max(0.0),
            rpm: rpm.max(900.0),
            max_rpm: Some(7500.0),
            gear: ((speed / 45.0).floor() as i32 + 1).clamp(1, 6),
            power_kw: Some(210.0 + throttle * 180.0),
            torque_nm: Some(320.0 + throttle * 220.0),
            boost: Some((throttle * 1.2 - brake * 0.4).max(0.0)),
        },
        input: InputTelemetry {
            throttle,
            brake,
            clutch: Some(0.0),
            steer: (seconds * 1.2).sin() * 0.85,
            handbrake: Some(0.0),
        },
        tires: Some(TireTelemetry {
            front_left_temp: 78.0 + (seconds * 0.8).sin() * 6.0,
            front_right_temp: 80.0 + (seconds * 0.7).cos() * 5.0,
            rear_left_temp: 84.0 + (seconds * 0.95).sin() * 7.0,
            rear_right_temp: 83.0 + (seconds * 0.9).cos() * 7.0,
        }),
        motion: Some(MotionTelemetry {
            accel_x: Some((seconds * 1.2).sin() * 2.5),
            accel_y: Some(throttle * 5.0 - brake * 7.0),
            accel_z: Some(9.8),
        }),
        race: Some(RaceTelemetry {
            active: race_active,
            best_lap_seconds: Some(94.682),
            last_lap_seconds: Some(96.214),
            current_lap_seconds: Some((seconds % 98.0).max(0.0)),
            current_race_time_seconds: Some(seconds),
            lap_number: Some(((seconds / 98.0).floor() as u16).saturating_add(1)),
            position: Some(3),
            fuel: Some((0.72 - seconds * 0.0008).clamp(0.0, 1.0)),
            distance_traveled_meters: Some(seconds * speed / 3.6),
        }),
    }
}

fn to_packet_info(
    packet: &[u8],
    profile: &str,
    dash_shift: Option<i32>,
    accepted: bool,
    errors: Vec<String>,
    candidates: &[DashCandidate],
) -> TelemetryPacketInfo {
    TelemetryPacketInfo {
        length: packet.len(),
        format: Some(profile.to_string()),
        profile: profile.to_string(),
        dash_shift,
        accepted,
        errors,
        candidates: Some(
            candidates
                .iter()
                .map(|candidate| TelemetryPacketCandidate {
                    profile: candidate.profile.name.to_string(),
                    dash_shift: candidate.profile.dash_shift,
                    accepted: candidate.accepted,
                    score: candidate.score,
                    errors: candidate.errors.clone(),
                    warnings: candidate.warnings.clone(),
                    values: candidate.values.clone(),
                })
                .collect(),
        ),
    }
}

fn require_length(packet: &[u8], offset: usize, bytes: usize) -> Result<(), String> {
    if packet.len() < offset + bytes {
        return Err(format!(
            "Packet length {} is too short for offset {offset}",
            packet.len()
        ));
    }
    Ok(())
}

fn read_f32(packet: &[u8], offset: usize) -> Result<f64, String> {
    require_length(packet, offset, 4)?;
    Ok(f32::from_le_bytes([
        packet[offset],
        packet[offset + 1],
        packet[offset + 2],
        packet[offset + 3],
    ]) as f64)
}

fn read_u8(packet: &[u8], offset: usize) -> Result<u8, String> {
    require_length(packet, offset, 1)?;
    Ok(packet[offset])
}

fn read_u16(packet: &[u8], offset: usize) -> Result<u16, String> {
    require_length(packet, offset, 2)?;
    Ok(u16::from_le_bytes([packet[offset], packet[offset + 1]]))
}

fn read_i8(packet: &[u8], offset: usize) -> Result<i8, String> {
    require_length(packet, offset, 1)?;
    Ok(packet[offset] as i8)
}

fn read_i32(packet: &[u8], offset: usize) -> Result<i32, String> {
    require_length(packet, offset, 4)?;
    Ok(i32::from_le_bytes([
        packet[offset],
        packet[offset + 1],
        packet[offset + 2],
        packet[offset + 3],
    ]))
}

fn byte_to_ratio(value: u8) -> f64 {
    (f64::from(value) / 255.0).clamp(0.0, 1.0)
}

fn steer_to_ratio(value: i8) -> f64 {
    (f64::from(value) / 127.0).clamp(-1.0, 1.0)
}

fn clamp_non_negative(value: f64) -> f64 {
    if value.is_finite() {
        value.max(0.0)
    } else {
        0.0
    }
}

fn zero_small(value: f64, epsilon: f64) -> f64 {
    if value.abs() < epsilon {
        0.0
    } else {
        value
    }
}

fn finite_or(value: f64, fallback: f64) -> f64 {
    if value.is_finite() {
        value
    } else {
        fallback
    }
}

fn positive_seconds(value: f64) -> Option<f64> {
    if value.is_finite() && value > 0.0 {
        Some(value)
    } else {
        None
    }
}

fn non_zero_u8(value: u8) -> Option<u8> {
    if value == 0 {
        None
    } else {
        Some(value)
    }
}

fn non_zero_u16(value: u16) -> Option<u16> {
    if value == 0 {
        None
    } else {
        Some(value)
    }
}

fn has_positive_seconds(value: f64) -> bool {
    value.is_finite() && value > 0.0
}

fn is_actual_race_session(
    is_race_on: bool,
    best_lap: f64,
    last_lap: f64,
    current_lap: f64,
    current_race_time: f64,
    lap_number: u16,
    race_position: u8,
) -> bool {
    // FH6 may keep IsRaceOn=true, CurrentRaceTime, fuel, and distance populated
    // while the player is only driving around the world. Only expose the race
    // panel when the packet also contains lap/position context that is typical
    // of an actual event.
    if !is_race_on || lap_number == 0 || race_position == 0 {
        return false;
    }

    let lap_timer_running = has_positive_seconds(current_lap);
    let race_timer_running = has_positive_seconds(current_race_time);
    let completed_lap_context = has_positive_seconds(best_lap) || has_positive_seconds(last_lap);

    (lap_timer_running && race_timer_running) || completed_lap_context
}

fn normalized_race_telemetry(
    active: bool,
    best_lap: f64,
    last_lap: f64,
    current_lap: f64,
    current_race_time: f64,
    lap_number: u16,
    race_position: u8,
    fuel: f64,
    distance_traveled: f64,
) -> RaceTelemetry {
    let fuel = Some(finite_or(fuel, 0.0).clamp(0.0, 1.0));
    let distance_traveled_meters = Some(clamp_non_negative(finite_or(distance_traveled, 0.0)));

    if !active {
        return RaceTelemetry {
            active: false,
            best_lap_seconds: None,
            last_lap_seconds: None,
            current_lap_seconds: None,
            current_race_time_seconds: None,
            lap_number: None,
            position: None,
            fuel,
            distance_traveled_meters,
        };
    }

    RaceTelemetry {
        active: true,
        best_lap_seconds: positive_seconds(best_lap),
        last_lap_seconds: positive_seconds(last_lap),
        current_lap_seconds: positive_seconds(current_lap),
        current_race_time_seconds: positive_seconds(current_race_time),
        lap_number: non_zero_u16(lap_number),
        position: non_zero_u8(race_position),
        fuel,
        distance_traveled_meters,
    }
}

fn fahrenheit_to_celsius(value: f64) -> f64 {
    // FH6 tire telemetry is normalized to Celsius for the dashboard because the
    // in-game tire screen displays Celsius in the current test environment.
    (value - 32.0) * (5.0 / 9.0)
}

fn normalize_gear(raw_gear: u8) -> i32 {
    // FH6 reports reverse as 0 and forward gears as their visible gear number.
    // Raw 1 must remain 1st gear; subtracting one breaks all forward gears.
    match raw_gear {
        0 => -1,
        1..=10 => i32::from(raw_gear),
        // During a shift FH6 can briefly emit non-display values such as 11.
        // Keep that distinct so the store/UI can avoid rendering "11th gear".
        _ => -2,
    }
}

fn validate_range(warnings: &mut Vec<String>, name: &str, value: f64, min: f64, max: f64) -> bool {
    if value.is_finite() && value >= min && value <= max {
        true
    } else {
        warnings.push(format!("{name}={value} outside {min}..{max}"));
        false
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write_f32(packet: &mut [u8], offset: usize, value: f32) {
        packet[offset..offset + 4].copy_from_slice(&value.to_le_bytes());
    }

    #[test]
    fn parses_fh6_dash_shift_and_forward_gear_without_subtracting() {
        let mut packet = vec![0_u8; 324];
        write_f32(&mut packet, 8, 8500.0);
        write_f32(&mut packet, 16, 1800.0);
        write_f32(&mut packet, 256, 10.0);
        write_f32(&mut packet, 260, 500000.0);
        write_f32(&mut packet, 264, 650.0);
        write_f32(&mut packet, 268, 104.0);
        write_f32(&mut packet, 272, 105.0);
        write_f32(&mut packet, 276, 106.0);
        write_f32(&mut packet, 280, 107.0);
        write_f32(&mut packet, 284, 1.2);
        packet[315] = 128;
        packet[316] = 0;
        packet[317] = 0;
        packet[318] = 0;
        packet[319] = 2;
        packet[320] = 0;

        let parser = ForzaPacketParser::new(false);
        let (snapshot, info) = parser.parse(&packet).expect("packet should parse");

        assert_eq!(info.profile, "forza-horizon-6-data-out");
        assert!(info.candidates.is_none());
        assert_eq!(snapshot.vehicle.gear, 2);
        assert_eq!(snapshot.vehicle.speed_kmh.round(), 36.0);
    }

    #[test]
    fn accepts_fh6_packet_even_when_dynamic_values_are_suspicious() {
        let mut packet = vec![0_u8; 324];
        write_f32(&mut packet, 8, 8500.0);
        write_f32(&mut packet, 16, 900.0);
        write_f32(&mut packet, 256, 0.0);
        write_f32(&mut packet, 260, -3_500_000.0);
        write_f32(&mut packet, 264, -6200.0);
        write_f32(&mut packet, 268, 98.6);
        write_f32(&mut packet, 272, 98.6);
        write_f32(&mut packet, 276, 98.6);
        write_f32(&mut packet, 280, 98.6);
        write_f32(&mut packet, 284, 143.0);
        packet[319] = 1;

        let parser = ForzaPacketParser::new(true);
        let (snapshot, info) = parser.parse(&packet).expect("packet should parse");

        assert!(info.accepted);
        assert_eq!(snapshot.vehicle.gear, 1);
        assert_eq!(snapshot.vehicle.torque_nm, Some(0.0));
        assert!(info
            .candidates
            .unwrap()
            .iter()
            .any(|candidate| !candidate.warnings.is_empty()));
    }

    #[test]
    fn debug_parser_keeps_raw_candidate_values() {
        let mut packet = vec![0_u8; 324];
        write_f32(&mut packet, 8, 8500.0);
        write_f32(&mut packet, 16, 1800.0);
        write_f32(&mut packet, 256, 10.0);
        write_f32(&mut packet, 268, 104.0);
        write_f32(&mut packet, 272, 105.0);
        write_f32(&mut packet, 276, 106.0);
        write_f32(&mut packet, 280, 107.0);
        packet[319] = 2;

        let parser = ForzaPacketParser::new(true);
        let (_snapshot, info) = parser.parse(&packet).expect("packet should parse");

        assert!(info
            .candidates
            .unwrap()
            .iter()
            .any(|candidate| candidate.values.is_some()));
    }

    #[test]
    fn does_not_mark_freeroam_is_race_on_as_race_session() {
        let mut packet = vec![0_u8; 324];
        packet[0..4].copy_from_slice(&1_i32.to_le_bytes());
        write_f32(&mut packet, 8, 8500.0);
        write_f32(&mut packet, 16, 900.0);
        write_f32(&mut packet, 256, 0.0);
        write_f32(&mut packet, 268, 98.6);
        write_f32(&mut packet, 272, 98.6);
        write_f32(&mut packet, 276, 98.6);
        write_f32(&mut packet, 280, 98.6);
        packet[319] = 1;

        let parser = ForzaPacketParser::new(false);
        let (snapshot, _info) = parser.parse(&packet).expect("packet should parse");

        let race = snapshot.race.unwrap();
        assert!(!race.active);
        assert_eq!(race.current_race_time_seconds, None);
        assert_eq!(race.lap_number, None);
        assert_eq!(race.position, None);
    }

    #[test]
    fn ignores_freeroam_race_time_without_lap_and_position_context() {
        let mut packet = vec![0_u8; 324];
        packet[0..4].copy_from_slice(&1_i32.to_le_bytes());
        write_f32(&mut packet, 8, 8500.0);
        write_f32(&mut packet, 16, 900.0);
        write_f32(&mut packet, 256, 8.0);
        write_f32(&mut packet, 268, 98.6);
        write_f32(&mut packet, 272, 98.6);
        write_f32(&mut packet, 276, 98.6);
        write_f32(&mut packet, 280, 98.6);
        write_f32(&mut packet, 308, 72.0);
        packet[319] = 2;

        let parser = ForzaPacketParser::new(false);
        let (snapshot, _info) = parser.parse(&packet).expect("packet should parse");

        let race = snapshot.race.unwrap();
        assert!(!race.active);
        assert_eq!(race.current_lap_seconds, None);
        assert_eq!(race.current_race_time_seconds, None);
        assert_eq!(race.position, None);
    }

    #[test]
    fn marks_race_session_when_position_and_lap_context_exist() {
        let mut packet = vec![0_u8; 324];
        packet[0..4].copy_from_slice(&1_i32.to_le_bytes());
        write_f32(&mut packet, 8, 8500.0);
        write_f32(&mut packet, 16, 1200.0);
        write_f32(&mut packet, 256, 12.0);
        write_f32(&mut packet, 268, 98.6);
        write_f32(&mut packet, 272, 98.6);
        write_f32(&mut packet, 276, 98.6);
        write_f32(&mut packet, 280, 98.6);
        write_f32(&mut packet, 304, 42.5);
        write_f32(&mut packet, 308, 43.0);
        packet[312..314].copy_from_slice(&1_u16.to_le_bytes());
        packet[319] = 3;
        packet[314] = 4;

        let parser = ForzaPacketParser::new(false);
        let (snapshot, _info) = parser.parse(&packet).expect("packet should parse");

        let race = snapshot.race.unwrap();
        assert!(race.active);
        assert_eq!(race.position, Some(4));
    }

    #[test]
    fn treats_transient_shift_gear_as_unknown() {
        assert_eq!(normalize_gear(11), -2);
        assert_eq!(normalize_gear(12), -2);
    }
}
