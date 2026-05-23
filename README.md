# Forza Telemetry Web

Windows 10 Pro 22H2에서 Forza Horizon Data Out UDP 텔레메트리를 받아 같은 로컬 네트워크의 태블릿, 노트북, 스마트폰 브라우저로 실시간 대시보드를 보는 MVP입니다.

구조는 다음 흐름을 따릅니다.

```text
Forza Horizon
  -> UDP Data Out
  -> Windows PC Node.js telemetry server
  -> UDP packet parser
  -> in-memory latest telemetry store
  -> WebSocket broadcaster
  -> tablet browser dashboard
```

DB 저장과 파일 export는 없습니다. 서버는 최신 텔레메트리 snapshot만 메모리에 보관합니다.

## 요구 환경

- Windows 10 Pro 22H2
- Node.js 20 이상
- npm

## 설치

```powershell
npm install
copy .env.example .env
```

PowerShell에서 `npm.ps1` 실행 정책 오류가 나면 다음 둘 중 하나를 사용합니다.

```powershell
npm.cmd install
npm.cmd run dev
```

또는 사용자 범위에서 PowerShell 실행 정책을 허용합니다.

```powershell
Set-ExecutionPolicy -Scope CurrentUser -ExecutionPolicy RemoteSigned -Force
```

이 프로젝트는 `.npmrc`에서 npm cache를 프로젝트 내부 `.npm-cache`로 지정합니다. 제한된 Windows 환경이나 Codex 작업 폴더에서도 npm이 사용자 `AppData` cache 권한 문제로 실패하지 않게 하기 위한 설정입니다.

## 실행 환경 검증

의존성 설치 전에도 Node.js, npm, npm cache, HTTP/UDP 포트, LAN IPv4, npm registry 접근을 확인할 수 있습니다.

```powershell
npm.cmd run validate:env
```

정상 예시는 다음 항목들이 `PASS`로 표시됩니다.

- Node.js
- npm
- npm cache
- HTTP port bind: `0.0.0.0:3000`
- UDP port bind: `0.0.0.0:5300`
- LAN IPv4

Codex 샌드박스처럼 외부 네트워크가 막힌 환경에서는 `npm registry`가 `WARN`으로 표시될 수 있습니다. 일반 PowerShell에서 이 항목이 실패하면 방화벽, 프록시, VPN, 보안 프로그램의 npm registry 접속 차단을 확인합니다.

## 개발 실행

```powershell
npm run dev
```

개발 모드는 서버와 Vite 대시보드를 함께 실행합니다.

- 서버 API/WebSocket: `http://localhost:3000`
- Vite 대시보드: `http://localhost:5173`

Vite 개발 서버는 `/api`와 `/ws`를 `localhost:3000`으로 proxy합니다. 그래서 브라우저 코드는 현재 접속 host 기준으로 `ws://<host>/ws/telemetry`를 만들고도 개발/운영에서 같은 방식으로 동작합니다.

## 운영 빌드 실행

```powershell
npm run build
npm start
```

빌드 후 서버가 대시보드 정적 파일도 함께 제공합니다.

- PC에서 확인: `http://localhost:3000`
- 태블릿에서 접속: `http://192.168.0.x:3000`

## Mock telemetry로 먼저 확인

실제 Forza 패킷 없이 UI와 WebSocket을 테스트하려면 `.env`를 다음처럼 설정합니다.

```env
MOCK_TELEMETRY=true
```

그 후 실행합니다.

```powershell
npm run dev
```

## 환경 변수

```env
UDP_PORT=5300
HTTP_PORT=3000
HOST=0.0.0.0
TELEMETRY_BROADCAST_HZ=60
MOCK_TELEMETRY=false
DEBUG_PACKET=false
CONNECTION_TIMEOUT_MS=2000

VITE_RENDER_HZ=60
```

`TELEMETRY_BROADCAST_HZ`는 서버가 WebSocket으로 최신 snapshot을 보내는 빈도입니다. 값이 없거나 숫자가 아니거나 1보다 작거나 120보다 크면 60Hz로 fallback합니다.

`VITE_RENDER_HZ`는 React state update 빈도입니다. WebSocket 메시지를 받을 때마다 React `setState`를 호출하지 않고, 최신값만 저장한 뒤 이 값 기준으로 화면을 갱신합니다. 값이 없거나 숫자가 아니거나 1보다 작거나 120보다 크면 60Hz로 fallback합니다.

