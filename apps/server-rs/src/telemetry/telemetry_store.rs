use std::sync::Arc;

use tokio::sync::RwLock;

use super::telemetry_types::{now_millis, TelemetryPacketInfo, TelemetrySnapshot};

#[derive(Clone)]
pub struct TelemetryStore {
    inner: Arc<RwLock<TelemetryStoreInner>>,
    connection_timeout_ms: u64,
}

#[derive(Default)]
struct TelemetryStoreInner {
    latest: Option<TelemetrySnapshot>,
    last_packet_at: u64,
    last_packet_info: Option<TelemetryPacketInfo>,
    sequence: u64,
}

impl TelemetryStore {
    pub fn new(connection_timeout_ms: u64) -> Self {
        Self {
            inner: Arc::new(RwLock::new(TelemetryStoreInner::default())),
            connection_timeout_ms,
        }
    }

    pub async fn update(
        &self,
        mut snapshot: TelemetrySnapshot,
        packet_info: Option<TelemetryPacketInfo>,
    ) -> TelemetrySnapshot {
        let now = now_millis();
        if snapshot.timestamp == 0 {
            snapshot.timestamp = now;
        }
        snapshot.connected = true;

        // The store is latest-only by design. There is no database, export
        // queue, or historical buffer, so slow clients never make UDP handling lag.
        let mut inner = self.inner.write().await;
        inner.sequence = inner.sequence.saturating_add(1);
        inner.last_packet_at = now;
        if let Some(packet_info) = packet_info {
            inner.last_packet_info = Some(packet_info);
        }
        inner.latest = Some(snapshot.clone());
        snapshot
    }

    pub async fn get_latest(&self) -> Option<TelemetrySnapshot> {
        let inner = self.inner.read().await;
        let mut latest = inner.latest.clone()?;
        latest.connected = self.is_connected_at(inner.last_packet_at, now_millis());
        Some(latest)
    }

    pub async fn has_telemetry(&self) -> bool {
        self.inner.read().await.latest.is_some()
    }

    pub async fn last_packet_at(&self) -> u64 {
        self.inner.read().await.last_packet_at
    }

    pub async fn last_packet_info(&self) -> Option<TelemetryPacketInfo> {
        self.inner.read().await.last_packet_info.clone()
    }

    pub async fn set_last_packet_info(&self, packet_info: TelemetryPacketInfo) {
        self.inner.write().await.last_packet_info = Some(packet_info);
    }

    pub async fn sequence(&self) -> u64 {
        self.inner.read().await.sequence
    }

    pub async fn is_connected(&self) -> bool {
        let inner = self.inner.read().await;
        self.is_connected_at(inner.last_packet_at, now_millis())
    }

    fn is_connected_at(&self, last_packet_at: u64, now: u64) -> bool {
        last_packet_at > 0 && now.saturating_sub(last_packet_at) <= self.connection_timeout_ms
    }
}

