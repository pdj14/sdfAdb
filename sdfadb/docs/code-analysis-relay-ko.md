# SDF ADB 코드 분석 (동작 시나리오 세분화 + Relay 서버 관점 점검)

요청하신 방향(보안은 내부망 기준으로 당장 최우선 제외, 그 외 동작 안정성 중심)에 맞춰,
- **동작별 시나리오를 세분화**하고,
- **Relay 서버 관점(포트/세션/정리/장애)**으로 점검했습니다.

---

## 1) 현재 구조 한 줄 요약

현재 저장소는 아래 2축입니다.

1. `sdfadb`: Provider/Controller/내장 Relay를 포함한 클라이언트 측 실행 패키지
2. `sdfadb-server`: 운영형 Relay 전용 서버 패키지

즉, **Direct 우선 + Relay fallback** 전략 자체는 이미 코드 구조에 반영되어 있습니다.

---

## 2) 동작을 4가지로 쪼개서 점검

질문에서 주신 흐름을 기준으로 실제 동작을 4가지로 구분하면 아래와 같습니다.

---

### 시나리오 A) 디바이스 공유(Direct)

> Provider가 디바이스를 직접 공유하고, Controller가 Provider에 직접 붙는 흐름

#### 흐름
1. Provider가 `--direct`로 TCP 서버를 염
2. Controller가 Provider로 직접 접속
3. JSON 핸드셰이크로 `deviceSerial` 전달(또는 단일 자동 브릿지)
4. Provider가 로컬 ADB(5037)에 연결해 `host:transport:<serial>`로 대상 디바이스 고정
5. Controller는 자신의 로컬 포트(`localhost:<localPort>`)에 ADB 연결

#### 체크 포인트
- 장점: Relay 리소스 불필요, 지연 최소
- 리스크:
  - NAT/방화벽 환경에서 실패 가능성 큼
  - Provider 측 단일 연결/다중 연결 정책이 명확하지 않으면 충돌 가능
- 보완 권장:
  - 동일 serial에 대해 동시 대여 허용 여부 정책화(허용/배타)
  - Direct 실패 시 Relay로 자동 전환 시도 횟수/타임아웃 표준화

---

### 시나리오 B) 디바이스를 Relay 서버를 통해 공유(Provider 측)

> Provider는 Relay에 등록하고, "내가 가진 디바이스 목록"을 주기적으로 갱신

#### 흐름
1. Provider가 Relay(WebSocket)에 `register_provider`
2. Relay가 providerId와 device list를 메모리에 보관
3. 필요 시 `update_devices`로 목록 갱신

#### 체크 포인트
- 장점: Provider가 사설망 뒤에 있어도 외부 Controller가 접근 가능
- 리스크:
  - Provider 연결이 끊겼는데 목록이 stale 상태로 남으면 "유령 디바이스"가 보일 수 있음
  - provider 재접속 시 이전 세션 정리 규칙이 불명확하면 중복 상태 발생
- 보완 권장:
  - provider WS 종료 시 해당 provider 디바이스/세션 일괄 비활성 처리
  - provider 재등록 시 기존 상태 교체(upsert) + 오래된 세션 강제 종료

---

### 시나리오 C) 디바이스 빌려가기(Direct)

> Controller가 Direct 주소를 알고 직접 붙어서 사용

#### 흐름
1. Controller가 Provider direct endpoint로 접속
2. 대상 serial 요청 후 승인 응답 수신
3. Controller 로컬 포트에 브릿지 서버 생성
4. 사용자는 `adb connect localhost:<localPort>`로 이용

#### 체크 포인트
- 장점: 경로 단순, Relay 트래픽 비용 없음
- 리스크:
  - Controller 측 로컬 포트 충돌/중복 사용 가능
  - 종료(Ctrl+C/비정상 종료) 시 리소스 정리 누락 가능
- 보완 권장:
  - 로컬 포트 점유 검사 강화
  - 비정상 종료 대비 정리 훅(소켓/서버 close) 보강

---

### 시나리오 D) 디바이스를 Relay 서버를 통해 빌려가기(Controller 측)

> Controller가 Relay에 `connect_device`를 보내고, Relay가 터널 포트를 할당해 중계

#### 흐름
1. Controller → Relay: `connect_device(providerId, deviceSerial)`
2. Relay: 포트 풀에서 터널 포트 1개 할당
3. Relay → Provider: `connect_request(relayPort)` 전달
4. Controller는 로컬 포트 서버를 열고, 들어오는 ADB 연결을 Relay의 `relayPort`로 전달
5. Provider/Controller 양단 TCP가 붙으면 Relay가 바이트 스트림 중계

