use std::{
    env, fs,
    net::{IpAddr, Ipv4Addr, SocketAddr},
    path::{Path, PathBuf},
};

use serde::{Deserialize, Serialize};

pub const SUPPORTED_GAME_ADAPTERS: &[&str] = &["forza-horizon-6"];
pub const DEFAULT_BROADCAST_HZ: f64 = 60.0;
pub const MAX_BROADCAST_HZ: f64 = 240.0;
pub const DEFAULT_DASHBOARD_RENDER_HZ: u16 = 60;
pub const MAX_DASHBOARD_RENDER_HZ: u16 = 240;
pub const DEFAULT_WEBSOCKET_SEND_TIMEOUT_MS: u64 = 50;
pub const MIN_WEBSOCKET_SEND_TIMEOUT_MS: u64 = 10;
pub const MAX_WEBSOCKET_SEND_TIMEOUT_MS: u64 = 1000;
pub const TRANSPORT_JSON: &str = "json";
pub const TRANSPORT_BINARY: &str = "binary";

#[derive(Clone, Debug)]
pub struct AppConfig {
    pub game_adapter: String,
    pub http_host: String,
    pub http_port: u16,
    pub udp_host: String,
    pub udp_port: u16,
    pub udp_receive_buffer_bytes: usize,
    pub broadcast_hz: f64,
    pub broadcast_interval_ms: f64,
    pub transport_mode: String,
    pub dashboard_render_hz: u16,
    pub websocket_send_timeout_ms: u64,
    pub connection_timeout_ms: u64,
    pub mock_telemetry: bool,
    pub debug_packet: bool,
    pub heartbeat_ms: u64,
    pub config_path: PathBuf,
    pub dashboard_dist_dir: PathBuf,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PublicConfig {
    pub game_adapter: String,
    pub http_host: String,
    pub http_port: u16,
    pub udp_host: String,
    pub udp_port: u16,
    pub udp_receive_buffer_bytes: usize,
    pub broadcast_hz: f64,
    pub transport_mode: String,
    pub dashboard_render_hz: u16,
    pub websocket_send_timeout_ms: u64,
    pub connection_timeout_ms: u64,
    pub mock_telemetry: bool,
    pub debug_packet: bool,
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PartialConfig {
    game_adapter: Option<String>,
    http_host: Option<String>,
    http_port: Option<u16>,
    udp_host: Option<String>,
    udp_port: Option<u16>,
    udp_receive_buffer_bytes: Option<usize>,
    broadcast_hz: Option<f64>,
    transport_mode: Option<String>,
    dashboard_render_hz: Option<u16>,
    websocket_send_timeout_ms: Option<u64>,
    connection_timeout_ms: Option<u64>,
    mock_telemetry: Option<bool>,
    debug_packet: Option<bool>,
}

impl AppConfig {
    pub fn from_public(
        public: PublicConfig,
        heartbeat_ms: u64,
        config_path: PathBuf,
        dashboard_dist_dir: PathBuf,
    ) -> Self {
        let broadcast_interval_ms = if public.broadcast_hz == 0.0 {
            0.0
        } else {
            1000.0 / public.broadcast_hz
        };

        Self {
            broadcast_interval_ms,
            game_adapter: public.game_adapter,
            http_host: public.http_host,
            http_port: public.http_port,
            udp_host: public.udp_host,
            udp_port: public.udp_port,
            udp_receive_buffer_bytes: public.udp_receive_buffer_bytes,
            broadcast_hz: public.broadcast_hz,
            transport_mode: public.transport_mode,
            dashboard_render_hz: public.dashboard_render_hz,
            websocket_send_timeout_ms: public.websocket_send_timeout_ms,
            connection_timeout_ms: public.connection_timeout_ms,
            mock_telemetry: public.mock_telemetry,
            debug_packet: public.debug_packet,
            heartbeat_ms,
            config_path,
            dashboard_dist_dir,
        }
    }

    pub fn to_public(&self) -> PublicConfig {
        PublicConfig {
            game_adapter: self.game_adapter.clone(),
            http_host: self.http_host.clone(),
            http_port: self.http_port,
            udp_host: self.udp_host.clone(),
            udp_port: self.udp_port,
            udp_receive_buffer_bytes: self.udp_receive_buffer_bytes,
            broadcast_hz: self.broadcast_hz,
            transport_mode: self.transport_mode.clone(),
            dashboard_render_hz: self.dashboard_render_hz,
            websocket_send_timeout_ms: self.websocket_send_timeout_ms,
            connection_timeout_ms: self.connection_timeout_ms,
            mock_telemetry: self.mock_telemetry,
            debug_packet: self.debug_packet,
        }
    }

    pub fn http_socket_addr(&self) -> Result<SocketAddr, String> {
        parse_ip_addr(&self.http_host)
            .map(|host| SocketAddr::new(host, self.http_port))
            .map_err(|error| format!("Invalid HTTP host '{}': {error}", self.http_host))
    }

    pub fn udp_socket_addr(&self) -> Result<SocketAddr, String> {
        parse_ip_addr(&self.udp_host)
            .map(|host| SocketAddr::new(host, self.udp_port))
            .map_err(|error| format!("Invalid UDP host '{}': {error}", self.udp_host))
    }
}

pub fn load_config() -> AppConfig {
    load_env_files();

    let config_path = config_file_path();
    let dashboard_dist_dir = dashboard_dist_dir();
    let heartbeat_ms = parse_positive_u64(env::var("HEARTBEAT_MS").ok().as_deref(), 250);
    let mut public = default_public_config();
    apply_env_config(&mut public);

    if let Ok(config_file) = fs::read_to_string(&config_path) {
        match serde_json::from_str::<PartialConfig>(&config_file) {
            Ok(partial) => apply_partial_config(&mut public, partial),
            Err(error) => eprintln!(
                "[config] Failed to parse {}: {error}. Falling back to env/defaults.",
                config_path.display()
            ),
        }
    }

    if let Err(errors) = validate_public_config(&public) {
        eprintln!(
            "[config] Invalid {}: {}. Falling back to env/defaults.",
            config_path.display(),
            errors.join("; ")
        );
        public = default_public_config();
        apply_env_config(&mut public);
    }

    AppConfig::from_public(public, heartbeat_ms, config_path, dashboard_dist_dir)
}

pub fn save_public_config(config: &PublicConfig, path: &Path) -> Result<(), String> {
    validate_public_config(config).map_err(|errors| errors.join("; "))?;

    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| format!("Failed to create config directory: {error}"))?;
    }

