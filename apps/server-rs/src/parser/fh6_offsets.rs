#[derive(Clone, Copy)]
pub struct PacketOffsets {
    pub engine_max_rpm: usize,
    pub current_rpm: usize,
    pub accel_x: usize,
    pub accel_y: usize,
    pub accel_z: usize,
    pub speed_ms: usize,
    pub power_w: usize,
    pub torque_nm: usize,
    pub tire_temp_front_left: usize,
    pub tire_temp_front_right: usize,
    pub tire_temp_rear_left: usize,
    pub tire_temp_rear_right: usize,
    pub boost: usize,
    pub fuel: usize,
    pub distance_traveled: usize,
    pub best_lap: usize,
    pub last_lap: usize,
    pub current_lap: usize,
    pub current_race_time: usize,
    pub lap_number: usize,
    pub race_position: usize,
    pub throttle: usize,
    pub brake: usize,
    pub clutch: usize,
    pub handbrake: usize,
    pub gear: usize,
    pub steer: usize,
}

#[derive(Clone, Copy)]
pub struct DashProfile {
    pub name: &'static str,
    pub dash_shift: i32,
    pub minimum_length: usize,
    pub expected_length: Option<usize>,
    pub priority: i32,
    pub offsets: PacketOffsets,
}

pub const SLED_ENGINE_MAX_RPM: usize = 8;
pub const SLED_CURRENT_RPM: usize = 16;
pub const SLED_ACCEL_X: usize = 20;
pub const SLED_ACCEL_Y: usize = 24;
pub const SLED_ACCEL_Z: usize = 28;
pub const SLED_VELOCITY_X: usize = 32;
pub const SLED_VELOCITY_Y: usize = 36;
pub const SLED_VELOCITY_Z: usize = 40;

pub fn dash_profiles() -> [DashProfile; 2] {
    [
        DashProfile {
            // FH6 inserts CarGroup, SmashableVelDiff, and SmashableMass after
            // NumCylinders, shifting Motorsport Dash-like fields by 12 bytes.
            name: "forza-horizon-6-data-out",
            dash_shift: 12,
            minimum_length: 324,
            expected_length: Some(324),
            priority: 0,
            offsets: create_dash_offsets(12),
        },
        DashProfile {
            name: "forza-motorsport-dash",
            dash_shift: 0,
            minimum_length: 311,
            expected_length: Some(311),
            priority: 1,
            offsets: create_dash_offsets(0),
        },
    ]
}

const fn create_dash_offsets(dash_shift: usize) -> PacketOffsets {
    PacketOffsets {
        engine_max_rpm: 8,
        current_rpm: 16,
        accel_x: 20,
        accel_y: 24,
        accel_z: 28,
        speed_ms: 244 + dash_shift,
        power_w: 248 + dash_shift,
        torque_nm: 252 + dash_shift,
        tire_temp_front_left: 256 + dash_shift,
        tire_temp_front_right: 260 + dash_shift,
        tire_temp_rear_left: 264 + dash_shift,
        tire_temp_rear_right: 268 + dash_shift,
        boost: 272 + dash_shift,
        fuel: 276 + dash_shift,
        distance_traveled: 280 + dash_shift,
        best_lap: 284 + dash_shift,
        last_lap: 288 + dash_shift,
        current_lap: 292 + dash_shift,
        current_race_time: 296 + dash_shift,
        lap_number: 300 + dash_shift,
        race_position: 302 + dash_shift,
        throttle: 303 + dash_shift,
        brake: 304 + dash_shift,
        clutch: 305 + dash_shift,
        handbrake: 306 + dash_shift,
        gear: 307 + dash_shift,
        steer: 308 + dash_shift,
    }
}
