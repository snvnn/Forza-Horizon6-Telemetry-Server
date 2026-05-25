use tokio::{net::UdpSocket, select, sync::watch};

use crate::{
    parser::forza_packet_parser::ForzaPacketParser,
    telemetry::{
        telemetry_broadcaster::TelemetryBroadcaster, telemetry_store::TelemetryStore,
        telemetry_types::TelemetryPacketInfo,
    },
};

pub async fn run_forza_udp_receiver(
    socket: UdpSocket,
    store: TelemetryStore,
    parser: ForzaPacketParser,
    broadcaster: TelemetryBroadcaster,
    mut stop_rx: watch::Receiver<bool>,
) -> std::io::Result<()> {
    tracing::info!(
        address = %socket.local_addr()?,
        "listening for Forza Data Out UDP packets"
    );

    let mut packet = vec![0_u8; 2048];

    loop {
        // UDP receive stays on the hot path: parse immediately, overwrite the
        // latest in-memory snapshot, then request a capped WebSocket broadcast.
        let receive_result = select! {
            changed = stop_rx.changed() => {
                if changed.is_err() || *stop_rx.borrow() {
                    tracing::info!("UDP receiver stop requested");
                    break;
                }
                continue;
            }
            result = socket.recv_from(&mut packet) => result,
        };

        let (length, remote) = receive_result?;
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

    Ok(())
}
