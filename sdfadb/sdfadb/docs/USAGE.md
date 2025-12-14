# SDF ADB 사용 가이드

## 개요

SDF ADB는 원격 PC에서 ADB 디바이스에 접근할 수 있도록 해주는 브릿지 서비스입니다.

---

## 연결 방식

| 방식 | 사용 환경 | 지연 | 설정 |
|------|----------|------|------|
| **Direct** | 같은 네트워크 | ~5-20ms | 간단 |
| **Relay** | NAT/방화벽 환경 | ~50-200ms | 서버 필요 |

---

## 방법 1: Direct 연결 (P2P)

같은 네트워크에 있을 때 Relay 서버 없이 직접 연결합니다.

### Provider (디바이스가 연결된 PC)

```bash
# Direct 모드로 시작
sdfadb-win.exe provide --direct --port 21121

# 출력 예시:
# ✓ Direct mode started
# ✓ Provider ID: PROV_ABC123
#
# Local Devices:
#   ✓ PIXEL001 (Pixel 6) - online
#   ✓ GALAXY01 (Galaxy S23) - online
#
# 📡 Direct Mode
#    Listening on: 0.0.0.0:21121
#
# Controller can connect with:
#    sdfadb connect --direct <your-ip>:21121 --device <serial> --port 5555
```

### Controller (원격에서 사용하려는 PC)

```bash
# Direct 연결
sdfadb-win.exe connect --direct 192.168.1.100:21121 --device PIXEL001 --port 5555

# 출력 예시:
# ✓ Connected via: Direct P2P
# ✓ Provider: 192.168.1.100:21121
# ✓ Device: Pixel 6
# ✓ Local port: localhost:5555
#
# You can now use:
#   adb connect localhost:5555
#   adb -s localhost:5555 shell
```

### ADB 사용

```bash
adb connect localhost:5555
adb -s localhost:5555 shell
adb -s localhost:5555 install app.apk
adb -s localhost:5555 logcat
```

---

## 방법 2: Relay 연결 (NAT/방화벽)

서로 다른 네트워크에 있거나 NAT 뒤에 있을 때 중앙 Relay 서버를 통해 연결합니다.

### 1. Relay 서버 시작 (Ubuntu)

```bash
# Linux 서버에서
./sdfadb-server-linux start --port 21120

# 출력 예시:
# 🚀 SDF ADB Server Started
#   Signal server: ws://0.0.0.0:21120
#   Port pool: 30001-30999
#   Waiting for connections...
```

### 2. Provider (디바이스가 연결된 PC)

```bash
sdfadb-win.exe provide --relay relay-server.com:21120

# 출력 예시:
# ✓ Connected to relay server
# ✓ Provider ID: PROV_ABC123
#
# Local Devices:
#   ✓ PIXEL001 (Pixel 6) - online
```

### 3. Controller (원격에서 사용하려는 PC)

```bash
# 디바이스 목록 확인
sdfadb-win.exe list --relay relay-server.com:21120

# 출력:
# Available Devices:
# ┌────────────────┬────────────┬──────────────┬────────┐
# │ Provider       │ Device     │ Model        │ Status │
# ├────────────────┼────────────┼──────────────┼────────┤
# │ PROV_ABC123    │ PIXEL001   │ Pixel 6      │ online │
# └────────────────┴────────────┴──────────────┴────────┘

# 연결
sdfadb-win.exe connect --relay relay-server.com:21120 \
    --provider PROV_ABC123 --device PIXEL001 --port 5555

# ADB 사용
adb connect localhost:5555
adb -s localhost:5555 shell
```

---

## 포트 사용 정리

| 포트 | 용도 | 필요 환경 |
|------|------|----------|
| 21120 | Relay 서버 WebSocket (시그널링) | Relay 모드 |
| 21121 | Provider Direct 모드 수신 | Direct 모드 |
| 30001-30999 | Relay 터널 (동적 할당) | Relay 모드 |
| 5555 (로컬) | Controller의 로컬 ADB 마운트 | 모든 모드 |

---

## 빠른 참조

### Direct 모드

```bash
# Provider
sdfadb-win.exe provide --direct --port 21121

# Controller
sdfadb-win.exe connect --direct <PROVIDER_IP>:21121 --device <SERIAL> --port 5555
```

### Relay 모드

```bash
# Server
./sdfadb-server-linux start --port 21120

# Provider  
sdfadb-win.exe provide --relay <SERVER>:21120

# Controller
sdfadb-win.exe list --relay <SERVER>:21120
sdfadb-win.exe connect --relay <SERVER>:21120 --provider <ID> --device <SERIAL> --port 5555
```

### ADB 사용

```bash
adb connect localhost:5555
adb -s localhost:5555 shell
adb -s localhost:5555 install app.apk
```

---

## 연결 해제

```bash
# Controller에서 Ctrl+C 또는
sdfadb-win.exe disconnect --port 5555
```

---

## 문제 해결

| 문제 | 해결 |
|------|------|
| "Device not found" | Provider에서 `adb devices`로 디바이스 확인 |
| 연결 타임아웃 | 방화벽에서 해당 포트 열기 |
| Direct 연결 실패 | 같은 네트워크인지 확인, IP 주소 확인 |
| Relay 연결 실패 | 서버 실행 중인지 확인, 포트 21120 열려있는지 확인 |
