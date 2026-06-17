use std::{
    net::{SocketAddr, UdpSocket as StdUdpSocket},
    sync::Arc,
    time::Duration,
};

use serde::Serialize;
use socket2::{Domain, Protocol, Socket, Type};
use tokio::{
    net::UdpSocket,
    sync::{watch, Mutex, RwLock},
    task::JoinHandle,
    time::{interval, MissedTickBehavior},
};

use crate::{
    config::AppConfig,
    parser::forza_packet_parser::{create_mock_telemetry_snapshot, ForzaPacketParser},
    udp::forza_udp_receiver::run_forza_udp_receiver,
};

use super::{
    telemetry_broadcaster::TelemetryBroadcaster, telemetry_store::TelemetryStore,
    telemetry_types::now_millis,
};

#[derive(Clone)]
pub struct TelemetryRuntimeManager {
    config: Arc<RwLock<AppConfig>>,
    store: TelemetryStore,
    broadcaster: TelemetryBroadcaster,
    inner: Arc<Mutex<RuntimeInner>>,
}

#[derive(Default)]
struct RuntimeInner {
    stop_tx: Option<watch::Sender<bool>>,
    udp_handle: Option<JoinHandle<()>>,
    mock_handle: Option<JoinHandle<()>>,
    heartbeat_handle: Option<JoinHandle<()>>,
    udp_listening_address: Option<String>,
    udp_receive_buffer_bytes: Option<usize>,
    mock_telemetry: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TelemetryRuntimeStatus {
    pub telemetry_running: bool,
    pub udp_listening_address: Option<String>,
    pub udp_receive_buffer_bytes: Option<usize>,
    pub mock_telemetry: bool,
}

impl TelemetryRuntimeManager {
    pub fn new(
        config: Arc<RwLock<AppConfig>>,
        store: TelemetryStore,
        broadcaster: TelemetryBroadcaster,
    ) -> Self {
        Self {
            config,
            store,
            broadcaster,
            inner: Arc::new(Mutex::new(RuntimeInner::default())),
        }
    }

    pub async fn start(&self) -> Result<TelemetryRuntimeStatus, String> {
        let mut inner = self.inner.lock().await;
        if inner.is_running() {
            return Ok(inner.status());
        }

        let config = self.config.read().await.clone();
        let udp_addr = config.udp_socket_addr()?;

        self.store
            .set_connection_timeout_ms(config.connection_timeout_ms);
        self.broadcaster.set_broadcast_hz(config.broadcast_hz);
        self.broadcaster
            .set_websocket_send_timeout_ms(config.websocket_send_timeout_ms);

        // UDP 수신기는 텔레메트리 런타임에 속한다. Settings 화면은 계속 살아 있고,
        // Start/Stop/Restart는 이 소켓과 관련 작업만 제어한다.
        let (socket, udp_receive_buffer_bytes) =
            bind_udp_socket(udp_addr, config.udp_receive_buffer_bytes)?;
        let local_addr = socket
            .local_addr()
            .map_err(|error| format!("Failed to read UDP local address: {error}"))?;

        let (stop_tx, stop_rx) = watch::channel(false);
        let parser = ForzaPacketParser::new(config.debug_packet);
        let udp_handle = tokio::spawn({
            let store = self.store.clone();
            let broadcaster = self.broadcaster.clone();
            async move {
                if let Err(error) =
                    run_forza_udp_receiver(socket, store, parser, broadcaster, stop_rx).await
                {
                    tracing::error!(%error, "UDP receiver stopped");
                }
            }
        });

        let heartbeat_handle = tokio::spawn(run_connection_heartbeat(
            self.store.clone(),
            self.broadcaster.clone(),
            config.heartbeat_ms,
            stop_tx.subscribe(),
        ));

        let mock_handle = if config.mock_telemetry {
            tracing::info!("mock telemetry enabled at 60Hz");
            Some(tokio::spawn(run_mock_telemetry(
                self.store.clone(),
                self.broadcaster.clone(),
                stop_tx.subscribe(),
            )))
        } else {
            None
        };

        inner.stop_tx = Some(stop_tx);
        inner.udp_handle = Some(udp_handle);
        inner.mock_handle = mock_handle;
        inner.heartbeat_handle = Some(heartbeat_handle);
        inner.udp_listening_address = Some(local_addr.to_string());
        inner.udp_receive_buffer_bytes = Some(udp_receive_buffer_bytes);
        inner.mock_telemetry = config.mock_telemetry;

        tracing::info!(
            udp = %local_addr,
            udp_receive_buffer_bytes,
            mock = config.mock_telemetry,
            "telemetry runtime started"
        );

        Ok(inner.status())
    }

