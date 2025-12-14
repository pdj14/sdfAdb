# SDF ADB - ADB Remote Bridge (Node.js)

## 개요

이 문서는 로컬 PC에 ADB로 연결된 Android 단말을 원격 PC에서 접근할 수 있도록 하는 **SDF ADB** 서비스의 설계를 설명합니다.

### 기술 스택
- **Runtime**: Node.js 18+
- **ADB Library**: @devicefarmer/adbkit
- **WebSocket**: ws
- **Packaging**: @yao-pkg/pkg → 단일 exe 파일

### 핵심 특징
- **직접 연결 (P2P)**: 낮은 지연으로 ADB 트래픽 직접 전달
- **Relay 연결**: NAT/방화벽 환경에서 자동 우회
- **메시 구조**: 각 노드가 Provider + Controller 역할 동시 수행
- **동적 포트 할당**: 필요할 때만 포트 할당, 종료 시 자동 반환

---

## 아키텍처

### 전체 구조

```
┌─────────────────────────────────────────────────────────────────────────┐
│                           SDF ADB System                                │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                          │
│   [Android Device]                                    [Remote Client]    │
│         │                                                    │          │
│         │ USB/TCP                                           │          │
│         ▼                                                    │          │
│   ┌──────────┐        Direct P2P (if possible)         ┌──────────┐    │
│   │ Provider │ ◄──────────────────────────────────────► │Controller│    │
│   │  (Host)  │                                          │ (Remote) │    │
│   └────┬─────┘                                          └────┬─────┘    │
│        │                                                      │          │
│        │ If NAT/Firewall blocks                              │          │
│        ▼                                                      ▼          │
│   ┌────────────────────────────────────────────────────────────┐        │
│   │                      Relay Server                          │        │
│   └────────────────────────────────────────────────────────────┘        │
│                                                                          │
└─────────────────────────────────────────────────────────────────────────┘
```

### 메시(Mesh) 구조

```
                    ┌─────────────────────────────────────────────────┐
                    │                  Relay Server                   │
                    └─────────────────────────────────────────────────┘
                              ▲           ▲           ▲
                              │           │           │
    ┌─────────────┐    ┌─────────────┐         ┌─────────────┐    ┌─────────────┐
    │     A       │    │     B       │         │     C       │    │     D       │
    │ ──────────  │    │ ──────────  │         │ ──────────  │    │ ──────────  │
    │ Provider:   │    │ Controller: │         │ Controller: │    │ Provider:   │
    │  Dev1 → B   │───►│  Dev1 ✓    │         │  Dev3 ✓    │◄───│  Dev6 → A   │
    │  Dev2 → B   │───►│  Dev2 ✓    │         │             │    │             │
    │  Dev3 → C   │───────────────────────────►             │    │             │
    │  Dev4 (로컬) │    │             │         │             │    │             │
    │  Dev5 (로컬) │    │             │         │             │    │             │
    │ ──────────  │    │             │         │             │    │             │
    │ Controller: │    │             │         │             │    │             │
    │  ← D/Dev6  │◄────────────────────────────────────────────────            │
    └─────────────┘    └─────────────┘         └─────────────┘    └─────────────┘
```

---

## 포트 할당 모델

> ⚠️ **ADB는 디바이스당 별도의 TCP 포트가 필요합니다.**

### 하이브리드 방식 (동적 포트 할당) ⭐ 추천

```
Controller PC                    Relay Server                     Provider PC
                                                                   
1. WebSocket으로 연결 요청 ─────► Port 21120 (시그널링)
                                      │
2. 동적 포트 할당 ◄─────────────────┘
   "use port 30001"
                                      
3. adb connect relay:30001 ────► Port 30001 ◄────── TCP Bridge ◄── Device
                                 (연결 종료 시 반환)
```

---

## 사용자 사용법 (User Guide)

### 1. 설치

```bash
# 방법 1: npm 글로벌 설치
npm install -g sdfadb

# 방법 2: 단일 exe 다운로드 (Windows)
# sdfadb.exe 다운로드 후 PATH에 추가
```

### 2. Relay 서버 시작 (선택사항)

```bash
# 중앙 Relay 서버 (NAT 우회용)
sdfadb relay --port 21120

# 출력:
# ✓ Relay server started on port 21120
# ✓ Signal server: ws://0.0.0.0:21120
# ✓ Port pool: 30001-30999
```

### 3. Provider: 디바이스 공유

```bash
# 내 PC의 ADB 디바이스를 공유
sdfadb provide --relay relay.mycompany.com:21120

# 출력:
# ✓ Connected to relay server
# ✓ Provider ID: PROVIDER_ABC123
# 
# Local Devices:
#   ✓ PIXEL001 (Pixel 6 Pro) - online
#   ✓ GALAXY01 (Galaxy S23) - online
#   ✓ ONEPLUS1 (OnePlus 11) - online
#
# Waiting for connections... (Ctrl+C to stop)
```

