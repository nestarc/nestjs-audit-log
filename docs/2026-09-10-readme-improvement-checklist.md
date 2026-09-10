# README 검증 후 개선 목록

기준: 2026-09-10 README·구현·배포 구성 조사 및 사용자의 전체 개선 승인.
상태: **18/18 완료**. 아래 18개 항목을 작업 범위로 고정했으며 구현·문서·검증을 완료했다.
완료 기준일: 2026-09-10. 코드 변경은 `Unreleased`이며 npm 게시 및 공식 사이트 배포는 이번 작업에 포함하지 않았다.

| ID | 고정 항목 | 완료 기준 | 상태 |
|---|---|---|---|
| A01 | 중첩 쓰기 차단 범위 | 추적 제외 부모를 통한 추적 대상 자식 변경을 검사하고 회귀 테스트 추가 | 완료 |
| A02 | 스트리밍 전달 보장 | 조회한 배치의 재전송과 전체 커밋 행 수집을 구분하고 지연 커밋 한계·회귀 시나리오 명시 | 완료 |
| A03 | 인증 Guard와 actor 추출 | 인증 이후 actor를 가져오는 지원 경로와 실제 Guard 테스트 제공 | 완료 |
| A04 | 벤치마크 | 현행 API로 컴파일·실행되며 모드·환경·측정 조건을 명시; 오래된 성능 주장 제거 | 완료 |
| A05 | 조회 예제 | 자동/수동 action·source를 실제 생성 로그와 일치시킴 | 완료 |
| A06 | 실행 가능한 Quick Start | 환경 설정·Prisma 생성·migration·Nest 구동·로그 조회를 재현 가능하게 제공 | 완료 |
| A07 | retention 잠금 설명 | trigger 경로와 legacy RULE 경로의 잠금 수준을 정확히 설명 | 완료 |
| A08 | 완료된 scan 재개 | 완료 checkpoint/highWatermark 재사용 동작을 정의하고 검증 | 완료 |
| A09 | 잡힌 감사 오류와 원자성 | atomic helper가 감사 실패를 기억하여 오류를 삼켜도 commit하지 않도록 보완 | 완료 |
| A10 | tenantResolver 우선순위 | 사용자 resolver가 null을 반환해도 fallback하지 않는 계약 명시 | 완료 |
| A11 | README 구조·중복 | 목차·실제 결과 추가, 조회 중복 축소, 유지보수 절차 분리 | 완료 |
| A12 | 검색·패키지 메타데이터 | 설명적 제목·문서 링크·homepage·bugs 정리 | 완료 |
| A13 | 공식 사이트와 버전 기준 | 공식 문서 소스 확인 후 README와 지원/검증 버전 기준 동기화 | 완료 |
| A14 | 실행 문서 검증 | 문자열 검사에 더해 공개 패키지 최소 예제의 compile/create/query 검증 연결 | 완료 |
| A15 | 과거 설계 문서 | Historical/Superseded·적용 버전·현행 문서 링크를 명시 | 완료 |
| A16 | actor/context·공통 옵션 안내 | runAs·AuditReason·metadata·모듈/extension 공통 설정 예제 제공 | 완료 |
| A17 | AI 문서 탐색·배포 | 현행 문서 인덱스 제공 및 README·타입·사용 가이드 패키징 검증 | 완료 |
| A18 | 필수 스트림과 retention | checkpoint가 없는 필수 스트림은 prune을 막는 복사 가능한 예제 제공 | 완료 |

## 완료 근거

