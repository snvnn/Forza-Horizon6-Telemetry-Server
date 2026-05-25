# Forza Telemetry Web

Windows 10 Pro 22H2에서 Forza Horizon 6 Data Out UDP 패킷을 받아 같은 로컬 네트워크의 태블릿, 노트북, 스마트폰 브라우저로 실시간 대시보드를 보여주는 MVP입니다.

```text
Forza Horizon 6
  -> UDP Data Out
  -> Rust telemetry server
  -> FH6 packet parser
  -> in-memory latest telemetry store
  -> packet-driven WebSocket broadcaster
  -> React dashboard
```

DB 저장과 파일 export는 없습니다. 서버는 최신 telemetry snapshot 하나만 메모리에 유지합니다.

## 요구 환경

- Windows 10 Pro 22H2
- Node.js 20 이상
- npm
- Rust stable toolchain

Rust가 없다면 먼저 설치합니다.

```powershell
winget install Rustlang.Rustup
```

설치 후 새 PowerShell을 열고 확인합니다.

```powershell
rustc --version
cargo --version
```

PowerShell에서 `npm.ps1` 실행 정책 오류가 나면 `npm.cmd`를 사용합니다.

```powershell
npm.cmd install
```

또는 현재 사용자 범위에서 PowerShell 실행 정책을 허용합니다.

```powershell
Set-ExecutionPolicy -Scope CurrentUser -ExecutionPolicy RemoteSigned -Force
```

## 설치

```powershell
npm.cmd install
copy .env.example .env
```

프로젝트의 `.npmrc`는 npm cache를 프로젝트 내부 `.npm-cache`로 지정합니다. 제한된 Windows 환경에서 사용자 AppData cache 권한 문제를 피하기 위한 설정입니다.

## 실행 환경 검증

```powershell
npm.cmd run validate:env
```

확인 항목:

- Node.js
- npm
- Rust compiler
- Cargo
- HTTP bind: `0.0.0.0:3000`
- UDP bind: `0.0.0.0:5400`
- LAN IPv4
- npm registry 접근

Codex 샌드박스처럼 외부 네트워크가 막힌 환경에서는 `npm registry`가 `WARN`으로 표시될 수 있습니다.

## 개발 실행

```powershell
npm.cmd run dev
```

개발 모드는 Rust 서버와 Vite 대시보드를 함께 실행합니다.

- Rust API/WebSocket: `http://localhost:3000`
- Vite dashboard: `http://localhost:5173`

Vite는 `/api`와 `/ws`를 `localhost:3000`으로 proxy합니다.

## 빌드 후 실행

```powershell
npm.cmd run build
npm.cmd start
```

빌드 후에는 Rust 실행 파일이 React dashboard 정적 파일을 함께 제공합니다.

- PC 확인: `http://localhost:3000`
- 태블릿 접속: `http://192.168.0.x:3000`
- 실행 파일: `target\release\sim-telemetry-server.exe`

## Mock telemetry

실제 Forza 패킷 없이 UI와 WebSocket 경로를 확인하려면 `.env`에서 설정합니다.

```env
MOCK_TELEMETRY=true
```

그 다음 실행합니다.

```powershell
npm.cmd run dev
```

## 환경 변수

```env
UDP_PORT=5400
HTTP_PORT=3000
HOST=0.0.0.0
TELEMETRY_BROADCAST_HZ=60
MOCK_TELEMETRY=false
DEBUG_PACKET=false
CONNECTION_TIMEOUT_MS=2000

VITE_RENDER_HZ=60
```

`TELEMETRY_BROADCAST_HZ`는 서버가 WebSocket으로 보내는 최대 빈도입니다. 값이 없거나 숫자가 아니거나 1보다 작거나 120보다 크면 60Hz를 사용합니다.

`VITE_RENDER_HZ`는 React state update 빈도입니다. 브라우저는 WebSocket 메시지마다 `setState`를 호출하지 않고 최신값만 저장한 뒤, 이 값에 맞춰 화면에 반영합니다.

성능 문제가 있으면 다음처럼 낮춥니다.

```env
TELEMETRY_BROADCAST_HZ=30
VITE_RENDER_HZ=30
```

기준 간격:

- 60Hz: 약 16.67ms
- 30Hz: 약 33.33ms
- 20Hz: 50ms

## 저지연 구조

Rust 서버는 고정 interval로만 송출하지 않습니다.

```text
UDP packet 수신
  -> 즉시 parse
  -> latest store 갱신
  -> broadcaster.request_broadcast()
  -> TELEMETRY_BROADCAST_HZ 상한 내에서 WebSocket 송출
```