성능 문제가 있으면 다음처럼 낮출 수 있습니다.

```env
TELEMETRY_BROADCAST_HZ=30
VITE_RENDER_HZ=30
```

기준 간격은 다음과 같습니다.

- 60Hz: 약 16.67ms
- 30Hz: 약 33.33ms
- 20Hz: 50ms

## Forza 설정 예시

Forza Horizon 설정에서 Data Out을 켭니다.

- Data Out: On
- IP Address: `127.0.0.1`
- Port: `5300`

Forza와 서버가 같은 PC에서 실행되는 구조이므로 Forza의 IP Address는 `127.0.0.1`을 사용합니다. 서버는 `0.0.0.0`에 바인딩되어 태블릿 브라우저 접속도 받습니다.

## 태블릿 접속 방법

1. PC와 태블릿을 같은 Wi-Fi 또는 같은 유선/무선 LAN에 연결합니다.
2. PC에서 PowerShell을 열고 실행합니다.

```powershell
ipconfig
```

3. 사용 중인 네트워크 어댑터의 `IPv4 Address`를 찾습니다. 예: `192.168.0.25`
4. 태블릿 브라우저에서 접속합니다.

```text
http://192.168.0.25:3000
```

개발 모드의 Vite 화면을 태블릿에서 직접 보고 싶으면 다음 주소를 사용할 수 있습니다.

```text
http://192.168.0.25:5173
```

## Windows 방화벽 주의사항

처음 실행할 때 Windows Defender 방화벽이 Node.js 접근 허용을 물을 수 있습니다. 같은 로컬 네트워크의 태블릿에서 접속하려면 개인 네트워크에서 Node.js의 inbound 접근을 허용해야 합니다.

수동으로 확인하려면:

1. Windows 보안
2. 방화벽 및 네트워크 보호
3. 방화벽에서 앱 허용
4. Node.js 또는 현재 사용하는 Node 실행 파일이 개인 네트워크에서 허용되어 있는지 확인

HTTP 포트는 기본 `3000`, UDP 포트는 기본 `5300`입니다.

## API

### GET /api/status

서버 상태를 확인합니다. 응답에는 현재 WebSocket broadcast 설정도 포함됩니다.

```json
{
  "ok": true,
  "connected": true,
  "hasTelemetry": true,
  "broadcastHz": 60,
  "broadcastIntervalMs": 16.666666666666668,
  "mockTelemetry": false
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
      "maxRpm": 7500,
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

경로는 다음과 같습니다.

```text
/ws/telemetry
```

브라우저는 현재 접속 host를 기준으로 주소를 자동 생성합니다.

```ts
ws://${window.location.host}/ws/telemetry
```

HTTPS 환경에서는 자동으로 `wss://`를 사용합니다.

## Parser 설계 메모

서버의 Forza parser는 offset map 기반입니다. 현재 MVP는 일반적인 Forza Dash Data Out packet offset을 기준으로 다음 값을 정규화합니다.

- speed m/s -> km/h
- current RPM, max RPM
- gear
- throttle, brake, clutch, handbrake
- steer
- power W -> kW
- torque Nm
- boost
- tire temperatures
- acceleration X/Y/Z

Forza Horizon 6 또는 다른 Forza 타이틀에서 packet layout이 바뀌면 `apps/server/src/parser/forzaPacketParser.ts`의 offset map만 교체하거나 parser class를 새로 추가하면 됩니다.

`DEBUG_PACKET=true`를 설정하면 packet length와 주요 필드 일부를 로그로 확인할 수 있습니다. 파싱 실패는 try/catch로 처리되어 서버 프로세스가 죽지 않고 에러 로그만 남깁니다.

## 성능 구조

데이터 흐름은 다음처럼 분리되어 있습니다.

```text
Forza UDP 60Hz
  -> server latest state update 60Hz
  -> WebSocket broadcast TELEMETRY_BROADCAST_HZ
  -> browser latest reference update
  -> React render VITE_RENDER_HZ
```

UDP 수신은 들어오는 즉시 처리하고, WebSocket 송출과 React 렌더링은 각각 별도의 환경 변수로 throttling합니다.