    pub async fn stop(&self) -> Result<TelemetryRuntimeStatus, String> {
        let mut inner = self.inner.lock().await;
        if !inner.is_running() {
            return Ok(inner.status());
        }

        if let Some(stop_tx) = inner.stop_tx.take() {
            let _ = stop_tx.send(true);
        }

        let handles = [
            inner.udp_handle.take(),
            inner.mock_handle.take(),
            inner.heartbeat_handle.take(),
        ];

        for handle in handles.into_iter().flatten() {
            if let Err(error) = handle.await {
                tracing::warn!(%error, "telemetry task did not stop cleanly");
            }
        }

        inner.udp_listening_address = None;
        inner.udp_receive_buffer_bytes = None;
        inner.mock_telemetry = false;
        if let Some(snapshot) = self.store.mark_disconnected().await {
            self.broadcaster.request_broadcast(snapshot);
        }
        tracing::info!("telemetry runtime stopped");

        Ok(inner.status())
    }

    pub async fn restart(&self) -> Result<TelemetryRuntimeStatus, String> {
        self.stop().await?;
        self.start().await
    }

    pub async fn status(&self) -> TelemetryRuntimeStatus {
        self.inner.lock().await.status()
    }
}

impl RuntimeInner {
    fn is_running(&self) -> bool {
        self.stop_tx.is_some()
    }

    fn status(&self) -> TelemetryRuntimeStatus {
        TelemetryRuntimeStatus {
            telemetry_running: self.is_running(),
            udp_listening_address: self.udp_listening_address.clone(),
            udp_receive_buffer_bytes: self.udp_receive_buffer_bytes,
            mock_telemetry: self.mock_telemetry,
        }
    }
}

fn bind_udp_socket(
    udp_addr: SocketAddr,
    receive_buffer_bytes: usize,
) -> Result<(UdpSocket, usize), String> {
    let domain = if udp_addr.is_ipv4() {
        Domain::IPV4
    } else {
        Domain::IPV6
    };
    let socket = Socket::new(domain, Type::DGRAM, Some(Protocol::UDP))
        .map_err(|error| format!("Failed to create UDP socket: {error}"))?;

    // A larger OS receive buffer gives the runtime room to absorb short CPU,
    // scheduler, or GC-like stalls without dropping Forza UDP packets.
    socket
        .set_recv_buffer_size(receive_buffer_bytes)
        .map_err(|error| format!("Failed to set UDP receive buffer: {error}"))?;
    socket
        .bind(&udp_addr.into())
        .map_err(|error| format!("Failed to bind UDP {udp_addr}: {error}"))?;

    let actual_receive_buffer = socket.recv_buffer_size().unwrap_or(receive_buffer_bytes);
    let std_socket: StdUdpSocket = socket.into();
    std_socket
        .set_nonblocking(true)
        .map_err(|error| format!("Failed to set UDP socket nonblocking: {error}"))?;
    let socket = UdpSocket::from_std(std_socket)
        .map_err(|error| format!("Failed to create Tokio UDP socket: {error}"))?;

    Ok((socket, actual_receive_buffer))
}

async fn run_mock_telemetry(
    store: TelemetryStore,
    broadcaster: TelemetryBroadcaster,
    mut stop_rx: watch::Receiver<bool>,
) {
    let mut timer = interval(Duration::from_secs_f64(1.0 / 60.0));
    timer.set_missed_tick_behavior(MissedTickBehavior::Skip);

    loop {
        tokio::select! {
            changed = stop_rx.changed() => {
                if changed.is_err() || *stop_rx.borrow() {
                    break;
                }
            }
            _ = timer.tick() => {
                let snapshot = create_mock_telemetry_snapshot(now_millis());
                let snapshot = store.update(snapshot, None).await;
                broadcaster.request_broadcast(snapshot);
            }
        }
    }
}

async fn run_connection_heartbeat(
    store: TelemetryStore,
    broadcaster: TelemetryBroadcaster,
    heartbeat_ms: u64,
    mut stop_rx: watch::Receiver<bool>,
) {
    let mut timer = interval(Duration::from_millis(heartbeat_ms));
    timer.set_missed_tick_behavior(MissedTickBehavior::Skip);

    loop {
        tokio::select! {
            changed = stop_rx.changed() => {
                if changed.is_err() || *stop_rx.borrow() {
                    break;
                }
            }
            _ = timer.tick() => {
                // UDP가 끊기면 새 패킷이 오지 않으므로 connected=false 상태도
                // broadcast throttle을 통해 한 번 더 밀어 태블릿 화면을 갱신한다.
                if let Some(snapshot) = store.get_latest().await {
                    if !snapshot.connected {
                        broadcaster.request_broadcast(snapshot);
                    }
                }
            }
        }
    }
}