    let content = serde_json::to_string_pretty(config)
        .map_err(|error| format!("Failed to serialize config: {error}"))?;
    fs::write(path, format!("{content}\n"))
        .map_err(|error| format!("Failed to write {}: {error}", path.display()))
}

pub fn validate_public_config(config: &PublicConfig) -> Result<(), Vec<String>> {
    let mut errors = Vec::new();

    if !SUPPORTED_GAME_ADAPTERS
        .iter()
        .any(|adapter| *adapter == config.game_adapter)
    {
        errors.push(format!("Unsupported gameAdapter '{}'", config.game_adapter));
    }

    if config.http_port == 0 {
        errors.push("httpPort must be between 1 and 65535".to_string());
    }

    if config.udp_port == 0 {
        errors.push("udpPort must be between 1 and 65535".to_string());
    }

    if !(8 * 1024..=64 * 1024 * 1024).contains(&config.udp_receive_buffer_bytes) {
        errors.push("udpReceiveBufferBytes must be between 8192 and 67108864".to_string());
    }

    if config.http_port == config.udp_port {
        errors.push("HTTP port and UDP port must be different".to_string());
    }

    if !is_valid_broadcast_hz(config.broadcast_hz) {
        errors.push("broadcastHz must be 0 for uncapped or between 1 and 240".to_string());
    }

    if !is_valid_transport_mode(&config.transport_mode) {
        errors.push("transportMode must be 'json' or 'binary'".to_string());
    }

    if config.dashboard_render_hz == 0 || config.dashboard_render_hz > MAX_DASHBOARD_RENDER_HZ {
        errors.push("dashboardRenderHz must be between 1 and 240".to_string());
    }

    if !(MIN_WEBSOCKET_SEND_TIMEOUT_MS..=MAX_WEBSOCKET_SEND_TIMEOUT_MS)
        .contains(&config.websocket_send_timeout_ms)
    {
        errors.push("websocketSendTimeoutMs must be between 10 and 1000".to_string());
    }

    if config.connection_timeout_ms < 500 {
        errors.push("connectionTimeoutMs must be at least 500".to_string());
    }

    if parse_ip_addr(&config.http_host).is_err() {
        errors.push(format!(
            "httpHost '{}' is not a valid IP address",
            config.http_host
        ));
    }

    if parse_ip_addr(&config.udp_host).is_err() {
        errors.push(format!(
            "udpHost '{}' is not a valid IP address",
            config.udp_host
        ));
    }

    if errors.is_empty() {
        Ok(())
    } else {
        Err(errors)
    }
}

