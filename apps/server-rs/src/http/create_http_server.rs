use std::net::SocketAddr;

use axum::{extract::State, http::StatusCode, response::IntoResponse, routing::get, Json, Router};
use serde_json::{json, Value};
use tokio::net::TcpListener;
use tower_http::services::{ServeDir, ServeFile};

use crate::{
    config::AppConfig,
    telemetry::{
        telemetry_broadcaster::TelemetryBroadcaster, telemetry_store::TelemetryStore,
    },
    websocket::telemetry_websocket::telemetry_websocket,
};

#[derive(Clone)]
pub struct AppState {
    pub config: AppConfig,
    pub store: TelemetryStore,
    pub broadcaster: TelemetryBroadcaster,
}

pub async fn run_http_server(
    config: AppConfig,
    store: TelemetryStore,
    broadcaster: TelemetryBroadcaster,
) -> std::io::Result<()> {
    let bind_addr = SocketAddr::new(config.host, config.http_port);
    let state = AppState {
        config: config.clone(),
        store,
        broadcaster,
    };
    let app = create_router(state);
    let listener = TcpListener::bind(bind_addr).await?;

    tracing::info!(
        address = %listener.local_addr()?,
        "HTTP/WebSocket server listening"
    );
    tracing::info!(
        "tablet URL example: http://PC_LOCAL_IP:{}",
        config.http_port
    );
    tracing::info!(
        "Windows Firewall must allow this executable on private networks for tablet access"
    );

    axum::serve(listener, app)
        .with_graceful_shutdown(shutdown_signal())
        .await
}

fn create_router(state: AppState) -> Router {
    let dashboard_dist = state.config.dashboard_dist_dir.clone();
    let router = Router::new()
        .route("/api/status", get(api_status))
        .route("/api/telemetry", get(api_telemetry))
        .route("/ws/telemetry", get(telemetry_websocket));

    if dashboard_dist.exists() {
        let static_files =
            ServeDir::new(&dashboard_dist).fallback(ServeFile::new(dashboard_dist.join("index.html")));
        router.fallback_service(static_files).with_state(state)
    } else {
        router.fallback(dashboard_missing).with_state(state)
    }
}

async fn api_status(State(state): State<AppState>) -> impl IntoResponse {
    let last_packet_at = state.store.last_packet_at().await;
    let last_packet_at_json = if last_packet_at == 0 {
        Value::Null
    } else {
        json!(last_packet_at)
    };

    Json(json!({
        "ok": true,
        "connected": state.store.is_connected().await,
        "hasTelemetry": state.store.has_telemetry().await,
        "lastPacketAt": last_packet_at_json,
        "sequence": state.store.sequence().await,
        "websocketClients": state.broadcaster.client_count(),
        "udpPort": state.config.udp_port,
        "httpPort": state.config.http_port,
        "host": state.config.host.to_string(),
        "broadcastHz": state.config.broadcast_hz,
        "broadcastIntervalMs": state.config.broadcast_interval_ms,
        "mockTelemetry": state.config.mock_telemetry,
        "connectionTimeoutMs": state.config.connection_timeout_ms,
        "heartbeatMs": state.config.heartbeat_ms,
        "lastPacket": state.store.last_packet_info().await
    }))
}

async fn api_telemetry(State(state): State<AppState>) -> impl IntoResponse {
    Json(json!({
        "snapshot": state.store.get_latest().await
    }))
}

async fn dashboard_missing(State(state): State<AppState>) -> impl IntoResponse {
    (
        StatusCode::NOT_FOUND,
        Json(json!({
            "error": "Dashboard build not found. Run npm run build:dashboard first or use npm run dev.",
            "dashboardDistDir": state.config.dashboard_dist_dir
        })),
    )
}

async fn shutdown_signal() {
    let _ = tokio::signal::ctrl_c().await;
    tracing::info!("shutdown signal received");
}