#### 체크 포인트
- 장점: NAT 우회, 운영 제어점 집중
- 리스크:
  - 포트 고갈 시 신규 대여 실패
  - provider/controller 한쪽만 붙고 반대편 미접속 시 반쪽 세션 누수
  - `disconnect` 미완성으로 장기 누수 가능
- 보완 권장:
  - 세션 상태머신 도입: `ALLOCATED -> WAIT_PROVIDER/WAIT_CLIENT -> ACTIVE -> CLOSED`
  - half-open 타임아웃(예: 10~30초) 이후 자동 회수
  - 명시적 `disconnect_session` 구현 + 종료 사유 로깅

---

## 3) 다중 동시성 시나리오 추가 리뷰 (요청사항 반영)

아래 3가지는 실제 운영에서 자주 겹쳐 발생하므로, 기능 가능 여부 + 잠재 충돌 지점을 별도로 점검해야 합니다.

### 3-1) 한 PC의 여러 디바이스를 각각 다른 PC에서 대여해가는 경우

예시:
- Provider P1에 디바이스 A/B/C 연결
- Controller C1은 A, C2는 B, C3는 C를 동시에 대여

판단:
- 구조적으로는 가능(디바이스 serial 단위로 세션을 분리하면 됨)
- 다만 현재 구현에서 명시적 "디바이스 락" 정책이 약하면, 동일 serial 중복 요청이 섞일 수 있음

필수 점검:
- `providerId + deviceSerial` 단위로 active session 인덱스 유지
- 동일 serial에 새 요청 시 정책 분기
  - 배타 모드: 기존 세션 있으면 거절
  - 공유 모드: 허용하되 성능 저하 경고/상한 적용
- provider disconnect 시 해당 provider의 모든 serial 세션 일괄 종료

### 3-2) 한 PC가 여러 곳에서 디바이스를 대여해오는 경우

예시:
- Controller C1이 Provider P1의 A, P2의 X, P3의 M을 동시에 대여

판단:
- 구조적으로 가능(로컬에서 포트별로 분리하면 됨)
- 가장 큰 실무 리스크는 **Controller 로컬 포트 충돌**과 **프로세스 종료 시 부분 누수**

필수 점검:
- Controller 측 localPort allocator(자동 할당 또는 충돌 회피)
- 연결 테이블에 `localPort -> {providerId, deviceSerial, sessionId}` 추적
- 종료 신호(Ctrl+C) 시 전체 세션 순회 종료
- 특정 세션만 끊는 per-session disconnect 지원

### 3-3) 한 PC가 동시에 "공유자 + 대여자" 역할을 공존하는 경우

예시:
- Node N1은 로컬 USB 디바이스 D1/D2를 다른 PC에 공유
- 동시에 N1 자신도 다른 Provider의 디바이스를 대여해 사용

판단:
- 아키텍처상 가능하지만, 포트/리소스/상태관리 격리가 없으면 충돌 가능

필수 점검:
- 네임스페이스 분리:
  - provider side listen 포트
  - controller side local bridge 포트
  - relay tunnel 포트(서버 측)
- 프로세스 내부 상태 분리:
  - 제공 세션 맵(providerSessions)
  - 대여 세션 맵(controllerSessions)
- 장애 전파 차단:
  - 대여 세션 장애가 제공 세션에 영향 주지 않도록 에러 핸들링 분리
  - provider ws 재연결 시 controller 로직이 함께 재시작되지 않도록 분리

### 3-4) 공존 환경에서 특히 주의할 병목

- ADB 서버(5037) 단일 지점 병목: 동시 세션이 늘면 handshake/transport 전환 지연
- 이벤트 혼선: requestId 없는 메시지 체계에서는 다중 세션일수록 응답 섞임 위험 증가
- 포트 회수 지연: half-open 세션 누적 시 다중 사용자 환경에서 빠르게 고갈

권장 추가 조치:
- 세션 상한(PC당, provider당, device당) 설정
- per-device queue(배타 모드일 때 대기열)
- 세션 메트릭 분리 집계
  - provider_active_sessions
  - controller_active_sessions
  - per_device_wait_queue

---

## 4) Relay 서버 관점 정밀 점검

아래는 "운영 서버" 입장에서 반드시 봐야 하는 항목입니다.

