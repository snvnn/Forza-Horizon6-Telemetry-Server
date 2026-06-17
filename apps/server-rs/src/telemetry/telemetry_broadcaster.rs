use std::{
    sync::atomic::{AtomicU64, Ordering},
    sync::{Arc, Mutex},
    time::Duration,
};

use tokio::{select, sync::watch, time::Instant};

use bytes::Bytes;
use serde::Serialize;

use super::{
    telemetry_binary::encode_binary_telemetry_frame,
    telemetry_types::{now_millis, TelemetryMessage, TelemetrySnapshot},
};

const BROADCAST_INTERVAL_EMA_ALPHA: f64 = 0.1;
const BROADCAST_TOKEN_CAPACITY: f64 = 2.0;

#[derive(Clone, Debug)]
pub struct TelemetryBroadcastFrame {
    pub text_payload: Arc<str>,
    pub binary_payload: Bytes,
}

impl TelemetryBroadcastFrame {
    pub fn from_snapshot(
        snapshot: TelemetrySnapshot,
        sequence: u32,
    ) -> Result<Self, serde_json::Error> {
        let binary_payload = encode_binary_telemetry_frame(&snapshot, sequence);
        let text_payload = serde_json::to_string(&TelemetryMessage {
            message_type: "telemetry",
            snapshot,
        })?;

        Ok(Self {
            text_payload: Arc::from(text_payload),
            binary_payload,
        })
    }
}

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TelemetryBroadcastStats {
    pub broadcast_request_count: u64,
    pub broadcast_count: u64,
    pub coalesced_broadcast_requests: u64,
    pub last_broadcast_at: Option<u64>,
    pub broadcast_interval_ema_ms: Option<f64>,
    pub estimated_broadcast_hz: Option<f64>,
    pub last_snapshot_age_ms_at_broadcast: Option<u64>,
    pub max_snapshot_age_ms_at_broadcast: u64,
    pub last_payload_bytes: usize,
    pub max_payload_bytes: usize,
    pub serialization_errors: u64,
    pub websocket_send_count: u64,
    pub websocket_send_errors: u64,
    pub websocket_send_timeouts: u64,
    pub last_websocket_send_ms: Option<f64>,
    pub max_websocket_send_ms: f64,
}

#[derive(Default)]
struct TelemetryBroadcastStatsInner {
    broadcast_count: u64,
    last_broadcast_at: Option<u64>,
    broadcast_interval_ema_ms: Option<f64>,
    last_snapshot_age_ms_at_broadcast: Option<u64>,
    max_snapshot_age_ms_at_broadcast: u64,
    last_payload_bytes: usize,
    max_payload_bytes: usize,
    serialization_errors: u64,
    websocket_send_count: u64,
    websocket_send_errors: u64,
    websocket_send_timeouts: u64,
    last_websocket_send_ms: Option<f64>,
    max_websocket_send_ms: f64,
}

#[derive(Clone)]
pub struct TelemetryBroadcaster {
    request_tx: watch::Sender<Option<TelemetrySnapshot>>,
    watch_tx: watch::Sender<Option<TelemetryBroadcastFrame>>,
    interval_tx: watch::Sender<Duration>,
    websocket_send_timeout_ms: Arc<AtomicU64>,
    stats: Arc<Mutex<TelemetryBroadcastStatsInner>>,
    request_count: Arc<AtomicU64>,
}

impl TelemetryBroadcaster {
    pub fn new(broadcast_hz: f64, websocket_send_timeout_ms: u64) -> Self {
        let interval = broadcast_interval(broadcast_hz);
        let (request_tx, request_rx) = watch::channel(None);
        let (watch_tx, _) = watch::channel(None);
        let (interval_tx, interval_rx) = watch::channel(interval);
        let websocket_send_timeout_ms = Arc::new(AtomicU64::new(websocket_send_timeout_ms));
        let stats = Arc::new(Mutex::new(TelemetryBroadcastStatsInner::default()));
        let request_count = Arc::new(AtomicU64::new(0));
        let broadcast_sequence = Arc::new(AtomicU64::new(0));

        tokio::spawn(run_broadcast_loop(
            request_rx,
            watch_tx.clone(),
            interval_rx,
            stats.clone(),
            broadcast_sequence.clone(),
        ));

        Self {
            request_tx,
            watch_tx,
            interval_tx,
            websocket_send_timeout_ms,
            stats,
            request_count,
        }
    }

    pub fn subscribe(&self) -> watch::Receiver<Option<TelemetryBroadcastFrame>> {
        self.watch_tx.subscribe()
    }

    pub fn client_count(&self) -> usize {
        self.watch_tx.receiver_count()
    }

    pub fn request_broadcast(&self, snapshot: TelemetrySnapshot) {
        // UDP can arrive faster or out of phase with the WebSocket cap. Requests
        // only replace the pending latest snapshot; old frames are intentionally dropped.
        self.request_count.fetch_add(1, Ordering::Relaxed);
        self.request_tx.send_replace(Some(snapshot));
    }

