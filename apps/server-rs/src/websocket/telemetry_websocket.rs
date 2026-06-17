use axum::{
    extract::{
        ws::{Message, WebSocket, WebSocketUpgrade},
        State,
    },
    response::Response,
};
use tokio::{
    sync::watch,
    time::{timeout, Instant},
};

use crate::{
    http::create_http_server::AppState,
    telemetry::{
        telemetry_broadcaster::{TelemetryBroadcastFrame, TelemetryBroadcaster},
        telemetry_store::TelemetryStore,
        telemetry_types::TelemetrySnapshot,
    },
};

#[derive(Clone, Copy)]
enum TelemetryWebSocketFormat {
    Json,
    Binary,
}

pub async fn telemetry_websocket(ws: WebSocketUpgrade, State(state): State<AppState>) -> Response {
    telemetry_websocket_with_format(ws, state, TelemetryWebSocketFormat::Json)
}

pub async fn telemetry_binary_websocket(
    ws: WebSocketUpgrade,
    State(state): State<AppState>,
) -> Response {
    telemetry_websocket_with_format(ws, state, TelemetryWebSocketFormat::Binary)
}

fn telemetry_websocket_with_format(
    ws: WebSocketUpgrade,
    state: AppState,
    format: TelemetryWebSocketFormat,
) -> Response {
    let store = state.store.clone();
    let broadcaster = state.broadcaster.clone();
    let receiver = state.broadcaster.subscribe();

    ws.on_upgrade(move |socket| handle_socket(socket, store, broadcaster, receiver, format))
}

async fn handle_socket(
    mut socket: WebSocket,
    store: TelemetryStore,
    broadcaster: TelemetryBroadcaster,
    mut receiver: watch::Receiver<Option<TelemetryBroadcastFrame>>,
    format: TelemetryWebSocketFormat,
) {
    if let Some(snapshot) = store.get_latest().await {
        if send_snapshot(&mut socket, &broadcaster, snapshot, format)
            .await
            .is_err()
        {
            return;
        }
    }

    while receiver.changed().await.is_ok() {
        let frame = receiver.borrow().clone();
        if let Some(frame) = frame {
            if send_frame(&mut socket, &broadcaster, &frame, format)
                .await
                .is_err()
            {
                break;
            }
        }
    }
}

async fn send_snapshot(
    socket: &mut WebSocket,
    broadcaster: &TelemetryBroadcaster,
    snapshot: TelemetrySnapshot,
    format: TelemetryWebSocketFormat,
) -> Result<(), axum::Error> {
    let frame = TelemetryBroadcastFrame::from_snapshot(snapshot, 0).map_err(axum::Error::new)?;
    send_frame(socket, broadcaster, &frame, format).await
}

async fn send_frame(
    socket: &mut WebSocket,
    broadcaster: &TelemetryBroadcaster,
    frame: &TelemetryBroadcastFrame,
    format: TelemetryWebSocketFormat,
) -> Result<(), axum::Error> {
    // Slow or suspended tablet browsers should not keep a server task stuck on
    // an old frame. The client auto-reconnects and resumes with the latest state.
    let started = Instant::now();
    let message = match format {
        TelemetryWebSocketFormat::Json => {
            Message::Text(frame.text_payload.as_ref().to_owned().into())
        }
        TelemetryWebSocketFormat::Binary => Message::Binary(frame.binary_payload.clone()),
    };
    match timeout(broadcaster.websocket_send_timeout(), socket.send(message)).await {
        Ok(Ok(())) => {
            broadcaster.record_websocket_send_success(started.elapsed());
            Ok(())
        }
        Ok(Err(error)) => {
            broadcaster.record_websocket_send_error(started.elapsed());
            Err(error)
        }
        Err(error) => {
            broadcaster.record_websocket_send_timeout(started.elapsed());
            tracing::warn!(%error, "WebSocket telemetry send timed out");
            Err(axum::Error::new(error))
        }
    }
}