| 항목 | 구현·문서·회귀 검증 |
|---|---|
| A01 | [중첩 쓰기 정책](../src/prisma/audit-extension/mutation-policy.ts)을 추적 제외 모델보다 먼저 검사하고 중간 관계를 재귀 탐색한다. [단위 테스트](../test/audit-nested-writes.spec.ts)와 [PostgreSQL E2E](../test/e2e/nested-writes.e2e-spec.ts)에서 차단 및 명시적 예외를 검증했다. |
| A02 | [export 가이드](export-and-streams.md)에 timestamp checkpoint의 가시성·지연 커밋·재시도 시 배치 구성 한계를 명시했다. [E2E](../test/e2e/phase7-durable-stream.e2e-spec.ts)에서 먼저 시작한 트랜잭션의 늦은 커밋이 이미 ACK한 위치 뒤로 누락되는 상황을 재현했다. |
| A03 | `actorExtractionStage: 'interceptor'` 옵션을 추가했다. [actor 가이드](context-and-tenancy.md), 실제 Guard를 사용하는 [모듈 테스트](../test/audit-log.module.spec.ts), [HTTP E2E](../test/e2e/http-path.e2e-spec.ts)로 인증 이후 추출을 검증했다. |
| A04 | [벤치마크](../benchmarks/audit-overhead.ts)를 네 가지 모드·세 가지 작업으로 갱신하고 12개 시나리오를 실행했다. [측정 조건과 결과](benchmarks.md), [원시 JSON](benchmarks/2026-09-10-local.json)을 보존했다. 일반적인 성능 보장으로 해석하지 않도록 명시했다. |
| A05–A06 | [README](../README.md)와 [독립 실행 예제](../examples/quick-start/README.md)에 설치·환경·migration·Prisma 생성·Nest 구동·생성 로그·조회 결과를 연결했다. 예제의 HTTP 검증은 action/source, actor, tenant, masking 및 rollback을 실제 DB에서 확인한다. |
| A07 | [storage 가이드](storage-and-retention.md)에 trigger 기반 pruning의 `SHARE ROW EXCLUSIVE`와 legacy RULE 경로를 구분했다. |
| A08 | [scan 구현](../src/services/audit-scan.service.ts)은 `after === until`을 완료된 범위로 반환한다. [단위 테스트](../test/audit-read-services.spec.ts)와 [E2E](../test/e2e/phase6-streaming-export.e2e-spec.ts)에서 빈 결과 및 재개 동작을 확인했다. |
| A09 | [트랜잭션 helper](../src/prisma/audit-extension.ts)가 최초 감사 실패를 기억한다. 사용자 코드가 오류를 잡아도 atomic transaction은 실패하며, [단위 테스트](../test/audit-extension-queries.spec.ts)와 [E2E](../test/e2e/transactions-atomic.e2e-spec.ts)에서 검증했다. |
| A10 | [tenant 가이드](context-and-tenancy.md)에 사용자 resolver가 유일한 조회 경로이며 `null`도 그대로 적용되는 계약을 명시했다. |
| A11–A12 | README를 377줄로 정리하고 목차·가이드별 링크를 추가했다. [패키지 메타데이터](../package.json)의 homepage·bugs·검색어를 정리하고 근거 없는 규정 준수 검색어를 제거했다. |
| A13 | 인접 `nestarc.dev` 저장소의 audit-log 문서 9개를 수정하고 agent guide를 추가했다. 사이트는 게시된 `0.5.0`, 현재 checkout은 `Unreleased`라는 기준을 각각 명시했다. 사이트의 기존 다른 변경은 보존했다. |
| A14 | [소비자 검증 스크립트](../scripts/verify-docs-consumer.cjs)가 실제 `npm pack` 산출물을 임시 디렉터리에 strict peer dependency 조건으로 설치하고 생성·migration·compile·HTTP smoke를 실행한다. [CI](../.github/workflows/ci.yml)에 연결했다. |
| A15 | 기존 설계·검증·roadmap·spec 문서에 Historical 상태, 적용 시기 및 현행 README/CHANGELOG 참조를 추가했다. |
| A16 | [context 가이드](context-and-tenancy.md)와 실행 예제에 Guard actor, `runAs`, `AuditReason`, metadata 및 module/extension 공통 설정을 제공했다. |
| A17 | [llms.txt](../llms.txt)와 [agent guide](agent-guide.md)에 버전별 탐색 경로·API 선택·주의점을 제공했다. [문서 테스트](../test/docs.spec.ts), 실제 tarball 검증으로 가이드·타입·예제 포함을 확인했다. |
| A18 | [필수 스트림 checkpoint 가드](export-and-streams.md#retention-and-required-streams)는 상태나 checkpoint가 없으면 예외를 발생시키고 pruning을 중단한다. checkpoint가 지연 커밋까지 수집했다는 증거는 아니라는 한계도 명시했다. |

## 최종 검증 결과

| 검증 | 결과 |
|---|---|
| `npm run lint`, `npm run typecheck`, `npm run build`, `git diff --check` | 통과 |
| `npm run test:cov -- --runInBand` | 25 suites / 414 tests 통과; statements 93.25%, branches 86.61%, functions 94.09%, lines 93.78% |
| `npm run test:e2e` | 전용 PostgreSQL 16에서 12 suites / 81 tests 통과 |
| `npm run test:docs:consumer` | 독립 tarball 설치부터 HTTP 생성·수동 이벤트·조회·actor·tenant·masking·rollback까지 통과 |
| `npm run test:e2e:ecosystem:candidate` | 현재 audit-log tarball + tenancy 0.15.0 + soft-delete 0.7.2 조합의 4개 시나리오 통과 |
| `npm run bench` | 12개 시나리오 실행 및 행 수·action·source 검증 통과 |
| `npm pack --dry-run --json` | 배포 파일 194개 확인; llms.txt·사용 가이드·타입·실행 예제·벤치마크 JSON 포함 |
| 공식 사이트 `npm run docs:check` | 78 tests, API 문서 검사, VitePress build, public pages 190개 / HTML 191개 검사 통과 |

검증 환경과 호환성 범위를 혼동하지 않도록 실제 실행한 버전 조합은 [README](../README.md)에 기록했다. 모든 peer dependency 버전 조합을 실행했다고 주장하지 않는다.

## 남아 있는 제품 한계와 배포 상태

- A02는 전달 보장 설명 및 회귀 시나리오를 고치는 항목이다. timestamp 기반 streaming의 지연 커밋 누락 자체를 해결하는 CDC는 구현하지 않았다. 전체 커밋 수집이 필요하면 별도 CDC 또는 보존 데이터에 대한 재조정이 필요하다.
- 현재 코드 변경은 아직 게시되지 않았다. 공식 사이트 소스는 게시된 `0.5.0`의 동작을 설명하며, 신규 옵션과 수정 사항은 [CHANGELOG의 Unreleased](../CHANGELOG.md)에 기록했다.
- npm 게시, 사이트 배포, commit, push는 실행하지 않았다. 공식 사이트 패치는 audit-log 문서와 새 페이지의 sitemap 날짜 항목으로 한정했다.

## 검증 원칙

- 기존 단위 테스트·lint·typecheck·build와 변경된 경로의 회귀 테스트를 실행한다.
- 가능한 경우 전용 테스트 PostgreSQL에서 E2E, 소비자 예제, 벤치마크를 실행한다.
- 지연 커밋 누락을 완전히 해결하는 CDC 도입은 이번 변경으로 주장하지 않는다. A02는 현재 API의 보장과 한계를 정확히 제공하는 작업이다.
- 외부 사이트 변경 또는 환경 문제로 완료하지 못한 항목은 근거와 남은 작업을 기록한다.
- 완료 상태는 구현·문서·검증 결과가 확보된 뒤 갱신한다.