    pub fn set_broadcast_hz(&self, broadcast_hz: f64) {
        let interval = broadcast_interval(broadcast_hz);
        self.interval_tx.send_replace(interval);
    }

    pub fn set_websocket_send_timeout_ms(&self, timeout_ms: u64) {
        self.websocket_send_timeout_ms
            .store(timeout_ms, Ordering::Relaxed);
    }

    pub fn websocket_send_timeout(&self) -> Duration {
        Duration::from_millis(self.websocket_send_timeout_ms.load(Ordering::Relaxed))
    }

    pub fn stats(&self) -> TelemetryBroadcastStats {
        let stats = self.stats.lock().expect("broadcast stats mutex poisoned");
        let broadcast_request_count = self.request_count.load(Ordering::Relaxed);
        let coalesced_broadcast_requests =
            broadcast_request_count.saturating_sub(stats.broadcast_count);
        let estimated_broadcast_hz = stats.broadcast_interval_ema_ms.and_then(|interval| {
            if interval > 0.0 && interval.is_finite() {
                Some(1000.0 / interval)
            } else {
                None
            }
        });

        TelemetryBroadcastStats {
            broadcast_request_count,
            broadcast_count: stats.broadcast_count,
            coalesced_broadcast_requests,
            last_broadcast_at: stats.last_broadcast_at,
            broadcast_interval_ema_ms: stats.broadcast_interval_ema_ms,
            estimated_broadcast_hz,
            last_snapshot_age_ms_at_broadcast: stats.last_snapshot_age_ms_at_broadcast,
            max_snapshot_age_ms_at_broadcast: stats.max_snapshot_age_ms_at_broadcast,
            last_payload_bytes: stats.last_payload_bytes,
            max_payload_bytes: stats.max_payload_bytes,
            serialization_errors: stats.serialization_errors,
            websocket_send_count: stats.websocket_send_count,
            websocket_send_errors: stats.websocket_send_errors,
            websocket_send_timeouts: stats.websocket_send_timeouts,
            last_websocket_send_ms: stats.last_websocket_send_ms,
            max_websocket_send_ms: stats.max_websocket_send_ms,
        }
    }

    pub fn record_websocket_send_success(&self, elapsed: Duration) {
        let mut stats = self.stats.lock().expect("broadcast stats mutex poisoned");
        stats.websocket_send_count = stats.websocket_send_count.saturating_add(1);
        record_websocket_send_duration(&mut stats, elapsed);
    }

    pub fn record_websocket_send_error(&self, elapsed: Duration) {
        let mut stats = self.stats.lock().expect("broadcast stats mutex poisoned");
        stats.websocket_send_errors = stats.websocket_send_errors.saturating_add(1);
        record_websocket_send_duration(&mut stats, elapsed);
    }

    pub fn record_websocket_send_timeout(&self, elapsed: Duration) {
        let mut stats = self.stats.lock().expect("broadcast stats mutex poisoned");
        stats.websocket_send_timeouts = stats.websocket_send_timeouts.saturating_add(1);
        record_websocket_send_duration(&mut stats, elapsed);
    }
}

async fn run_broadcast_loop(
    mut request_rx: watch::Receiver<Option<TelemetrySnapshot>>,
    watch_tx: watch::Sender<Option<TelemetryBroadcastFrame>>,
    mut interval_rx: watch::Receiver<Duration>,
    stats: Arc<Mutex<TelemetryBroadcastStatsInner>>,
    broadcast_sequence: Arc<AtomicU64>,
) {
    let mut interval = *interval_rx.borrow();
    let mut tokens = 1.0;
    let mut last_refill = Instant::now();

    loop {
        select! {
            changed = interval_rx.changed() => {
                if changed.is_err() {
                    break;
                }
                refill_broadcast_tokens(&mut tokens, &mut last_refill, interval);
                interval = *interval_rx.borrow();
            }
            changed = request_rx.changed() => {
                if changed.is_err() {
                    break;
                }
                let pending = request_rx.borrow().clone();
                refill_broadcast_tokens(&mut tokens, &mut last_refill, interval);

                if interval.is_zero() || tokens >= 1.0 {
                    let Some(snapshot) = pending else {
                        continue;
                    };
                    publish_snapshot(&watch_tx, &stats, &broadcast_sequence, snapshot);
                    if !interval.is_zero() {
                        tokens -= 1.0;
                    }
                }
            }
        }
    }
}

fn broadcast_interval(broadcast_hz: f64) -> Duration {
    if broadcast_hz == 0.0 {
        Duration::ZERO
    } else {
        Duration::from_secs_f64(1.0 / broadcast_hz)
    }
}

fn refill_broadcast_tokens(tokens: &mut f64, last_refill: &mut Instant, interval: Duration) {
    let now = Instant::now();
    let interval_seconds = interval.as_secs_f64();
    if interval_seconds > 0.0 {
        let elapsed_seconds = now.duration_since(*last_refill).as_secs_f64();
        *tokens = (*tokens + elapsed_seconds / interval_seconds).min(BROADCAST_TOKEN_CAPACITY);
    }
    *last_refill = now;
}

