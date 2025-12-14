# SDF ADB - ADB Remote Bridge

원격 PC에서 ADB 디바이스에 접근할 수 있도록 해주는 브릿지 서비스입니다.

## 특징

- 🔗 **Direct 연결 (P2P)**: 같은 네트워크에서 낮은 지연으로 직접 연결
- 🌐 **Relay 연결**: NAT/방화벽 환경에서 자동 우회
- 🔀 **메시 구조**: 각 노드가 Provider + Controller 역할 동시 수행
- 📦 **단일 exe**: pkg로 패키징된 단일 실행 파일

## 요구사항

- Node.js 18+
- ADB (Android Debug Bridge) 설치 및 PATH 등록

## 설치

```bash
# npm 설치
npm install -g sdfadb

# 또는 소스에서 실행
git clone <repo>
cd sdfadb
npm install
```

## 빠른 시작

### 방법 1: Direct 연결 (같은 네트워크)

```bash
# Provider PC (디바이스가 연결된 PC)
sdfadb provide --direct --port 21121

# Controller PC (원격에서 사용하려는 PC)
sdfadb connect --direct 192.168.1.100:21121 --device PIXEL001 --port 5555
adb connect localhost:5555
adb -s localhost:5555 shell
```

### 방법 2: Relay 연결 (NAT/방화벽)

```bash
# 1. Relay 서버 시작 (중앙 서버)
sdfadb relay --port 21120

# 2. Provider PC
sdfadb provide --relay myserver.com:21120

# 3. Controller PC
sdfadb list --relay myserver.com:21120
sdfadb connect --relay myserver.com:21120 --provider PROV_ABC123 --device PIXEL001 --port 5555
adb connect localhost:5555
```

## 명령어

| 명령 | 설명 |
|------|------|
| `relay` | Relay 서버 시작 |
| `provide --direct` | Direct 모드로 디바이스 공유 |
| `provide --relay` | Relay 모드로 디바이스 공유 |
| `list` | 사용 가능한 디바이스 목록 |
| `connect --direct` | Direct 연결 |
| `connect --relay` | Relay 연결 |
| `disconnect` | 연결 해제 |
| `node` | 하이브리드 모드 |

## exe 빌드

```bash
npm run build:win    # Windows exe
npm run build:linux  # Linux binary
npm run build:all    # 모든 플랫폼
```

## 문서

- [설계 문서](docs/design.md)

## 라이선스

MIT License