### 4-1) 포트 풀 정책
- 현재는 "요청 1건당 포트 1개"를 잡는 구조(세션 중심)입니다.
- 세션이 끝나면 release해야 재사용됩니다.

권장 운영값(초기안):
- 포트 범위: 동시 세션 수 x 1.5~2배
- 예: 동시 500세션 목표면 최소 750~1000 포트

### 4-2) 세션 라이프사이클
- 필수 이벤트:
  - allocate
  - provider_connected
  - controller_connected
  - active
  - closed(reason)
- 이 이벤트가 로그/메트릭으로 남아야 장애 원인 분석이 쉽습니다.

### 4-3) 정리(Cleanup)
- 정상 종료: 양단 소켓 close + 포트 release
- 비정상 종료:
  - provider WS close
  - controller WS close
  - bridge listen만 열리고 양단 미접속
- 위 3가지 모두 타임아웃 기반 자동 회수가 필요합니다.

### 4-4) 장애/재시도 전략
- Controller에 "재시도 가능한 에러"(port exhausted, provider timeout)와 "즉시 실패 에러"(provider not found)를 구분해 반환
- 재시도 시 backoff(예: 1s, 2s, 4s) 적용

---

## 5) 핵심 질문: "Relay 서버에서 디바이스마다 포트를 꼭 할당해야 하나?"

결론부터:
- **디바이스마다 고정 포트를 반드시 가질 필요는 없습니다.**
- 지금 코드와 같이 **연결 세션마다 임시 포트 할당**이 일반적으로 더 맞습니다.

### 왜 "디바이스 고정 포트"가 꼭 필요하지 않은가?
1. 같은 디바이스도 시간대별로 사용자/세션이 바뀜
2. 고정 포트는 장기 점유로 이어져 포트 효율이 떨어짐
3. 실제로 필요한 건 "디바이스 식별"이지 "고정 포트 주소"가 아님

### 세 가지 모델 비교

#### 모델 1) 디바이스 고정 포트(비권장)
- 장점: 외부에서 기억하기 쉬움
- 단점: 유휴 포트 낭비, 충돌/복구 복잡, 다중 접속 제어 어려움

#### 모델 2) 세션당 동적 포트(현재 구조, 권장)
- 장점: 포트 재사용 효율 좋음, 구현 단순, 동시성 제어 쉬움
- 단점: 시그널링(어떤 포트로 붙을지 전달) 필수

#### 모델 3) 단일/소수 포트 + L7 멀티플렉싱(고급)
- 장점: 포트 소모 최소
- 단점: 프로토콜/프레이밍/상태관리 복잡도 급상승

**운영 현실 기준 추천:**
- 지금 단계는 **모델 2(세션당 동적 포트)** 유지가 가장 안전합니다.
- 이후 대규모 트래픽에서 포트 부족이 실측되면 모델 3를 검토하세요.

---

## 6) 우선순위 재정의 (내부 서비스 전제)

질문하신 대로 보안 최우선 순위를 내리고, 아래 순서로 보완 권장합니다.

1. **세션/포트 정리 완성**
   - `disconnect` 구현
   - half-open timeout
   - provider/controller 종료 시 포트 회수 보장
2. **다중 동시성 정책 확정**
   - per-device 배타/공유 정책
   - per-controller 다중 대여 시 포트 충돌 방지
   - provider/controller 공존 노드 상태 분리
3. **프로토콜 안정화**
   - requestId 기반 요청-응답 매칭
   - 이벤트와 응답 메시지 분리
4. **운영 가시성**
   - 세션 상태 로그/메트릭(생성~종료)
   - 포트 사용률/고갈 경보
5. **중복 구현 정리**
   - `sdfadb` 내장 Relay와 `sdfadb-server` 코어 통합
6. **보안(내부망 기준 후순위)**
   - 추후 외부 노출/타 조직 연동 시 wss/인증/ACL 적용

---

## 7) 실무용 점검표 (동작별)

### Provider(공유자)
- [ ] 등록 후 디바이스 목록 갱신이 정상 반영되는가
- [ ] provider 재시작 시 오래된 세션이 정리되는가
- [ ] 동일 디바이스 동시 대여 정책이 의도대로 동작하는가
- [ ] 여러 디바이스(A/B/C)가 서로 다른 controller에 병렬 대여될 때 간섭이 없는가

