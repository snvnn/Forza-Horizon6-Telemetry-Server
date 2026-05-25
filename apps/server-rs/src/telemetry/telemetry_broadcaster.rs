use std::time::Duration;

use tokio::{
    select,
    sync::watch,
    time::{sleep_until, Instant},
};

use super::telemetry_types::TelemetrySnapshot;

#[derive(Clone)]
pub struct TelemetryBroadcaster {
    request_tx: watch::Sender<Option<TelemetrySnapshot>>,
    watch_tx: watch::Sender<Option<TelemetrySnapshot>>,
    interval_tx: watch::Sender<Duration>,
}

impl TelemetryBroadcaster {
    pub fn new(broadcast_hz: f64) -> Self {
        let interval = Duration::from_secs_f64(1.0 / broadcast_hz);
        let (request_tx, request_rx) = watch::channel(None);
        let (watch_tx, _) = watch::channel(None);
        let (interval_tx, interval_rx) = watch::channel(interval);

        tokio::spawn(run_broadcast_loop(
            request_rx,
            watch_tx.clone(),
            interval_rx,
        ));

        Self {
            request_tx,
            watch_tx,
            interval_tx,
        }
    }

    pub fn subscribe(&self) -> watch::Receiver<Option<TelemetrySnapshot>> {
        self.watch_tx.subscribe()
    }

    pub fn client_count(&self) -> usize {
        self.watch_tx.receiver_count()
    }

    pub fn request_broadcast(&self, snapshot: TelemetrySnapshot) {
        // UDP can arrive faster or out of phase with the WebSocket cap. Requests
        // only replace the pending latest snapshot; old frames are intentionally dropped.
        self.request_tx.send_replace(Some(snapshot));
    }

    pub fn set_broadcast_hz(&self, broadcast_hz: f64) {
        let interval = Duration::from_secs_f64(1.0 / broadcast_hz);
        self.interval_tx.send_replace(interval);
    }
}

async fn run_broadcast_loop(
    mut request_rx: watch::Receiver<Option<TelemetrySnapshot>>,
    watch_tx: watch::Sender<Option<TelemetrySnapshot>>,
    mut interval_rx: watch::Receiver<Duration>,
) {
    let mut interval = *interval_rx.borrow();
    let mut pending: Option<TelemetrySnapshot> = None;
    let mut last_sent = Instant::now() - interval;

    loop {
        if pending.is_none() {
            if request_rx.changed().await.is_err() {
                break;
            }
            pending = request_rx.borrow().clone();
        }

        let next_allowed = last_sent + interval;
        if Instant::now() >= next_allowed {
            if let Some(snapshot) = pending.take() {
                watch_tx.send_replace(Some(snapshot));
                last_sent = Instant::now();
            }
            continue;
        }

        select! {
            changed = interval_rx.changed() => {
                if changed.is_err() {
                    break;
                }
                interval = *interval_rx.borrow();
                last_sent = Instant::now() - interval;
            }
            changed = request_rx.changed() => {
                if changed.is_err() {
                    break;
                }
                pending = request_rx.borrow().clone();
            }
            _ = sleep_until(next_allowed) => {
                if let Some(snapshot) = pending.take() {
                    watch_tx.send_replace(Some(snapshot));
                    last_sent = Instant::now();
                }
            }
        }
    }
}
