mod config;
mod http;
mod parser;
mod telemetry;
mod udp;
mod websocket;

use std::{env, sync::Arc};

use tokio::sync::RwLock;
use tracing_subscriber::{layer::SubscriberExt, util::SubscriberInitExt, EnvFilter};

use crate::{
    config::load_config,
    http::create_http_server::{run_http_server, HttpLaunchOptions},
    telemetry::{
        telemetry_broadcaster::TelemetryBroadcaster, telemetry_runtime::TelemetryRuntimeManager,
        telemetry_store::TelemetryStore,
    },
};

#[tokio::main]
async fn main() -> std::io::Result<()> {
    init_tracing();

    let options = parse_launch_options();
    let config = load_config();
    let store = TelemetryStore::new(config.connection_timeout_ms);
    let broadcaster = TelemetryBroadcaster::new(config.broadcast_hz);
    let config = Arc::new(RwLock::new(config));
    let runtime = TelemetryRuntimeManager::new(config.clone(), store.clone(), broadcaster.clone());

    if let Err(error) = runtime.start().await {
        tracing::error!(%error, "telemetry runtime failed to start");
    }

    run_http_server(config, store, broadcaster, runtime, options).await
}

fn init_tracing() {
    tracing_subscriber::registry()
        .with(EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info")))
        .with(tracing_subscriber::fmt::layer())
        .init();
}

fn parse_launch_options() -> HttpLaunchOptions {
    let mut options = HttpLaunchOptions::default();

    for arg in env::args().skip(1) {
        match arg.as_str() {
            "--open-dashboard" => options.open_dashboard = true,
            "--open-settings" => options.open_settings = true,
            "--help" | "-h" => {
                println!("Usage: sim-telemetry-server.exe [--open-dashboard] [--open-settings]");
            }
            _ => tracing::warn!(argument = arg, "unknown CLI argument ignored"),
        }
    }

    options
}
