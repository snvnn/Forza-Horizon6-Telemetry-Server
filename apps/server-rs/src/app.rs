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
    windows_timer::request_high_resolution_timer,
};

pub async fn run(options: HttpLaunchOptions) -> std::io::Result<()> {
    init_tracing();
    let _timer_resolution = request_high_resolution_timer();

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

pub fn parse_launch_options() -> HttpLaunchOptions {
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

fn init_tracing() {
    let _ = tracing_subscriber::registry()
        .with(EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info")))
        .with(tracing_subscriber::fmt::layer())
        .try_init();
}