#### 선택적 공유 (특정 디바이스만)

```bash
# 특정 디바이스만 공유
sdfadb provide --relay relay.mycompany.com:21120 \
    --device PIXEL001 --device GALAXY01

# 특정 사용자에게만 공유
sdfadb provide --relay relay.mycompany.com:21120 \
    --allow-user USER_XYZ789
```

### 4. Controller: 원격 디바이스 사용

```bash
# Step 1: 사용 가능한 디바이스 목록 확인
sdfadb list --relay relay.mycompany.com:21120

# 출력:
# Available Devices:
# ┌────────────────┬────────────┬──────────────┬────────┐
# │ Provider       │ Device     │ Model        │ Status │
# ├────────────────┼────────────┼──────────────┼────────┤
# │ PROVIDER_ABC   │ PIXEL001   │ Pixel 6 Pro  │ online │
# │ PROVIDER_ABC   │ GALAXY01   │ Galaxy S23   │ online │
# │ PROVIDER_XYZ   │ XIAOMI01   │ Mi 13        │ online │
# └────────────────┴────────────┴──────────────┴────────┘

# Step 2: 디바이스에 연결 (로컬 포트 5555에 마운트)
sdfadb connect --relay relay.mycompany.com:21120 \
    --provider PROVIDER_ABC --device PIXEL001 --port 5555

# 출력:
# ✓ Connected to PIXEL001 via relay
# ✓ Local port: localhost:5555
# 
# You can now use:
#   adb connect localhost:5555
#   adb -s localhost:5555 shell

# Step 3: 일반 ADB 명령 사용
adb connect localhost:5555
adb -s localhost:5555 shell
adb -s localhost:5555 install app.apk
```

### 5. 하이브리드 모드 (Provider + Controller 동시)

```bash
# 내 디바이스 공유하면서 + 다른 디바이스 받아오기
sdfadb node --relay relay.mycompany.com:21120 \
    --share PIXEL001 --share GALAXY01 \
    --mount PROVIDER_XYZ:XIAOMI01:5555

# 출력:
# ✓ Node ID: NODE_MYPC_001
#
# Providing (2 devices):
#   ✓ PIXEL001 → shared to all
#   ✓ GALAXY01 → shared to all
#
# Mounting (1 device):
#   ✓ XIAOMI01 ← from PROVIDER_XYZ → localhost:5555
```

### 6. 연결 해제

```bash
# 특정 디바이스 연결 해제
sdfadb disconnect --port 5555

# 모든 연결 해제
sdfadb disconnect --all
```

---

## 설정 파일 (선택사항)

`~/.sdfadb/config.yaml`:

```yaml
relay:
  server: relay.mycompany.com:21120
  
provider:
  auto_share: true
  allowed_users:
    - USER_ALICE
    - USER_BOB
  
mounts:
  - provider: PROVIDER_FARM
    device: PIXEL001
    local_port: 5555
  - provider: PROVIDER_FARM
    device: GALAXY01
    local_port: 5556
```

```bash
# 설정 파일 기반 자동 시작
sdfadb start
```

---

## 프로젝트 구조

```
sdfadb/
├── src/
│   ├── index.js           # 메인 엔트리포인트
│   ├── cli.js             # CLI 명령어 처리
│   ├── provider.js        # Provider (디바이스 공유)
│   ├── controller.js      # Controller (원격 연결)
│   ├── relay/
│   │   ├── server.js      # Relay 서버
│   │   ├── signal.js      # 시그널링 (WebSocket)
│   │   └── portPool.js    # 동적 포트 관리
│   ├── adb/
│   │   ├── client.js      # adbkit 래퍼
│   │   └── tunnel.js      # TCP 터널링
│   └── utils/
│       ├── config.js      # 설정 관리
│       └── logger.js      # 로깅
├── bin/
│   └── sdfadb.js          # CLI 바이너리 엔트리
├── package.json
├── README.md
└── docs/
    └── design.md          # 이 문서
```

---

## 빌드 및 배포

### 개발 모드

```bash
npm install
npm run dev
```

### exe 빌드 (Windows)

```bash
npm run build:win
# → dist/sdfadb-win.exe
```

### 크로스 플랫폼 빌드

```bash
npm run build:all
# → dist/sdfadb-win.exe
# → dist/sdfadb-linux
# → dist/sdfadb-macos
```

---

## 보안

1. **인증**: Provider-Controller 간 토큰 기반 인증
2. **암호화**: TLS/WSS 전송 암호화
3. **접근제어**: 사용자별 디바이스 접근 권한
4. **감사로그**: 연결/명령 로깅

---

## 참고 자료

- [adbkit](https://github.com/DeviceFarmer/adbkit) - Node.js ADB client
- [@yao-pkg/pkg](https://github.com/yao-pkg/pkg) - Node.js exe packager
