use std::{collections::BTreeMap, time::{SystemTime, UNIX_EPOCH}};

use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TelemetrySnapshot {
    pub timestamp: u64,
    pub connected: bool,
    pub vehicle: VehicleTelemetry,
    pub input: InputTelemetry,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tires: Option<TireTelemetry>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub motion: Option<MotionTelemetry>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VehicleTelemetry {
    pub speed_kmh: f64,
    pub rpm: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_rpm: Option<f64>,
    pub gear: i32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub power_kw: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub torque_nm: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub boost: Option<f64>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InputTelemetry {
    pub throttle: f64,
    pub brake: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub clutch: Option<f64>,
    pub steer: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub handbrake: Option<f64>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TireTelemetry {
    pub front_left_temp: f64,
    pub front_right_temp: f64,
    pub rear_left_temp: f64,
    pub rear_right_temp: f64,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MotionTelemetry {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub accel_x: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub accel_y: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub accel_z: Option<f64>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TelemetryMessage {
    #[serde(rename = "type")]
    pub message_type: &'static str,
    pub snapshot: TelemetrySnapshot,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TelemetryPacketInfo {
    pub length: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub format: Option<String>,
    pub profile: String,
    pub dash_shift: Option<i32>,
    pub accepted: bool,
    pub errors: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub candidates: Option<Vec<TelemetryPacketCandidate>>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TelemetryPacketCandidate {
    pub profile: String,
    pub dash_shift: i32,
    pub accepted: bool,
    pub score: i32,
    pub errors: Vec<String>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub warnings: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub values: Option<BTreeMap<String, f64>>,
}

pub fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}