pub fn local_dashboard_url(config: &AppConfig) -> String {
    format!("http://localhost:{}/dashboard", config.http_port)
}

pub fn local_settings_url(config: &AppConfig) -> String {
    format!("http://localhost:{}/settings", config.http_port)
}

pub fn network_dashboard_url(config: &AppConfig) -> Option<String> {
    detect_private_ipv4().map(|ip| format!("http://{ip}:{}/dashboard", config.http_port))
}

fn default_public_config() -> PublicConfig {
    PublicConfig {
        game_adapter: "forza-horizon-6".to_string(),
        http_host: "0.0.0.0".to_string(),
        http_port: 3000,
        udp_host: "0.0.0.0".to_string(),
        udp_port: 5400,
        udp_receive_buffer_bytes: 1_048_576,
        broadcast_hz: DEFAULT_BROADCAST_HZ,
        transport_mode: TRANSPORT_JSON.to_string(),
        dashboard_render_hz: DEFAULT_DASHBOARD_RENDER_HZ,
        websocket_send_timeout_ms: DEFAULT_WEBSOCKET_SEND_TIMEOUT_MS,
        connection_timeout_ms: 2000,
        mock_telemetry: false,
        debug_packet: false,
    }
}

fn apply_env_config(config: &mut PublicConfig) {
    let host = env::var("HOST").ok();

    if let Some(value) = env::var("GAME_ADAPTER")
        .ok()
        .filter(|value| !value.trim().is_empty())
    {
        config.game_adapter = value;
    }
    if let Some(value) = env::var("HTTP_HOST").ok().or_else(|| host.clone()) {
        config.http_host = value;
    }
    if let Some(value) = env::var("UDP_HOST").ok().or(host) {
        config.udp_host = value;
    }
    if let Some(value) = parse_port(env::var("HTTP_PORT").ok().as_deref()) {
        config.http_port = value;
    }
    if let Some(value) = parse_port(env::var("UDP_PORT").ok().as_deref()) {
        config.udp_port = value;
    }
    if let Some(value) = parse_usize(env::var("UDP_RECEIVE_BUFFER_BYTES").ok().as_deref()) {
        config.udp_receive_buffer_bytes = value;
    }
    if let Some(value) = parse_hz(env::var("TELEMETRY_BROADCAST_HZ").ok().as_deref()) {
        config.broadcast_hz = value;
    }
    if let Some(value) = parse_transport_mode(
        env::var("TRANSPORT_MODE")
            .ok()
            .or_else(|| env::var("TELEMETRY_TRANSPORT_MODE").ok())
            .as_deref(),
    ) {
        config.transport_mode = value;
    }
    if let Some(value) = parse_render_hz(
        env::var("DASHBOARD_RENDER_HZ")
            .ok()
            .or_else(|| env::var("VITE_RENDER_HZ").ok())
            .as_deref(),
    ) {
        config.dashboard_render_hz = value;
    }
    if let Some(value) =
        parse_websocket_send_timeout_ms(env::var("WEBSOCKET_SEND_TIMEOUT_MS").ok().as_deref())
    {
        config.websocket_send_timeout_ms = value;
    }
    if let Some(value) =
        parse_optional_positive_u64(env::var("CONNECTION_TIMEOUT_MS").ok().as_deref())
    {
        config.connection_timeout_ms = value;
    }
    if let Some(value) = parse_bool(env::var("MOCK_TELEMETRY").ok().as_deref()) {
        config.mock_telemetry = value;
    }
    if let Some(value) = parse_bool(env::var("DEBUG_PACKET").ok().as_deref()) {
        config.debug_packet = value;
    }
}

