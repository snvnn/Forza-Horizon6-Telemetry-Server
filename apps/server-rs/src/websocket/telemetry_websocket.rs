use axum::{
    extract::{
        ws::{Message, WebSocket, WebSocketUpgrade},
        State,
    },
    response::Response,
};
use tokio::sync::watch;

use crate::{
    http::create_http_server::AppState,
    telemetry::{
        telemetry_store::TelemetryStore,
        telemetry_types::{TelemetryMessage, TelemetrySnapshot},
    },
};

pub async fn telemetry_websocket(ws: WebSocketUpgrade, State(state): State<AppState>) -> Response {
    let store = state.store.clone();
    let receiver = state.broadcaster.subscribe();

    ws.on_upgrade(move |socket| handle_socket(socket, store, receiver))
}

async fn handle_socket(
    mut socket: WebSocket,
    store: TelemetryStore,
    mut receiver: watch::Receiver<Option<TelemetrySnapshot>>,
) {
    if let Some(snapshot) = store.get_latest().await {
        if send_snapshot(&mut socket, snapshot).await.is_err() {
            return;
        }
    }

    while receiver.changed().await.is_ok() {
        let snapshot = receiver.borrow().clone();
        if let Some(snapshot) = snapshot {
            if send_snapshot(&mut socket, snapshot).await.is_err() {
                break;
            }
        }
    }
}

async fn send_snapshot(
    socket: &mut WebSocket,
    snapshot: TelemetrySnapshot,
) -> Result<(), axum::Error> {
    let payload = serde_json::to_string(&TelemetryMessage {
        message_type: "telemetry",
        snapshot,
    })
    .map_err(axum::Error::new)?;

    socket.send(Message::Text(payload.into())).await
}
