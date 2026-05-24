mod config;
mod http;
mod parser;
mod telemetry;
mod udp;
mod websocket;

use std::time::Duration;

use tokio::time::{interval, MissedTickBehavior};
use tracing_subscriber::{layer::SubscriberExt, util::SubscriberInitExt, EnvFilter};

use crate::{
    config::load_config,
    http::create_http_server::run_http_server,
    parser::forza_packet_parser::{create_mock_telemetry_snapshot, ForzaPacketParser},
    telemetry::{
        telemetry_broadcaster::TelemetryBroadcaster, telemetry_store::TelemetryStore,
        telemetry_types::now_millis,
    },
    udp::forza_udp_receiver::run_forza_udp_receiver,
};

#[tokio::main]
async fn main() -> std::io::Result<()> {
    init_tracing();

    let config = load_config();
    let store = TelemetryStore::new(config.connection_timeout_ms);
    let parser = ForzaPacketParser::new(config.debug_packet);
    let broadcaster = TelemetryBroadcaster::new(config.broadcast_hz);

    tracing::info!(
        broadcast_hz = config.broadcast_hz,
        broadcast_interval_ms = config.broadcast_interval_ms,
        "packet-driven WebSocket broadcaster enabled"
    );

    tokio::spawn({
        let config = config.clone();
        let store = store.clone();
        let broadcaster = broadcaster.clone();

        async move {
            if let Err(error) = run_forza_udp_receiver(config, store, parser, broadcaster).await {
                tracing::error!(%error, "UDP receiver stopped");
            }
        }
    });

    if config.mock_telemetry {
        tracing::info!("mock telemetry enabled at 60Hz");
        tokio::spawn(run_mock_telemetry(store.clone(), broadcaster.clone()));
    }

    tokio::spawn(run_connection_heartbeat(
        store.clone(),
        broadcaster.clone(),
        config.heartbeat_ms,
    ));

    run_http_server(config, store, broadcaster).await
}

fn init_tracing() {
    tracing_subscriber::registry()
        .with(EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info")))
        .with(tracing_subscriber::fmt::layer())
        .init();
}

async fn run_mock_telemetry(store: TelemetryStore, broadcaster: TelemetryBroadcaster) {
    let mut timer = interval(Duration::from_secs_f64(1.0 / 60.0));
    timer.set_missed_tick_behavior(MissedTickBehavior::Skip);

    loop {
        timer.tick().await;
        let snapshot = create_mock_telemetry_snapshot(now_millis());
        let snapshot = store.update(snapshot, None).await;
        broadcaster.request_broadcast(snapshot);
    }
}

async fn run_connection_heartbeat(
    store: TelemetryStore,
    broadcaster: TelemetryBroadcaster,
    heartbeat_ms: u64,
) {
    let mut timer = interval(Duration::from_millis(heartbeat_ms));
    timer.set_missed_tick_behavior(MissedTickBehavior::Skip);

    loop {
        timer.tick().await;

        // When UDP stops, no packet arrives to trigger a broadcast. This small
        // heartbeat pushes connected=false to tablets without adding a DB/queue.
        if let Some(snapshot) = store.get_latest().await {
            if !snapshot.connected {
                broadcaster.request_broadcast(snapshot);
            }
        }
    }
}