### Controller(대여자)
- [ ] Direct 실패 시 Relay fallback이 예측 가능한 시간 내 동작하는가
- [ ] 로컬 포트 중복/충돌 처리가 되는가
- [ ] Ctrl+C/프로세스 종료 시 로컬 브릿지와 Relay 세션이 정리되는가
- [ ] 한 controller가 여러 provider에서 다중 대여 시 포트/세션 매핑이 꼬이지 않는가

### Hybrid Node(공유 + 대여 공존 PC)
- [ ] provider 역할 세션과 controller 역할 세션이 내부 상태에서 분리 관리되는가
- [ ] 한쪽 역할 장애가 다른 역할 세션 종료를 유발하지 않는가
- [ ] 공존 시 CPU/메모리/FD 사용량이 임계치 내에 있는가

### Relay(중계 서버)
- [ ] 세션 생성 후 양단 접속 완료까지 타임아웃이 있는가
- [ ] 미완료 세션/끊긴 세션 포트가 자동 회수되는가
- [ ] 포트 풀 고갈 시 오류와 재시도 안내가 명확한가
- [ ] 재시작 시 orphan 상태가 남지 않는가
- [ ] 다중 동시성(다수 provider·controller 혼재)에서 세션 라우팅이 정확한가

---

## 8) 최종 제안

- 현재 목표("다른 PC로 ADB 전달 + Direct 어려우면 Relay")와 구현 방향은 맞습니다.
- 이번 추가 요청 기준으로는, 단일 흐름 검증보다 **다중 동시성(다대다 대여 + 공존 노드)에서의 세션 격리/정리**를 우선 검증해야 합니다.
- 포트 정책은 **디바이스 고정 포트**가 아니라, 지금처럼 **세션당 동적 포트**를 유지하는 것이 운영상 더 타당합니다.

---

## 9) 순차적 수정 리스트 (실행 플랜)

아래 순서대로 진행하면, 리스크가 큰 부분부터 안정적으로 줄여가면서 기능을 확장할 수 있습니다.

### Phase 1. 세션 정리/포트 회수 완성 (가장 먼저)
1. `disconnect` CLI 구현(단일 세션/전체 세션)
2. Relay에 `disconnect_session` 처리 추가
3. half-open 타임아웃(양단 미접속) 도입
4. provider/controller WS 종료 시 연관 세션 일괄 close + 포트 release
5. 회수 실패 케이스 로깅(`reason`, `sessionId`, `port`)

완료 기준:
- 의도적 종료/비정상 종료 모두에서 포트 누수 0건
- 24시간 soak 테스트에서 allocated 포트가 steady-state 유지

### Phase 2. 다중 동시성 정책 코드화
1. `providerId + deviceSerial` 기반 active session 인덱스 도입
2. per-device 정책(배타/공유) 설정 가능하게 분기
3. Controller localPort allocator 추가(충돌 자동 회피)
4. Hybrid Node 상태 분리(providerSessions / controllerSessions)
5. 세션 상한(노드당/디바이스당/provider당) 설정

완료 기준:
- 한 provider의 다중 디바이스를 서로 다른 controller가 병렬 대여 가능
- 한 controller의 다중 provider 동시 대여 시 포트/세션 매핑 충돌 0건
- hybrid 역할 공존 시 한쪽 장애가 다른쪽 세션에 영향 없음

### Phase 3. 프로토콜 안정화(requestId)
1. 모든 요청 메시지에 `requestId` 추가
2. 응답에 동일 `requestId` 에코
3. 이벤트 메시지와 응답 메시지 스키마 분리
4. Controller pending-request map 도입(타임아웃 포함)
5. out-of-order 응답/이벤트 혼입 테스트

완료 기준:
- 동시 요청 N개 상황에서도 응답 mismatch 0건
- 비정상 응답/타임아웃 케이스에서 retry 동작 일관성 확보

### Phase 4. 운영 가시성/장애 대응
1. 세션 상태 이벤트 표준화(allocate/connected/active/closed)
2. 메트릭 추가
   - `provider_active_sessions`
   - `controller_active_sessions`
   - `port_pool_usage`
   - `half_open_sessions`
3. 에러 코드 체계화(재시도 가능/불가 분리)
4. 포트 고갈/세션 급증 경보 임계치 설정

완료 기준:
- 장애 시 "어디서 끊겼는지"를 1~2분 내 로그/메트릭으로 식별 가능

