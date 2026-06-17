use std::{path::PathBuf, process::Command, sync::Arc};

use axum::{
    extract::{rejection::JsonRejection, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use serde::Serialize;
use serde_json::{json, Value};
use tokio::{net::TcpListener, sync::RwLock};
use tower_http::services::{ServeDir, ServeFile};

use crate::{
    config::{
        local_dashboard_url, local_settings_url, network_dashboard_url, save_public_config,
        validate_public_config, AppConfig, PublicConfig, SUPPORTED_GAME_ADAPTERS,
    },
    telemetry::{
        telemetry_broadcaster::TelemetryBroadcaster,
        telemetry_runtime::{TelemetryRuntimeManager, TelemetryRuntimeStatus},
        telemetry_store::TelemetryStore,
        telemetry_types::now_millis,
    },
    websocket::telemetry_websocket::{telemetry_binary_websocket, telemetry_websocket},
};

#[derive(Clone)]
pub struct AppState {
    pub config: Arc<RwLock<AppConfig>>,
    pub store: TelemetryStore,
    pub broadcaster: TelemetryBroadcaster,
    pub runtime: TelemetryRuntimeManager,
    pub dashboard_dist_dir: PathBuf,
    pub http_listening_address: String,
}

#[derive(Clone, Copy, Debug, Default)]
pub struct HttpLaunchOptions {
    pub open_dashboard: bool,
    pub open_settings: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RuntimeActionResponse {
    ok: bool,
    status: TelemetryRuntimeStatus,
}

pub async fn run_http_server(
    config: Arc<RwLock<AppConfig>>,
    store: TelemetryStore,
    broadcaster: TelemetryBroadcaster,
    runtime: TelemetryRuntimeManager,
    options: HttpLaunchOptions,
) -> std::io::Result<()> {
    let initial_config = config.read().await.clone();
    let bind_addr = initial_config
        .http_socket_addr()
        .map_err(|error| std::io::Error::new(std::io::ErrorKind::InvalidInput, error))?;
    let dashboard_dist_dir = initial_config.dashboard_dist_dir.clone();
    let listener = TcpListener::bind(bind_addr).await?;
    let http_listening_address = listener.local_addr()?.to_string();

    print_startup_info(&initial_config, &http_listening_address);

    let state = AppState {
        config: config.clone(),
        store,
        broadcaster,
        runtime: runtime.clone(),
        dashboard_dist_dir,
        http_listening_address,
    };
    let app = create_router(state);

    if options.open_dashboard {
        open_url(local_dashboard_url(&initial_config));
    }
    if options.open_settings {
        open_url(local_settings_url(&initial_config));
    }

    axum::serve(listener, app)
        .with_graceful_shutdown(shutdown_signal(runtime))
        .await
}

fn create_router(state: AppState) -> Router {
    let dashboard_dist = state.dashboard_dist_dir.clone();
    let router = Router::new()
        .route("/api/status", get(api_status))
        .route("/api/time", get(api_time))
        .route("/api/telemetry", get(api_telemetry))
        .route("/api/config", get(api_config).put(api_put_config))
        .route("/api/runtime/start", post(api_runtime_start))
        .route("/api/runtime/stop", post(api_runtime_stop))
        .route("/api/runtime/restart", post(api_runtime_restart))
        .route("/ws/telemetry", get(telemetry_websocket))
        .route("/ws/telemetry.bin", get(telemetry_binary_websocket));

    if dashboard_dist.exists() {
        // Production dashboard serving uses exe-relative `static` first, then
        // development dist folders. This keeps the Windows zip simple: exe + static/.
        let static_files = ServeDir::new(&dashboard_dist)
            .fallback(ServeFile::new(dashboard_dist.join("index.html")));
        router.fallback_service(static_files).with_state(state)
    } else {
        router.fallback(dashboard_missing).with_state(state)
    }
}

async fn api_status(State(state): State<AppState>) -> impl IntoResponse {
    let config = state.config.read().await.clone();
    let active_http_config = config_with_active_http_port(&config, &state.http_listening_address);
    let runtime_status = state.runtime.status().await;
    let last_packet_at = state.store.last_packet_at().await;
    let last_packet_info_at = state.store.last_packet_info_at().await;
    let timing_stats = state.store.timing_stats().await;
    let broadcast_stats = state.broadcaster.stats();
    let last_packet_at_json = if last_packet_at == 0 {
        Value::Null
    } else {
        json!(last_packet_at)
    };
    let last_packet_info_at_json = if last_packet_info_at == 0 {
        Value::Null
    } else {
        json!(last_packet_info_at)
    };

    Json(json!({
        "ok": true,
        "appRunning": true,
        "telemetryRunning": runtime_status.telemetry_running,
        "connected": state.store.is_connected().await,
        "gameConnected": state.store.is_connected().await,
        "hasTelemetry": state.store.has_telemetry().await,
        "lastPacketAt": last_packet_at_json,
        "lastPacketInfoAt": last_packet_info_at_json,
        "lastPacketAgeMs": timing_stats.last_packet_age_ms,
        "packetIntervalEmaMs": timing_stats.packet_interval_ema_ms,
        "estimatedPacketHz": timing_stats.estimated_packet_hz,
        "maxPacketGapMs": timing_stats.max_packet_gap_ms,
        "packetGapCount": timing_stats.packet_gap_count,
        "packetGapWarningMs": timing_stats.packet_gap_warning_ms,
        "packetGapHistogram": timing_stats.packet_gap_histogram,
        "recentPacketGaps": timing_stats.recent_packet_gaps,
        "receivedPacketCount": state.store.sequence().await,
        "websocketClients": state.broadcaster.client_count(),
        "udpListeningAddress": runtime_status.udp_listening_address,
        "udpReceiveBufferBytes": runtime_status.udp_receive_buffer_bytes.unwrap_or(config.udp_receive_buffer_bytes),
        "httpListeningAddress": state.http_listening_address,
        "gameAdapter": config.game_adapter,
        "broadcastHz": config.broadcast_hz,
        "broadcastIntervalMs": config.broadcast_interval_ms,
        "transportMode": config.transport_mode,
        "dashboardRenderHz": config.dashboard_render_hz,
        "websocketSendTimeoutMs": config.websocket_send_timeout_ms,
        "broadcastStats": broadcast_stats,
        "mockTelemetry": runtime_status.mock_telemetry,
        "connectionTimeoutMs": config.connection_timeout_ms,
        "heartbeatMs": config.heartbeat_ms,
        "urls": dashboard_urls(&active_http_config),
        "lastPacket": state.store.last_packet_info().await
    }))
}

async fn api_time() -> impl IntoResponse {
    Json(json!({
        "ok": true,
        "serverTimeMs": now_millis()
    }))
}

async fn api_telemetry(State(state): State<AppState>) -> impl IntoResponse {
    Json(json!({
        "snapshot": state.store.get_latest().await
    }))
}

async fn api_config(State(state): State<AppState>) -> impl IntoResponse {
    let config = state.config.read().await.clone();
    Json(json!({
        "ok": true,
        "config": config.to_public(),
        "supportedGameAdapters": SUPPORTED_GAME_ADAPTERS,
        "urls": dashboard_urls(&config),
        "warnings": config_warnings(&config.to_public())
    }))
}

async fn api_put_config(
    State(state): State<AppState>,
    payload: Result<Json<PublicConfig>, JsonRejection>,
) -> Response {
    let Json(next_public) = match payload {
        Ok(payload) => payload,
        Err(error) => {
            return json_error(
                StatusCode::BAD_REQUEST,
                "Invalid config JSON",
                Some(vec![error.to_string()]),
            )
        }
    };

    if let Err(errors) = validate_public_config(&next_public) {
        return json_error(
            StatusCode::BAD_REQUEST,
            "Invalid configuration",
            Some(errors),
        );
    }

    let old_config = state.config.read().await.clone();
    let old_public = old_config.to_public();
    let requires_telemetry_restart = old_public.game_adapter != next_public.game_adapter
        || old_public.udp_host != next_public.udp_host
        || old_public.udp_port != next_public.udp_port
        || old_public.udp_receive_buffer_bytes != next_public.udp_receive_buffer_bytes
        || old_public.mock_telemetry != next_public.mock_telemetry
        || old_public.debug_packet != next_public.debug_packet;
    let requires_app_restart = old_public.http_host != next_public.http_host
        || old_public.http_port != next_public.http_port;

    if let Err(error) = save_public_config(&next_public, &old_config.config_path) {
        return json_error(StatusCode::INTERNAL_SERVER_ERROR, error, None);
    }

    let next_config = AppConfig::from_public(
        next_public.clone(),
        old_config.heartbeat_ms,
        old_config.config_path.clone(),
        old_config.dashboard_dist_dir.clone(),
    );

    {
        let mut config = state.config.write().await;
        *config = next_config.clone();
    }

    // Broadcast Hz and timeout are safe to apply immediately. UDP bind changes
    // still require a telemetry runtime restart because they replace the socket.
    state.broadcaster.set_broadcast_hz(next_config.broadcast_hz);
    state
        .broadcaster
        .set_websocket_send_timeout_ms(next_config.websocket_send_timeout_ms);
    state
        .store
        .set_connection_timeout_ms(next_config.connection_timeout_ms);

    Json(json!({
        "ok": true,
        "config": next_config.to_public(),
        "requiresTelemetryRestart": requires_telemetry_restart,
        "requiresAppRestart": requires_app_restart,
        "warnings": config_warnings(&next_config.to_public())
    }))
    .into_response()
}

async fn api_runtime_start(State(state): State<AppState>) -> Response {
    runtime_response(state.runtime.start().await)
}

async fn api_runtime_stop(State(state): State<AppState>) -> Response {
    runtime_response(state.runtime.stop().await)
}

async fn api_runtime_restart(State(state): State<AppState>) -> Response {
    runtime_response(state.runtime.restart().await)
}

async fn dashboard_missing(State(state): State<AppState>) -> impl IntoResponse {
    (
        StatusCode::NOT_FOUND,
        Json(json!({
            "error": "Dashboard build not found. Run npm run build:dashboard first or use npm run dev.",
            "dashboardDistDir": state.dashboard_dist_dir
        })),
    )
}

fn runtime_response(result: Result<TelemetryRuntimeStatus, String>) -> Response {
    match result {
        Ok(status) => Json(RuntimeActionResponse { ok: true, status }).into_response(),
        Err(error) => json_error(StatusCode::INTERNAL_SERVER_ERROR, error, None),
    }
}

fn json_error(
    status: StatusCode,
    message: impl Into<String>,
    details: Option<Vec<String>>,
) -> Response {
    (
        status,
        Json(json!({
            "ok": false,
            "error": message.into(),
            "details": details.unwrap_or_default()
        })),
    )
        .into_response()
}

fn dashboard_urls(config: &AppConfig) -> Value {
    json!({
        "localDashboardUrl": local_dashboard_url(config),
        "localSettingsUrl": local_settings_url(config),
        "networkDashboardUrl": network_dashboard_url(config)
    })
}

fn config_warnings(config: &PublicConfig) -> Vec<String> {
    let mut warnings = Vec::new();
    if (5200..=5300).contains(&config.udp_port) {
        warnings.push(
            "Forza Horizon 6 documentation recommends avoiding UDP ports 5200-5300.".to_string(),
        );
    }
    warnings
}

fn config_with_active_http_port(config: &AppConfig, http_listening_address: &str) -> AppConfig {
    let mut active = config.clone();
    if let Ok(address) = http_listening_address.parse::<std::net::SocketAddr>() {
        active.http_port = address.port();
    }
    active
}

fn print_startup_info(config: &AppConfig, http_listening_address: &str) {
    println!();
    println!("Sim Telemetry Server started");
    println!();
    println!("Game Adapter:");
    println!("  {}", config.game_adapter);
    println!();
    println!("UDP:");
    println!("  Listening on {}:{}", config.udp_host, config.udp_port);
    println!(
        "  Receive buffer: {} bytes",
        config.udp_receive_buffer_bytes
    );
    println!();
    println!("HTTP:");
    println!("  Listening on {http_listening_address}");
    println!();
    println!("Dashboard:");
    println!("  Local:    {}", local_dashboard_url(config));
    println!("  Settings: {}", local_settings_url(config));
    if let Some(network_url) = network_dashboard_url(config) {
        println!("  Network:  {network_url}");
    } else {
        println!(
            "  Network:  check ipconfig, then open http://PC_LOCAL_IP:{}/dashboard",
            config.http_port
        );
    }
    println!();
    println!("Broadcast:");
    if config.broadcast_hz == 0.0 {
        println!("  uncapped");
    } else {
        println!("  {} Hz", config.broadcast_hz);
    }
    println!("  Transport: {}", config.transport_mode);
    println!(
        "  WebSocket send timeout: {} ms",
        config.websocket_send_timeout_ms
    );
    println!(
        "  Dashboard render target: {} Hz",
        config.dashboard_render_hz
    );
    println!();
    println!("Mock Telemetry:");
    println!("  {}", config.mock_telemetry);
    println!();
    println!("Windows Firewall: allow Private networks when tablet/phone access is needed.");
    println!();
}

fn open_url(url: String) {
    #[cfg(target_os = "windows")]
    let result = Command::new("cmd").args(["/C", "start", "", &url]).spawn();

    #[cfg(target_os = "macos")]
    let result = Command::new("open").arg(&url).spawn();

    #[cfg(all(unix, not(target_os = "macos")))]
    let result = Command::new("xdg-open").arg(&url).spawn();

    if let Err(error) = result {
        tracing::warn!(%error, url, "failed to open browser");
    }
}

async fn shutdown_signal(runtime: TelemetryRuntimeManager) {
    let _ = tokio::signal::ctrl_c().await;
    tracing::info!("shutdown signal received");
    if let Err(error) = runtime.stop().await {
        tracing::warn!(%error, "telemetry runtime shutdown failed");
    }
}