fn apply_partial_config(config: &mut PublicConfig, partial: PartialConfig) {
    if let Some(value) = partial.game_adapter {
        config.game_adapter = value;
    }
    if let Some(value) = partial.http_host {
        config.http_host = value;
    }
    if let Some(value) = partial.http_port {
        config.http_port = value;
    }
    if let Some(value) = partial.udp_host {
        config.udp_host = value;
    }
    if let Some(value) = partial.udp_port {
        config.udp_port = value;
    }
    if let Some(value) = partial.udp_receive_buffer_bytes {
        config.udp_receive_buffer_bytes = value;
    }
    if let Some(value) = partial.broadcast_hz {
        config.broadcast_hz = value;
    }
    if let Some(value) = partial.transport_mode {
        config.transport_mode = value;
    }
    if let Some(value) = partial.dashboard_render_hz {
        config.dashboard_render_hz = value;
    }
    if let Some(value) = partial.websocket_send_timeout_ms {
        config.websocket_send_timeout_ms = value;
    }
    if let Some(value) = partial.connection_timeout_ms {
        config.connection_timeout_ms = value;
    }
    if let Some(value) = partial.mock_telemetry {
        config.mock_telemetry = value;
    }
    if let Some(value) = partial.debug_packet {
        config.debug_packet = value;
    }
}

