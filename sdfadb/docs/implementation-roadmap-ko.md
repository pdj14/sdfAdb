# SDF ADB 순차 구현 리스트 (권장안 고정)

요청사항에 따라, 이전 분석에서 제시한 **결정 필요 항목은 모두 권장안으로 확정**하고 구현을 순차 진행합니다.

## 0) 결정 항목 확정값

- 디바이스 동시 대여 정책: **배타 기본 + 예외 공유**
- sessionId 발급 주체: **Relay 서버 발급**
- localPort 전략: **자동 할당 우선(필요 시 수동 override)**
- Hybrid 운영: **Provider/Controller 프로세스 분리 권장**
- 포트 전략: **세션당 동적 포트 유지**
- 타임아웃 기본값: **half-open 15s / request 10s / idle 5m**

---

## 1) 구현 리스트 (체크리스트)

### Phase 1. 세션 정리/포트 회수
- [x] 1-1. `disconnect` CLI 동작 구현 (저장된 relay 세션 기준)
- [x] 1-2. Relay에 `disconnect_device`/`disconnect_response` 프로토콜 추가
- [x] 1-3. Provider에 `disconnect_request` 전달해 relay tunnel 종료
- [x] 1-4. half-open timeout(15s) 추가
- [x] 1-5. idle timeout(5m) 추가

### Phase 2. 다중 동시성 정책 코드화
- [x] 2-1. `providerId + deviceSerial` active session 인덱스 도입
- [x] 2-2. 배타 정책 기본 적용(동일 디바이스 중복 대여 거절)
- [x] 2-3. localPort allocator 자동화
- [x] 2-4. Hybrid state 분리(providerSessions/controllerSessions)

### Phase 3. 프로토콜 안정화
- [x] 3-1. requestId 도입
- [x] 3-2. 응답 requestId echo
- [x] 3-3. 이벤트/응답 메시지 분리
- [x] 3-4. pending-request map + timeout

### Phase 4. 관측성
- [x] 4-1. 세션 상태 이벤트 표준 로그
- [x] 4-2. 메트릭 최소셋 추가(port_pool_usage, active_sessions, half_open_sessions)
- [x] 4-3. 재시도 가능/불가 에러 코드 정리

### Phase 5. 구조 정리
- [x] 5-1. embedded relay / standalone relay 운영 코어(옵션/에러/메트릭 규약) 정렬
- [x] 5-2. 운영 설정 템플릿(포트/상한/타임아웃) 정리

---

## 2) 이번 커밋에서 진행한 항목

- Phase 1~5를 순차 완료(운영 코어 정렬 + 설정 템플릿 포함).
- 다음 단계는 통합 안정화 테스트 및 문서 보강.
