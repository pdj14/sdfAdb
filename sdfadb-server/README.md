# SDF ADB Server

Ubuntu에서 동작하는 ADB Remote Bridge Relay 서버입니다.

## 특징

- 📡 WebSocket 시그널링 서버
- 🔀 동적 포트 할당 및 관리
- 🌉 Provider ↔ Client TCP 브릿지
- 📊 세션 및 상태 관리

## 요구사항

- Node.js 20+

## 설치

```bash
npm install
```

## 사용법

### 서버 시작

```bash
# 기본 설정으로 시작
sdfadb-server start

# 옵션 지정
sdfadb-server start --port 21120 --port-start 30001 --port-end 30999 --host 0.0.0.0
```

### 서버 상태 확인

```bash
sdfadb-server status --host localhost --port 21120
```

## 동작 흐름

```
┌─────────────┐          ┌─────────────────┐          ┌─────────────┐
│   Client    │          │  sdfadb-server  │          │  Provider   │
│ (Controller)│          │   (Relay)       │          │  (Host PC)  │
└──────┬──────┘          └────────┬────────┘          └──────┬──────┘
       │                          │                          │
       │  1. Request connect      │                          │
       │ ─────────────────────────>                          │
       │                          │                          │
       │  2. Allocate port 30001  │                          │
       │ <─────────────────────────                          │
       │                          │                          │
       │                          │  3. Request provider     │
       │                          │     connect to 30001     │
       │                          │ ─────────────────────────>
       │                          │                          │
       │                          │  4. Provider connects    │
       │                          │     to port 30001        │
       │                          │ <─────────────────────────
       │                          │                          │
       │  5. Client connects      │                          │
       │     to port 30001        │                          │
       │ ─────────────────────────>                          │
       │                          │                          │
       │  ◄═════════════ ADB Traffic Bridge ═════════════►   │
       │                          │                          │
```

## 포트 사용

| 포트 | 용도 |
|------|------|
| 21120 | WebSocket 시그널링 |
| 30001-30999 | ADB 릴레이 터널 (동적 할당) |

## API (WebSocket)

### Provider 등록
```json
{
  "type": "register_provider",
  "providerId": "PROV_ABC123",
  "devices": [
    {"serial": "PIXEL001", "model": "Pixel 6"}
  ]
}
```

### 디바이스 목록 조회
```json
{"type": "list_devices"}
```

### 포트 할당 요청
```json
{
  "type": "allocate_port",
  "sessionId": "session123",
  "providerId": "PROV_ABC123",
  "deviceSerial": "PIXEL001"
}
```

### 디바이스 연결 (통합)
```json
{
  "type": "connect_device",
  "controllerId": "CTRL_XYZ",
  "providerId": "PROV_ABC123",
  "deviceSerial": "PIXEL001"
}
```

## Linux 빌드

```bash
npm run build:linux
# → dist/sdfadb-server-linux
```

## systemd 서비스 등록

```ini
# /etc/systemd/system/sdfadb-server.service
[Unit]
Description=SDF ADB Relay Server
After=network.target

[Service]
Type=simple
ExecStart=/opt/sdfadb-server/sdfadb-server-linux start
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl enable sdfadb-server
sudo systemctl start sdfadb-server
```

## 라이선스

MIT License


## Relay 설정 템플릿

- 기본 템플릿: `config.relay.example.json`
- 실행 예시: `sdfadb-server start --config ./config.relay.example.json`
