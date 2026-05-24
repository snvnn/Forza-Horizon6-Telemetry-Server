use std::{
    env,
    fs,
    net::{IpAddr, Ipv4Addr},
    path::PathBuf,
};

#[derive(Clone, Debug)]
pub struct AppConfig {
    pub udp_port: u16,
    pub http_port: u16,
    pub host: IpAddr,
    pub broadcast_hz: f64,
    pub broadcast_interval_ms: f64,
    pub mock_telemetry: bool,
    pub debug_packet: bool,
    pub connection_timeout_ms: u64,
    pub heartbeat_ms: u64,
    pub dashboard_dist_dir: PathBuf,
}

pub fn load_config() -> AppConfig {
    load_env_files();

    let broadcast_hz = parse_hz(env::var("TELEMETRY_BROADCAST_HZ").ok().as_deref(), 60.0);
    let host = env::var("HOST")
        .ok()
        .and_then(|value| value.parse::<IpAddr>().ok())
        .unwrap_or(IpAddr::V4(Ipv4Addr::UNSPECIFIED));

    AppConfig {
        udp_port: parse_port(env::var("UDP_PORT").ok().as_deref(), 5400),
        http_port: parse_port(env::var("HTTP_PORT").ok().as_deref(), 3000),
        // 0.0.0.0 binding is intentional: tablets and phones on the same LAN
        // can connect to http://PC_LOCAL_IP:PORT when Windows Firewall allows it.
        host,
        broadcast_hz,
        broadcast_interval_ms: 1000.0 / broadcast_hz,
        mock_telemetry: parse_bool(env::var("MOCK_TELEMETRY").ok().as_deref(), false),
        debug_packet: parse_bool(env::var("DEBUG_PACKET").ok().as_deref(), false),
        connection_timeout_ms: parse_positive_u64(
            env::var("CONNECTION_TIMEOUT_MS").ok().as_deref(),
            2000,
        ),
        heartbeat_ms: parse_positive_u64(env::var("HEARTBEAT_MS").ok().as_deref(), 250),
        dashboard_dist_dir: dashboard_dist_dir(),
    }
}

fn load_env_files() {
    let mut candidates = Vec::new();

    if let Ok(current_dir) = env::current_dir() {
        candidates.push(current_dir.join(".env"));
        candidates.push(current_dir.join("../../.env"));
    }

    candidates.push(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../.env"));

    for path in candidates {
        let Ok(content) = fs::read_to_string(path) else {
            continue;
        };

        for line in content.lines() {
            let trimmed = line.trim();
            if trimmed.is_empty() || trimmed.starts_with('#') {
                continue;
            }

            let Some((key, value)) = trimmed.split_once('=') else {
                continue;
            };

            let key = key.trim();
            let value = value.trim().trim_matches(['"', '\'']);
            if !key.is_empty() && env::var_os(key).is_none() {
                env::set_var(key, value);
            }
        }
    }
}

fn dashboard_dist_dir() -> PathBuf {
    if let Ok(value) = env::var("DASHBOARD_DIST_DIR") {
        return PathBuf::from(value);
    }

    if let Ok(current_dir) = env::current_dir() {
        let candidate = current_dir.join("apps/dashboard/dist");
        if candidate.exists() {
            return candidate;
        }
    }

    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../dashboard/dist")
}

fn parse_port(value: Option<&str>, fallback: u16) -> u16 {
    value
        .and_then(|raw| raw.trim().parse::<u16>().ok())
        .filter(|port| *port > 0)
        .unwrap_or(fallback)
}

fn parse_bool(value: Option<&str>, fallback: bool) -> bool {
    value
        .map(|raw| matches!(raw.trim().to_ascii_lowercase().as_str(), "1" | "true" | "yes" | "on"))
        .unwrap_or(fallback)
}

fn parse_hz(value: Option<&str>, fallback: f64) -> f64 {
    value
        .and_then(|raw| raw.trim().parse::<f64>().ok())
        .filter(|hz| hz.is_finite() && *hz >= 1.0 && *hz <= 120.0)
        .unwrap_or(fallback)
}

fn parse_positive_u64(value: Option<&str>, fallback: u64) -> u64 {
    value
        .and_then(|raw| raw.trim().parse::<u64>().ok())
        .filter(|value| *value > 0)
        .unwrap_or(fallback)
}