중간 frame queue를 쌓지 않고 최신 snapshot만 보냅니다. 느린 클라이언트가 있더라도 서버의 UDP 수신과 파싱 경로가 밀리지 않게 하기 위한 구조입니다.

브라우저도 WebSocket 수신과 React 렌더를 분리합니다.

```text
WebSocket message
  -> latest ref 갱신
  -> requestAnimationFrame loop
  -> VITE_RENDER_HZ 상한 내에서 React state update
```

## Forza Horizon 6 설정

Forza Horizon 6 설정에서 Data Out을 켭니다.

- Data Out: On
- IP Address: `127.0.0.1`
- Port: `5400`

Forza와 서버가 같은 PC에서 실행되므로 Forza의 IP Address는 `127.0.0.1`을 사용합니다. FH6 공식 문서에서 5200-5300 범위는 게임 자체 outgoing socket에 사용될 수 있으므로, 이 프로젝트의 기본 UDP 수신 포트는 `5400`입니다.

## 태블릿 접속 방법

1. PC와 태블릿을 같은 Wi-Fi 또는 같은 LAN에 연결합니다.
2. PC에서 PowerShell을 엽니다.
3. 다음 명령으로 IPv4 주소를 확인합니다.

```powershell
ipconfig
```

4. 사용 중인 네트워크 어댑터의 `IPv4 Address`를 찾습니다. 예: `192.168.0.25`
5. 태블릿 브라우저에서 접속합니다.

```text
http://192.168.0.25:3000
```

개발 모드에서 Vite 화면을 직접 보고 싶으면 다음 주소도 사용할 수 있습니다.

```text
http://192.168.0.25:5173
```

## Windows 방화벽 주의사항

처음 실행할 때 Windows Defender 방화벽이 Rust 실행 파일 또는 Node.js 접근 허용을 물을 수 있습니다.

태블릿에서 접속하려면 개인 네트워크에서 inbound 접근을 허용해야 합니다.

확인 위치:

1. Windows 보안
2. 방화벽 및 네트워크 보호
3. 방화벽에서 앱 허용
4. `sim-telemetry-server.exe` 또는 개발 중 사용하는 `cargo.exe`/`node.exe`가 개인 네트워크에서 허용되어 있는지 확인

기본 포트:

- HTTP/WebSocket: `3000`
- UDP Data Out: `5400`

## API

### GET /api/status

서버 상태와 현재 broadcast 설정을 확인합니다.

```json
{
  "ok": true,
  "connected": true,
  "hasTelemetry": true,
  "lastPacketAt": 1734567890000,
  "udpPort": 5400,
  "httpPort": 3000,
  "host": "0.0.0.0",
  "broadcastHz": 60,
  "broadcastIntervalMs": 16.666666666666668,
  "mockTelemetry": false,
  "connectionTimeoutMs": 2000
}
```

### GET /api/telemetry

최신 정규화 telemetry snapshot을 반환합니다.

```json
{
  "snapshot": {
    "timestamp": 1734567890000,
    "connected": true,
    "vehicle": {
      "speedKmh": 123.4,
      "rpm": 5321,
      "maxRpm": 8500,
      "gear": 4
    },
    "input": {
      "throttle": 0.82,
      "brake": 0,
      "steer": -0.12
    }
  }
}
```

## WebSocket

경로:

```text
/ws/telemetry
```

브라우저는 현재 접속 host를 기준으로 주소를 자동 생성합니다.

```ts
ws://${window.location.host}/ws/telemetry
```

HTTPS 환경에서는 자동으로 `wss://`를 사용합니다.

## Parser 메모

Rust 파서는 FH6 공식 Data Out 324-byte 포맷을 우선 사용합니다.

주요 offset:

- Speed: 256
- Power: 260
- Torque: 264
- Tire temperatures: 268, 272, 276, 280
- Boost: 284
- Accel: 315
- Brake: 316
- Clutch: 317
- HandBrake: 318
- Gear: 319
- Steer: 320

파서는 `apps/server-rs/src/parser/fh6_offsets.rs`에 offset map을 분리해 두었습니다. 나중에 Forza Horizon 5, Forza Horizon 6, Forza Motorsport 등으로 parser를 바꿀 때 이 영역을 중심으로 교체하면 됩니다.

`DEBUG_PACKET=true`를 설정하면 packet length, 선택된 profile, 주요 필드를 로그로 확인할 수 있습니다. 파싱 실패는 서버를 죽이지 않고 `/api/status`의 `lastPacket`과 로그에 기록됩니다.