fn publish_snapshot(
    watch_tx: &watch::Sender<Option<TelemetryBroadcastFrame>>,
    stats: &Arc<Mutex<TelemetryBroadcastStatsInner>>,
    broadcast_sequence: &Arc<AtomicU64>,
    snapshot: TelemetrySnapshot,
) {
    // Serialize once per broadcast tick, not once per WebSocket client. This
    // keeps extra tablets/phones from multiplying JSON CPU cost.
    let snapshot_age_ms = now_millis().saturating_sub(snapshot.timestamp);
    let sequence = broadcast_sequence
        .fetch_add(1, Ordering::Relaxed)
        .wrapping_add(1) as u32;
    match TelemetryBroadcastFrame::from_snapshot(snapshot, sequence) {
        Ok(frame) => {
            record_broadcast(stats, frame.text_payload.len(), snapshot_age_ms);
            watch_tx.send_replace(Some(frame));
        }
        Err(error) => {
            record_serialization_error(stats);
            tracing::warn!(%error, "failed to serialize telemetry broadcast frame");
        }
    }
}

fn record_broadcast(
    stats: &Arc<Mutex<TelemetryBroadcastStatsInner>>,
    payload_bytes: usize,
    snapshot_age_ms: u64,
) {
    let now = now_millis();
    let mut stats = stats.lock().expect("broadcast stats mutex poisoned");
    if let Some(last_broadcast_at) = stats.last_broadcast_at {
        let interval_ms = now.saturating_sub(last_broadcast_at) as f64;
        stats.broadcast_interval_ema_ms = Some(match stats.broadcast_interval_ema_ms {
            Some(previous) => {
                previous * (1.0 - BROADCAST_INTERVAL_EMA_ALPHA)
                    + interval_ms * BROADCAST_INTERVAL_EMA_ALPHA
            }
            None => interval_ms,
        });
    }
    stats.broadcast_count = stats.broadcast_count.saturating_add(1);
    stats.last_broadcast_at = Some(now);
    stats.last_snapshot_age_ms_at_broadcast = Some(snapshot_age_ms);
    stats.max_snapshot_age_ms_at_broadcast =
        stats.max_snapshot_age_ms_at_broadcast.max(snapshot_age_ms);
    stats.last_payload_bytes = payload_bytes;
    stats.max_payload_bytes = stats.max_payload_bytes.max(payload_bytes);
}

fn record_serialization_error(stats: &Arc<Mutex<TelemetryBroadcastStatsInner>>) {
    let mut stats = stats.lock().expect("broadcast stats mutex poisoned");
    stats.serialization_errors = stats.serialization_errors.saturating_add(1);
}

fn record_websocket_send_duration(stats: &mut TelemetryBroadcastStatsInner, elapsed: Duration) {
    let elapsed_ms = elapsed.as_secs_f64() * 1000.0;
    stats.last_websocket_send_ms = Some(elapsed_ms);
    stats.max_websocket_send_ms = stats.max_websocket_send_ms.max(elapsed_ms);
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::telemetry::{
        telemetry_binary::BINARY_TELEMETRY_FRAME_LEN,
        telemetry_types::{InputTelemetry, TelemetrySnapshot, VehicleTelemetry},
    };

    fn snapshot() -> TelemetrySnapshot {
        TelemetrySnapshot {
            timestamp: now_millis(),
            connected: true,
            vehicle: VehicleTelemetry {
                speed_kmh: 100.0,
                rpm: 6000.0,
                max_rpm: Some(8500.0),
                gear: 3,
                power_kw: Some(200.0),
                torque_nm: Some(300.0),
                boost: Some(1.0),
            },
            input: InputTelemetry {
                throttle: 0.5,
                brake: 0.0,
                clutch: None,
                steer: 0.1,
                handbrake: None,
            },
            tires: None,
            motion: None,
            race: None,
        }
    }

    #[test]
    fn broadcast_frame_contains_json_and_binary_payloads() {
        let frame = TelemetryBroadcastFrame::from_snapshot(snapshot(), 99).unwrap();
        let json: serde_json::Value = serde_json::from_str(&frame.text_payload).unwrap();

        assert_eq!(json["type"], "telemetry");
        assert_eq!(json["snapshot"]["vehicle"]["gear"], 3);
        assert_eq!(frame.binary_payload.len(), BINARY_TELEMETRY_FRAME_LEN);
        assert_eq!(
            u32::from_le_bytes(frame.binary_payload[4..8].try_into().unwrap()),
            99
        );
    }

    #[test]
    fn uncapped_interval_is_zero_and_token_refill_is_safe() {
        let interval = broadcast_interval(0.0);
        let mut tokens = 0.0;
        let mut last_refill = Instant::now();

        assert!(interval.is_zero());
        refill_broadcast_tokens(&mut tokens, &mut last_refill, interval);
        assert_eq!(tokens, 0.0);
    }
}
