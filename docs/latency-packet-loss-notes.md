# Latency and Packet Loss Notes

This document tracks the current Rust server data path, the measurements that
matter for packet loss and latency, and the operational knobs that should be
changed first when the dashboard feels delayed.

## Current Data Path

```text
Forza Horizon 6 UDP
  -> Tokio UDP receiver
  -> FH6 packet parser
  -> latest-only telemetry store
  -> throttled broadcaster
  -> WebSocket clients
  -> browser latest ref
  -> React render throttle
```

## Implemented Low-Latency Choices

- UDP receive is not tied to WebSocket send speed. Every valid UDP packet updates
  the latest in-memory snapshot immediately.
- The store is latest-only. There is no database, file export, or history queue
  on the hot path.
- WebSocket broadcast is capped by `TELEMETRY_BROADCAST_HZ`, default `60`.
  `0` enables uncapped mode, which publishes on every UDP update request. Values
  from `1` to `240` cap the publish rate in Hz. When UDP arrives faster than the
  cap, old pending snapshots are intentionally coalesced and only the newest
  snapshot is published.
- Browser WebSocket messages update a latest ref only. React state is copied from
  that ref at `dashboardRenderHz` from `/api/config` so message receive rate and
  UI render rate remain separate. `VITE_RENDER_HZ` is only the build/env fallback.
- `DEBUG_PACKET=false` uses a parser fast path that skips candidate maps and raw
  value capture for normal driving.
- `/api/status.lastPacket` metadata is sampled every 250ms on successful packets.
  Parse errors still update status immediately.
- JSON compatible mode serializes JSON once per broadcast frame, then shares the
  frame by all clients. Binary low latency mode sends `/ws/telemetry.bin` with a
  fixed 80-byte normalized frame and cheap binary payload clone per client.
- Slow WebSocket sends time out after `websocketSendTimeoutMs`, default 50ms.
  The browser reconnects and resumes from the latest state.
- Windows requests a 1ms multimedia timer period while the server process runs.
- UDP receive buffer defaults to 1 MiB and can be adjusted with
  `udpReceiveBufferBytes` / `UDP_RECEIVE_BUFFER_BYTES`.

## Status Fields To Watch

`/api/status` exposes the primary runtime diagnostics:

- `estimatedPacketHz`: estimated UDP packet receive rate.
- `lastPacketAgeMs`: age of the last received UDP packet.
- `maxPacketGapMs`: largest observed interval between UDP packets.
- `packetGapCount`: number of intervals at or above `packetGapWarningMs`.
- `packetGapHistogram`: cumulative distribution of all observed UDP packet
  intervals, bucketed by `<=8`, `<=16`, `<=33`, `<=50`, `<=100`, `<=250`,
  and `>250` ms.
- `recentPacketGaps`: the most recent warning-level UDP gaps. Only gaps at or
  above `packetGapWarningMs` are stored, and only the latest 16 are retained.
- `broadcastStats.estimatedBroadcastHz`: actual server publish rate.
- `broadcastStats.broadcastRequestCount`: number of latest snapshot publish
  requests received from the UDP path.
- `broadcastStats.broadcastCount`: number of WebSocket frames published.
- `broadcastStats.coalescedBroadcastRequests`: publish requests intentionally
  merged before broadcast because UDP was faster than the configured cap.
- `broadcastStats.lastSnapshotAgeMsAtBroadcast`: server-side age of the snapshot
  at publish time.
- `broadcastStats.maxSnapshotAgeMsAtBroadcast`: worst observed snapshot age at
  publish time.
- `broadcastStats.websocketSendTimeouts`: clients that were too slow to send to.
- `broadcastStats.maxWebsocketSendMs`: worst observed send duration.
- `transportMode`: `json` uses `/ws/telemetry`; `binary` uses
  `/ws/telemetry.bin`.
- `dashboardRenderHz`: React render/copy cap used by the browser dashboard.
- `websocketSendTimeoutMs`: configured per-frame send timeout for slow clients.

Interpretation:

- High `coalescedBroadcastRequests` is expected when UDP rate is higher than
  `TELEMETRY_BROADCAST_HZ`. This is not UDP packet loss; it is intentional
  latest-only coalescing.
- `lastSnapshotAgeMsAtBroadcast` should usually stay near 0-2ms. If it grows
  while UDP packets are still arriving, the broadcaster is not keeping up.
- `packetGapCount > 0` means UDP arrival gaps exceeded the current warning
  threshold. This can indicate CPU stalls, OS scheduling delays, or UDP drops
  before the app receives the packet.
- If `packetGapHistogram` has most packets in `<=16ms` but occasional entries
  in `<=100ms`, the server is usually keeping up but the sender or OS scheduler
  is occasionally late.
- If `recentPacketGaps` shows clustered large gaps while CPU/GPU load is high,
  try reducing render/broadcast rates before changing parser logic.
- If `estimatedPacketHz` is stable and `packetGapCount` stays at 0, but the UI
  feels delayed, look at browser `RX`, `Age`, and `UI` metrics first.

## Runtime Evidence

Sample from the current live FH6 session after the latest changes:

```text
UDP listen:             0.0.0.0:5400
HTTP listen:            0.0.0.0:3000
UDP receive buffer:     1048576 bytes
estimated UDP rate:     about 110-115 Hz
actual broadcast rate:  about 59-62 Hz
snapshot age at send:   0-1 ms
packet gap count:       0
WebSocket clients:      1
WebSocket timeouts:     0
```

This shows the server is currently receiving faster than it broadcasts, while
the latest snapshot reaches the broadcast stage with very low server-side age.

## Repeatable Local Diagnostics

Use the latency diagnostic script while the Rust server is already running:

```powershell
npm.cmd run diagnose:latency
```

Useful options:

```powershell
npm.cmd run diagnose:latency -- --seconds 30 --interval-ms 500
npm.cmd run diagnose:latency -- --url http://127.0.0.1:3000/api/status --json
```

The script samples `/api/status`, computes deltas for UDP packets, broadcast
frames, coalesced requests, WebSocket send failures, and packet gap histogram
buckets, then prints recommendations.

## Operational Recommendations

- Keep `DEBUG_PACKET=false` for normal driving.
- If the dashboard device is weak, lower Dashboard Render Hz in Settings first.
- If Wi-Fi or tablet browser load is weak, lower Broadcast Hz or switch
  Transport Mode to Binary low latency.
- If `packetGapCount` increases or `maxPacketGapMs` often exceeds 50ms, raise
  `udpReceiveBufferBytes` to 2-4 MiB and retest.
- If `estimatedBroadcastHz` stays below configured `broadcastHz`, inspect
  `websocketSendTimeouts`, `maxWebsocketSendMs`, and connected client count.
- If `lastSnapshotAgeMsAtBroadcast` grows while UDP rate is healthy, the server
  broadcaster or JSON/send path is the next bottleneck to optimize.

## Remaining Candidates

- Optional `/ws/raw` diagnostic stream if raw Forza packet passthrough is ever
  needed for parser research.
- App-level WebSocket RTT ping if tablet network latency needs to be measured
  independently from server-side snapshot age.
- A repeatable local stress harness with synthetic UDP input and N WebSocket
  clients to compare settings across machines.
