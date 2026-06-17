use tokio::{
    net::UdpSocket,
    select,
    sync::watch,
    time::{Duration, Instant},
};

use crate::{
    parser::forza_packet_parser::ForzaPacketParser,
    telemetry::{
        telemetry_broadcaster::TelemetryBroadcaster, telemetry_store::TelemetryStore,
        telemetry_types::TelemetryPacketInfo,
    },
};

const PACKET_INFO_SAMPLE_INTERVAL: Duration = Duration::from_millis(250);

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
    let mut next_packet_info_sample_at = Instant::now();

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
        let capture_packet_info = Instant::now() >= next_packet_info_sample_at;

        let parse_result = if capture_packet_info {
            parser
                .parse(packet_slice)
                .map(|(snapshot, packet_info)| (snapshot, Some(packet_info)))
        } else {
            parser
                .parse_snapshot(packet_slice)
                .map(|snapshot| (snapshot, None))
        };

        match parse_result {
            Ok((snapshot, packet_info)) => {
                if capture_packet_info {
                    next_packet_info_sample_at = Instant::now() + PACKET_INFO_SAMPLE_INTERVAL;
                }
                let snapshot = store.update(snapshot, packet_info).await;
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
