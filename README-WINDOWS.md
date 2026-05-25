# Sim Telemetry Server Windows Release

Windows x64용 Forza Horizon 6 Data Out 텔레메트리 서버입니다. Rust 서버가 UDP 패킷을 수신하고, 같은 프로세스에서 HTTP/WebSocket API와 React 대시보드 정적 파일을 제공합니다.

## 빠른 실행

1. release zip을 압축 해제합니다.
2. `sim-telemetry-server.exe`를 더블클릭하거나 PowerShell에서 실행합니다.
3. 콘솔에 표시되는 URL을 엽니다.

```powershell
.\sim-telemetry-server.exe
```

대시보드를 바로 열고 싶으면:

```powershell
.\sim-telemetry-server.exe --open-dashboard
```

설정 화면을 바로 열고 싶으면:

```powershell
.\sim-telemetry-server.exe --open-settings
```

## 기본 URL

- Local Dashboard: `http://localhost:3000/dashboard`
- Local Settings: `http://localhost:3000/settings`
- Tablet/Phone/Notebook: `http://PC_LOCAL_IP:3000/dashboard`

PC의 로컬 IP는 PowerShell에서 확인할 수 있습니다.

```powershell
ipconfig
```

사용 중인 어댑터의 `IPv4 Address` 값을 찾습니다. 예를 들어 PC가 `192.168.0.12`라면 태블릿에서는 다음 주소를 엽니다.

```text
http://192.168.0.12:3000/dashboard
```

## Settings 화면

`/settings`에서 다음 값을 브라우저로 변경할 수 있습니다.

- Game Adapter
- UDP Host / UDP Port
- HTTP Host / HTTP Port
- Broadcast Hz
- Connection Timeout ms
- Mock Telemetry
- Debug Packet

저장하면 `config.json`이 exe 실행 폴더에 생성되거나 갱신됩니다. 설정 우선순위는 다음 순서입니다.

1. `config.json`
2. 환경 변수 또는 `.env`
3. 내장 기본값

Broadcast Hz와 Connection Timeout은 저장 즉시 적용됩니다. UDP Host, UDP Port, Mock Telemetry, Debug Packet, Game Adapter 변경은 Settings 화면에서 Telemetry Restart를 눌러 적용합니다. HTTP Host 또는 HTTP Port 변경은 앱 프로세스 재시작이 필요합니다.

## Forza Horizon 6 설정 예시

Forza와 서버가 같은 PC에서 실행되는 일반적인 경우:

```text
Data Out: On
Data Out IP Address: 127.0.0.1
Data Out IP Port: 5400
```

서버가 별도 PC, VM, Ubuntu 머신에서 실행되는 경우:

```text
Data Out: On
Data Out IP Address: 서버 머신의 로컬 IP
Data Out IP Port: 5400
```

주의:

- FH6 공식 문서에 따르면 5200-5300 UDP 포트 범위는 피하는 것이 좋습니다.
- 이 프로젝트의 기본 UDP 포트는 `5400`입니다.
- 포트 충돌이 있으면 Settings 화면 또는 `config.json`에서 UDP Port를 변경할 수 있습니다.

## Windows Defender Firewall

최초 실행 시 Windows Defender Firewall 허용 팝업이 뜰 수 있습니다.

- 같은 집/학교/개인 공유기 네트워크에서 태블릿 접속이 필요하면 `Private networks`를 허용합니다.
- `Public networks`는 보안상 굳이 허용하지 않는 것을 권장합니다.
- HTTP Port, 기본 `3000`이 방화벽에서 차단되면 태블릿/스마트폰 접속이 되지 않습니다.
- Forza와 서버가 같은 PC에서 실행되면 UDP Port는 외부 방화벽 허용이 필수는 아닙니다.
- 서버가 별도 PC 또는 VM에서 실행되면 Forza가 UDP를 보낼 수 있도록 UDP Port도 허용해야 합니다.

이 서버는 외부 인터넷 공개용으로 설계되지 않았습니다. 로컬 네트워크 안에서 사용하는 것을 전제로 합니다.

## config.example.json

배포 폴더에는 예시 파일 `config.example.json`이 포함됩니다. 직접 파일로 설정하고 싶다면 이 파일을 `config.json`으로 복사해 수정할 수 있습니다.

```json
{
  "gameAdapter": "forza-horizon-6",
  "httpHost": "0.0.0.0",
  "httpPort": 3000,
  "udpHost": "0.0.0.0",
  "udpPort": 5400,
  "broadcastHz": 60,
  "connectionTimeoutMs": 2000,
  "mockTelemetry": false,
  "debugPacket": false
}
```

## 개발자용 빌드

Node.js, npm, Rust, Cargo가 설치된 개발 환경에서는 루트에서 다음 명령을 사용할 수 있습니다.

```powershell
npm.cmd install
npm.cmd run build
npm.cmd run package:windows
```

직접 PowerShell 스크립트를 실행할 수도 있습니다.

```powershell
powershell -ExecutionPolicy Bypass -File scripts\package-windows.ps1
```

결과물:

```text
release/
  sim-telemetry-server-windows-x64/
    sim-telemetry-server.exe
    config.example.json
    README-WINDOWS.md
    static/
  sim-telemetry-server-windows-x64.zip
```

## API 요약

- `GET /api/status`: 앱, 런타임, 포트, URL, 연결 상태, 패킷 카운트 조회
- `GET /api/telemetry`: 최신 텔레메트리 snapshot 조회
- `GET /api/config`: 현재 설정 조회
- `PUT /api/config`: 설정 저장
- `POST /api/runtime/start`: UDP/WebSocket telemetry runtime 시작
- `POST /api/runtime/stop`: telemetry runtime 중지
- `POST /api/runtime/restart`: 저장된 설정으로 telemetry runtime 재시작
- `GET /ws/telemetry`: 실시간 WebSocket 스트림
