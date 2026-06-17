use std::{
    collections::VecDeque,
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc,
    },
};

use serde::Serialize;
use tokio::sync::RwLock;

use super::telemetry_types::{now_millis, TelemetryPacketInfo, TelemetrySnapshot};

const UNKNOWN_SHIFT_GEAR: i32 = -2;
const PACKET_GAP_WARNING_MS: u64 = 50;
const RECENT_PACKET_GAP_CAPACITY: usize = 16;

#[derive(Clone)]
pub struct TelemetryStore {
    inner: Arc<RwLock<TelemetryStoreInner>>,
    connection_timeout_ms: Arc<AtomicU64>,
}

#[derive(Default)]
struct TelemetryStoreInner {
    latest: Option<TelemetrySnapshot>,
    last_packet_at: u64,
    last_packet_info: Option<TelemetryPacketInfo>,
    last_packet_info_at: u64,
    sequence: u64,
    packet_interval_ema_ms: Option<f64>,
    max_packet_gap_ms: u64,
    packet_gap_count: u64,
    packet_gap_histogram: PacketGapHistogram,
    recent_packet_gaps: VecDeque<PacketGapSample>,
}

#[derive(Clone, Debug)]
pub struct PacketTimingStats {
    pub last_packet_age_ms: Option<u64>,
    pub packet_interval_ema_ms: Option<f64>,
    pub estimated_packet_hz: Option<f64>,
    pub max_packet_gap_ms: u64,
    pub packet_gap_count: u64,
    pub packet_gap_warning_ms: u64,
    pub packet_gap_histogram: PacketGapHistogram,
    pub recent_packet_gaps: Vec<PacketGapSample>,
}

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PacketGapHistogram {
    pub le_8_ms: u64,
    pub le_16_ms: u64,
    pub le_33_ms: u64,
    pub le_50_ms: u64,
    pub le_100_ms: u64,
    pub le_250_ms: u64,
    pub gt_250_ms: u64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PacketGapSample {
    pub at: u64,
    pub gap_ms: u64,
}

impl TelemetryStore {
    pub fn new(connection_timeout_ms: u64) -> Self {
        Self {
            inner: Arc::new(RwLock::new(TelemetryStoreInner::default())),
            connection_timeout_ms: Arc::new(AtomicU64::new(connection_timeout_ms)),
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
        if snapshot.vehicle.gear <= UNKNOWN_SHIFT_GEAR {
            if let Some(previous) = inner.latest.as_ref() {
                if previous.vehicle.gear >= -1 && previous.vehicle.gear <= 10 {
                    // FH6 can briefly emit non-display gear values while the
                    // gearbox is between ratios. Keep the last valid display
                    // gear instead of flashing "11" or an unknown value.
                    snapshot.vehicle.gear = previous.vehicle.gear;
                }
            }
        }
        if inner.last_packet_at > 0 {
            let gap_ms = now.saturating_sub(inner.last_packet_at);
            record_packet_gap_bucket(&mut inner.packet_gap_histogram, gap_ms);
            inner.max_packet_gap_ms = inner.max_packet_gap_ms.max(gap_ms);
            if gap_ms >= PACKET_GAP_WARNING_MS {
                inner.packet_gap_count = inner.packet_gap_count.saturating_add(1);
                if inner.recent_packet_gaps.len() == RECENT_PACKET_GAP_CAPACITY {
                    inner.recent_packet_gaps.pop_front();
                }
                inner
                    .recent_packet_gaps
                    .push_back(PacketGapSample { at: now, gap_ms });
            }
            inner.packet_interval_ema_ms = Some(match inner.packet_interval_ema_ms {
                Some(previous) => previous * 0.9 + gap_ms as f64 * 0.1,
                None => gap_ms as f64,
            });
        }
        inner.sequence = inner.sequence.saturating_add(1);
        inner.last_packet_at = now;
        if let Some(packet_info) = packet_info {
            inner.last_packet_info = Some(packet_info);
            inner.last_packet_info_at = now;
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

    pub async fn last_packet_info_at(&self) -> u64 {
        self.inner.read().await.last_packet_info_at
    }

    pub async fn set_last_packet_info(&self, packet_info: TelemetryPacketInfo) {
        let mut inner = self.inner.write().await;
        inner.last_packet_info = Some(packet_info);
        inner.last_packet_info_at = now_millis();
    }

    pub async fn mark_disconnected(&self) -> Option<TelemetrySnapshot> {
        let mut inner = self.inner.write().await;
        let latest = inner.latest.as_mut()?;
        latest.connected = false;
        Some(latest.clone())
    }

    pub async fn sequence(&self) -> u64 {
        self.inner.read().await.sequence
    }

    pub async fn timing_stats(&self) -> PacketTimingStats {
        let inner = self.inner.read().await;
        let now = now_millis();
        let last_packet_age_ms = if inner.last_packet_at == 0 {
            None
        } else {
            Some(now.saturating_sub(inner.last_packet_at))
        };
        let estimated_packet_hz = inner.packet_interval_ema_ms.and_then(|interval| {
            if interval > 0.0 && interval.is_finite() {
                Some(1000.0 / interval)
            } else {
                None
            }
        });

        PacketTimingStats {
            last_packet_age_ms,
            packet_interval_ema_ms: inner.packet_interval_ema_ms,
            estimated_packet_hz,
            max_packet_gap_ms: inner.max_packet_gap_ms,
            packet_gap_count: inner.packet_gap_count,
            packet_gap_warning_ms: PACKET_GAP_WARNING_MS,
            packet_gap_histogram: inner.packet_gap_histogram.clone(),
            recent_packet_gaps: inner.recent_packet_gaps.iter().cloned().collect(),
        }
    }

    pub async fn is_connected(&self) -> bool {
        let inner = self.inner.read().await;
        self.is_connected_at(inner.last_packet_at, now_millis())
    }

    pub fn set_connection_timeout_ms(&self, connection_timeout_ms: u64) {
        self.connection_timeout_ms
            .store(connection_timeout_ms, Ordering::Relaxed);
    }

    fn is_connected_at(&self, last_packet_at: u64, now: u64) -> bool {
        let connection_timeout_ms = self.connection_timeout_ms.load(Ordering::Relaxed);
        last_packet_at > 0 && now.saturating_sub(last_packet_at) <= connection_timeout_ms
    }
}

fn record_packet_gap_bucket(histogram: &mut PacketGapHistogram, gap_ms: u64) {
    match gap_ms {
        0..=8 => histogram.le_8_ms = histogram.le_8_ms.saturating_add(1),
        9..=16 => histogram.le_16_ms = histogram.le_16_ms.saturating_add(1),
        17..=33 => histogram.le_33_ms = histogram.le_33_ms.saturating_add(1),
        34..=50 => histogram.le_50_ms = histogram.le_50_ms.saturating_add(1),
        51..=100 => histogram.le_100_ms = histogram.le_100_ms.saturating_add(1),
        101..=250 => histogram.le_250_ms = histogram.le_250_ms.saturating_add(1),
        _ => histogram.gt_250_ms = histogram.gt_250_ms.saturating_add(1),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::telemetry::telemetry_types::{InputTelemetry, VehicleTelemetry};

    fn snapshot_with_gear(gear: i32) -> TelemetrySnapshot {
        TelemetrySnapshot {
            timestamp: 1,
            connected: true,
            vehicle: VehicleTelemetry {
                speed_kmh: 0.0,
                rpm: 900.0,
                max_rpm: Some(8500.0),
                gear,
                power_kw: Some(0.0),
                torque_nm: Some(0.0),
                boost: Some(0.0),
            },
            input: InputTelemetry {
                throttle: 0.0,
                brake: 0.0,
                clutch: Some(0.0),
                steer: 0.0,
                handbrake: Some(0.0),
            },
            tires: None,
            motion: None,
            race: None,
        }
    }

    #[tokio::test]
    async fn keeps_previous_valid_gear_during_shift_transition() {
        let store = TelemetryStore::new(2000);
        store.update(snapshot_with_gear(3), None).await;

        let updated = store
            .update(snapshot_with_gear(UNKNOWN_SHIFT_GEAR), None)
            .await;

        assert_eq!(updated.vehicle.gear, 3);
        assert_eq!(store.get_latest().await.unwrap().vehicle.gear, 3);
    }

    #[tokio::test]
    async fn records_packet_timing_stats() {
        let store = TelemetryStore::new(2000);
        store.update(snapshot_with_gear(1), None).await;
        store.update(snapshot_with_gear(2), None).await;

        let stats = store.timing_stats().await;

        assert!(stats.last_packet_age_ms.is_some());
        assert!(stats.packet_interval_ema_ms.is_some());
        assert!(stats.packet_gap_warning_ms > 0);
    }

    #[tokio::test]
    async fn records_recent_packet_gap_samples_and_histogram() {
        let store = TelemetryStore::new(2000);
        store.update(snapshot_with_gear(1), None).await;

        {
            let mut inner = store.inner.write().await;
            inner.last_packet_at = now_millis().saturating_sub(75);
        }

        store.update(snapshot_with_gear(2), None).await;
        let stats = store.timing_stats().await;

        assert_eq!(stats.packet_gap_count, 1);
        assert_eq!(stats.recent_packet_gaps.len(), 1);
        assert!(stats.recent_packet_gaps[0].gap_ms >= PACKET_GAP_WARNING_MS);
        assert!(stats.packet_gap_histogram.le_100_ms >= 1);
    }
}