fn load_env_files() {
    let mut candidates = Vec::new();

    if let Ok(current_dir) = env::current_dir() {
        candidates.push(current_dir.join(".env"));
        candidates.push(current_dir.join("../../.env"));
    }

    if let Ok(exe_path) = env::current_exe() {
        if let Some(exe_dir) = exe_path.parent() {
            candidates.push(exe_dir.join(".env"));
        }
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

fn config_file_path() -> PathBuf {
    if let Ok(value) = env::var("SIM_TELEMETRY_CONFIG") {
        return PathBuf::from(value);
    }

    let mut candidates = Vec::new();
    if let Ok(current_dir) = env::current_dir() {
        candidates.push(current_dir.join("config.json"));
    }
    if let Ok(exe_path) = env::current_exe() {
        if let Some(exe_dir) = exe_path.parent() {
            candidates.push(exe_dir.join("config.json"));
        }
    }

    for candidate in &candidates {
        if candidate.exists() {
            return candidate.clone();
        }
    }

    candidates
        .get(1)
        .cloned()
        .or_else(|| candidates.first().cloned())
        .unwrap_or_else(|| PathBuf::from("config.json"))
}

fn dashboard_dist_dir() -> PathBuf {
    if let Ok(value) = env::var("DASHBOARD_DIST_DIR") {
        return PathBuf::from(value);
    }

    let mut candidates = Vec::new();

    if let Ok(exe_path) = env::current_exe() {
        if let Some(exe_dir) = exe_path.parent() {
            candidates.push(exe_dir.join("static"));
            candidates.push(exe_dir.join("dashboard/dist"));
            candidates.push(exe_dir.join("dist"));
        }
    }

    if let Ok(current_dir) = env::current_dir() {
        candidates.push(current_dir.join("static"));
        candidates.push(current_dir.join("dashboard/dist"));
        candidates.push(current_dir.join("apps/dashboard/dist"));
    }

    candidates.push(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../dashboard/dist"));

    for candidate in candidates {
        if candidate.exists() {
            return candidate;
        }
    }

    PathBuf::from("static")
}

fn parse_ip_addr(value: &str) -> Result<IpAddr, std::net::AddrParseError> {
    value.parse::<IpAddr>()
}

fn parse_port(value: Option<&str>) -> Option<u16> {
    value
        .and_then(|raw| raw.trim().parse::<u16>().ok())
        .filter(|port| *port > 0)
}

fn parse_bool(value: Option<&str>) -> Option<bool> {
    value.map(|raw| {
        matches!(
            raw.trim().to_ascii_lowercase().as_str(),
            "1" | "true" | "yes" | "on"
        )
    })
}

fn parse_hz(value: Option<&str>) -> Option<f64> {
    value
        .and_then(|raw| raw.trim().parse::<f64>().ok())
        .filter(|hz| is_valid_broadcast_hz(*hz))
}

fn is_valid_broadcast_hz(hz: f64) -> bool {
    hz.is_finite() && (hz == 0.0 || (hz >= 1.0 && hz <= MAX_BROADCAST_HZ))
}

fn parse_transport_mode(value: Option<&str>) -> Option<String> {
    value
        .map(|raw| raw.trim().to_ascii_lowercase())
        .filter(|mode| is_valid_transport_mode(mode))
}

fn is_valid_transport_mode(mode: &str) -> bool {
    matches!(mode, TRANSPORT_JSON | TRANSPORT_BINARY)
}

fn parse_render_hz(value: Option<&str>) -> Option<u16> {
    value
        .and_then(|raw| raw.trim().parse::<u16>().ok())
        .filter(|hz| *hz >= 1 && *hz <= MAX_DASHBOARD_RENDER_HZ)
}

fn parse_websocket_send_timeout_ms(value: Option<&str>) -> Option<u64> {
    value
        .and_then(|raw| raw.trim().parse::<u64>().ok())
        .filter(|timeout| {
            (MIN_WEBSOCKET_SEND_TIMEOUT_MS..=MAX_WEBSOCKET_SEND_TIMEOUT_MS).contains(timeout)
        })
}

fn parse_usize(value: Option<&str>) -> Option<usize> {
    value.and_then(|raw| raw.trim().parse::<usize>().ok())
}

fn parse_positive_u64(value: Option<&str>, fallback: u64) -> u64 {
    value
        .and_then(|raw| raw.trim().parse::<u64>().ok())
        .filter(|value| *value > 0)
        .unwrap_or(fallback)
}

fn parse_optional_positive_u64(value: Option<&str>) -> Option<u64> {
    value
        .and_then(|raw| raw.trim().parse::<u64>().ok())
        .filter(|value| *value > 0)
}

fn detect_private_ipv4() -> Option<Ipv4Addr> {
    let socket = std::net::UdpSocket::bind((Ipv4Addr::UNSPECIFIED, 0)).ok()?;
    socket.connect((Ipv4Addr::new(8, 8, 8, 8), 80)).ok()?;
    match socket.local_addr().ok()?.ip() {
        IpAddr::V4(ip) if is_private_ipv4(ip) => Some(ip),
        _ => None,
    }
}

fn is_private_ipv4(ip: Ipv4Addr) -> bool {
    let octets = ip.octets();
    octets[0] == 10
        || (octets[0] == 172 && (16..=31).contains(&octets[1]))
        || (octets[0] == 192 && octets[1] == 168)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_uncapped_and_high_broadcast_hz() {
        let mut config = default_public_config();
        config.broadcast_hz = 0.0;
        assert!(validate_public_config(&config).is_ok());

        config.broadcast_hz = MAX_BROADCAST_HZ;
        assert!(validate_public_config(&config).is_ok());

        let app_config = AppConfig::from_public(
            config,
            250,
            PathBuf::from("config.json"),
            PathBuf::from("static"),
        );
        assert!((app_config.broadcast_interval_ms - (1000.0 / MAX_BROADCAST_HZ)).abs() < 0.001);
    }

    #[test]
    fn rejects_invalid_broadcast_hz_values() {
        let mut config = default_public_config();
        config.broadcast_hz = 0.5;
        assert!(validate_public_config(&config).is_err());

        config.broadcast_hz = MAX_BROADCAST_HZ + 1.0;
        assert!(validate_public_config(&config).is_err());
    }

    #[test]
    fn validates_low_latency_config_ranges() {
        let mut config = default_public_config();
        config.transport_mode = TRANSPORT_BINARY.to_string();
        config.dashboard_render_hz = MAX_DASHBOARD_RENDER_HZ;
        config.websocket_send_timeout_ms = MAX_WEBSOCKET_SEND_TIMEOUT_MS;
        assert!(validate_public_config(&config).is_ok());

        config.dashboard_render_hz = MAX_DASHBOARD_RENDER_HZ + 1;
        assert!(validate_public_config(&config).is_err());

        config.dashboard_render_hz = DEFAULT_DASHBOARD_RENDER_HZ;
        config.websocket_send_timeout_ms = MIN_WEBSOCKET_SEND_TIMEOUT_MS - 5;
        assert!(validate_public_config(&config).is_err());

        config.websocket_send_timeout_ms = DEFAULT_WEBSOCKET_SEND_TIMEOUT_MS;
        config.transport_mode = "raw".to_string();
        assert!(validate_public_config(&config).is_err());
    }

    #[test]
    fn uncapped_broadcast_interval_is_zero() {
        let mut config = default_public_config();
        config.broadcast_hz = 0.0;

        let app_config = AppConfig::from_public(
            config,
            250,
            PathBuf::from("config.json"),
            PathBuf::from("static"),
        );

        assert_eq!(app_config.broadcast_interval_ms, 0.0);
    }
}