### Phase 5. 구조 정리 및 운영 배포
1. 내장 Relay와 `sdfadb-server`의 중복 로직 통합
2. 공통 Relay 코어 모듈화
3. 운영 설정 템플릿 정리(포트 범위, 상한, 타임아웃)
4. 롤링 배포/재시작 시 세션 정리 정책 문서화

완료 기준:
- 동일 버그를 두 코드베이스에서 중복 수정하는 상황 제거

---

## 10) 먼저 결정해야 하는 항목 (의사결정 체크리스트 + 권장안)

아래 항목은 구현 전에 팀에서 먼저 확정해야, 재작업을 줄일 수 있습니다.

1. **디바이스 동시 대여 정책**
   - 선택지: 배타(1명만) / 공유(다수 허용) / 조건부 공유(읽기 전용 등)
   - **권장안(초기)**: 배타 모드 기본값 + 예외 디바이스만 공유 허용
   - 이유: 충돌/책임소재/성능 예측이 가장 단순함

2. **세션 식별자 기준**
   - 선택지: `sessionId`를 Relay가 발급 / Controller가 제안
   - **권장안(초기)**: Relay 발급(서버 authoritative)
   - 이유: 중복 방지, 추적 일관성, 서버 재시작/정리 로직 단순화

3. **localPort 할당 방식**
   - 선택지: 사용자 지정 우선 + 충돌 시 실패 / 자동 할당 우선
   - **권장안(초기)**: 자동 할당 우선 + 필요 시 `--local-port` 명시 override
   - 이유: 다중 대여 시 포트 충돌을 운영자가 수동 관리하지 않아도 됨

4. **Hybrid Node 운영 방식**
   - 선택지: 단일 프로세스로 공존 / 프로세스 분리(Provider/Controller 각각)
   - **권장안(초기)**: 프로세스 분리
   - 이유: 장애 격리와 리소스 상한 제어가 쉬움(한쪽 장애 전파 최소화)

5. **세션 상한 정책**
   - 선택지: 무제한 / 노드별·디바이스별·provider별 상한
   - **권장안(초기)**:
     - provider당 active 세션 상한: 20
     - controller당 active 세션 상한: 10
     - device당 동시 세션 상한: 1(배타 모드)
   - 이유: 초기에는 보수적으로 시작하고 메트릭 기반으로 점진 확장

6. **타임아웃 기본값**
   - 선택지: half-open / idle / request timeout 개별 정의
   - **권장안(초기)**:
     - half-open timeout: 15초
     - request timeout: 10초
     - idle timeout: 5분
   - 이유: 과도한 세션 누수를 막으면서도 네트워크 지터 허용 가능 범위

7. **에러 처리 UX**
   - 선택지: 자동 재시도 / 즉시 실패 표시
   - **권장안(초기)**: 재시도 가능한 에러만 자동 재시도(최대 3회, 지수 백오프), 나머지는 즉시 실패
   - 이유: 사용자 체감 성공률과 장애 인지 속도의 균형

8. **로그/메트릭 최소 스펙**
   - 선택지: 상세 수집 / 최소 수집
   - **권장안(초기 최소 세트)**:
     - 로그: `sessionId`, `providerId`, `controllerId`, `deviceSerial`, `port`, `state`, `reason`
     - 메트릭: `port_pool_usage`, `active_sessions`, `half_open_sessions`, `connect_failures`
   - 이유: 원인 분석에 필요한 최소 필드만 먼저 표준화

9. **릴레이 포트 전략 확정**
   - 선택지: 디바이스 고정 포트 / 세션당 동적 포트
   - **권장안(초기)**: 세션당 동적 포트(유지)
   - 이유: 포트 효율/회수/동시성 제어가 가장 단순하고 현재 구조와 정합성 높음

10. **중복 코드 통합 시점**
    - 선택지: 안정화 후 통합 / 즉시 통합
    - **권장안(초기)**: 안정화 후 통합
    - 이유: 동시성/정리 이슈를 먼저 고정한 뒤 통합해야 리스크가 낮음

---

### 빠른 의사결정 제안(이번 주 내 잠정 확정안)

- 동시 대여 정책: **배타 기본 + 예외 공유**
- 세션 ID: **Relay 발급**
- localPort: **자동 할당 기본**
- Hybrid 운영: **프로세스 분리**
- 포트 전략: **세션당 동적 포트 유지**
- 타임아웃: **15s / 10s / 5m(half-open/request/idle)**

위 6가지만 먼저 확정해도 Phase 1~3 착수가 가능합니다.
