use std::net::SocketAddr;

use tokio::net::UdpSocket;

use crate::{
    config::AppConfig,
    parser::forza_packet_parser::ForzaPacketParser,
    telemetry::{
        telemetry_broadcaster::TelemetryBroadcaster,
        telemetry_store::TelemetryStore,
        telemetry_types::TelemetryPacketInfo,
    },
};

pub async fn run_forza_udp_receiver(
    config: AppConfig,
    store: TelemetryStore,
    parser: ForzaPacketParser,
    broadcaster: TelemetryBroadcaster,
) -> std::io::Result<()> {
    let bind_addr = SocketAddr::new(config.host, config.udp_port);
    let socket = UdpSocket::bind(bind_addr).await?;
    tracing::info!(
        address = %socket.local_addr()?,
        "listening for Forza Data Out UDP packets"
    );

    let mut packet = vec![0_u8; 2048];

    loop {
        // UDP receive stays on the hot path: parse immediately, overwrite the
        // latest in-memory snapshot, then request a capped WebSocket broadcast.
        let (length, remote) = socket.recv_from(&mut packet).await?;
        let packet_slice = &packet[..length];

        match parser.parse(packet_slice) {
            Ok((snapshot, packet_info)) => {
                let snapshot = store.update(snapshot, Some(packet_info)).await;
                broadcaster.request_broadcast(snapshot);
            }
            Err(error) => {
                store
                    .set_last_packet_info(TelemetryPacketInfo {
                        length,
                        format: Some("parse-error".to_string()),
                        profile: "parse-error".to_string(),
                        dash_shift: None,
                        accepted: false,
                        errors: vec![error.clone()],
                        candidates: None,
                    })
                    .await;

                tracing::error!(
                    remote = %remote,
                    length,
                    error,
                    "failed to parse Forza telemetry packet"
                );
            }
        }
    }
}

