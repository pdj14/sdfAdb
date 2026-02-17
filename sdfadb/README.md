# SDF ADB - ADB Remote Bridge

원격 PC에서 ADB 디바이스에 접근할 수 있도록 해주는 브릿지 서비스입니다.

## 특징

- 🔗 **Direct 연결 (P2P)**: 같은 네트워크에서 낮은 지연으로 직접 연결
- 🌐 **Relay 연결**: NAT/방화벽 환경에서 자동 우회
- 🔀 **메시 구조**: 각 노드가 Provider + Controller 역할 동시 수행
- 📦 **단일 exe**: pkg로 패키징된 단일 실행 파일

## 요구사항

- Node.js 20+
- ADB (Android Debug Bridge) 환경변수(PATH) 사전 설정

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


## Relay 설정 템플릿

- 기본 템플릿: `config.relay.example.json`
- 실행 예시: `sdfadb relay --config ./config.relay.example.json`


## Codex 작업 이력을 파일로 전달하기

원격 push가 막힌 환경이라면, 아래 스크립트로 이력 파일(`bundle` + `patch`)을 생성해서 다른 PC로 전달할 수 있습니다.

```bash
# 저장소 루트에서 실행
bash sdfadb/scripts/export-history.sh

# 생성 결과
# - exports/sdfadb-work.bundle
# - exports/patches/*.patch
```

다른 PC에서 적용:

```bash
# 방법 1) bundle로 브랜치 가져오기
git clone /path/to/exports/sdfadb-work.bundle -b work sdfadb

# 방법 2) 기존 저장소에 patch 적용
cd sdfadb
git am /path/to/exports/patches/*.patch
```

## GitHub 저장소 기준으로 수정사항 가져오기

`https://github.com/pdj14/sdfadb` 기준으로 다른 PC에서 수정사항을 가져올 때는, 먼저 원격에 어떤 브랜치가 있는지 확인한 뒤 진행하세요.

```bash
# 1) 최초 1회: 저장소 클론
git clone https://github.com/pdj14/sdfadb
cd sdfadb

# 2) 원격 브랜치 확인
git fetch --all --prune
git branch -a

# 3) 기본은 main 기준으로 최신 반영
git checkout main
git pull --ff-only origin main

# 4) 현재 코드 버전 확인(팀 간 동일 SHA 확인용)
git rev-parse --short HEAD
```

`work` 같은 추가 브랜치가 원격에 실제로 있을 때만 아래처럼 체크아웃하세요.

```bash
git checkout -b work origin/work
# 또는
git switch -c work --track origin/work
```

이미 로컬에 저장소가 있는 PC는 아래처럼 갱신하면 됩니다.

```bash
cd sdfadb
git fetch --all --prune
git checkout main
git pull --ff-only origin main
```
