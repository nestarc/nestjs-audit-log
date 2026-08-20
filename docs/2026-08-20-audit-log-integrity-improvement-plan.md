# @nestarc/audit-log 무결성 개선 및 후속 기능 계획

- 작성일: 2026-08-20
- 대상 저장소: `@nestarc/audit-log`
- 기준 브랜치: `main`
- 기준 커밋: `9597a73` (`v0.3.0`, `Implement audit log enhancements`)
- 문서 상태: Phase 2 구현 완료 — peer matrix CI 통과 후 Phase 3 착수 가능
- 우선순위 기준: 감사 데이터의 진실성 및 트랜잭션 무결성

## 1. 이 문서의 목적

이 문서는 `@nestarc/audit-log`의 현재 구현, 문서, 단위 테스트, PostgreSQL E2E,
CI 설정 및 `nestarc.dev` 패키지 문서를 교차 검토한 결과를 다음 작업 세션으로
인계하기 위한 실행 계획이다.

다음 세션에서는 조사부터 반복하지 말고 이 문서의 **12. 다음 세션 시작 절차**부터
진행한다. 코드나 라인 번호가 이동했을 수 있으므로 기준 커밋과 현재 `HEAD`가 다르면
먼저 관련 심볼을 `rg`로 다시 찾는다.

## 2. 요약 결론

핵심 트랜잭션 문제는 추측이 아니라 현재 코드와 프로젝트 자체 E2E 테스트로 확인된다.

1. 기본 자동 추적의 업무 mutation은 caller transaction에 참여하지만 감사 pre/post-read와
   INSERT는 base client를 사용한다.
2. 그 결과 caller transaction rollback 뒤에도 자동 감사 success 행이 남을 수 있다.
   create rollback에서는 대상이 없는 orphan/phantom 행이고, update/delete rollback에서는
   실제로 커밋되지 않은 작업을 기록한 허위 success 행이다.
3. transaction 내부 update diff는 base client가 미커밋 상태를 보지 못해 `{}`이거나 stale할
   수 있다.
4. 배열형 `$transaction([...])`은 rollback 뒤 감사 행이 `0` 또는 `1`일 수 있는 현재의
   비결정적 동작을 테스트가 허용한다.
5. `experimentalTxAudit`은 private Prisma API에 의존하고 실패 시 best-effort로 fallback하므로
   안정적인 운영 계약이 아니다.
6. 현재 안정적으로 원자성을 확보하는 유일한 공개 경로는 같은 `tx`를 명시적으로 전달하는
   `AuditService.log(input, tx)`이다.
7. soft-delete는 단순 테스트 누락이 아니라 `@nestarc/soft-delete`와의 교차 패키지 계약이
   정의되지 않은 상태다. 현재 권장 extension 순서에서는 soft-delete가 delete를 short-circuit해
   audit extension이 해당 작업을 보지 못한다.

따라서 다음 릴리스의 최우선 목표는 새 기능이 아니라 **자동 추적의 안전한 transaction-first
계약**이다. CSV/SIEM 기능은 이 계약을 해결한 뒤 진행한다.

## 3. 확인된 사실과 근거

### 3.1 P0 — 자동 감사 INSERT가 caller transaction에 참여하지 않는다

- `createAuditExtension()`은 extension 생성 시 base `client`를 캡처한다:
  `src/prisma/audit-extension.ts:691-706`.
- `experimentalTxAudit`이 false이면 `resolveAuditClient()`는 이 client를 그대로 반환한다:
  `src/prisma/audit-extension.ts:333-345`.
- 업무 mutation만 `query(args)`를 호출하여 caller transaction에 남는다:
  create `:727-728`, update `:826-829`, delete `:939-942`, upsert `:1024-1027`.
- 감사 INSERT는 선택된 `auditClient`의 `$executeRaw`로 실행된다:
  `src/prisma/audit-extension.ts:212-262`, `:624-645`.

실제 PostgreSQL E2E는 현재 결함을 명시적으로 단언한다.

- create rollback: 업무 행 0건, 감사 행 1건:
  `test/e2e/transactions.e2e-spec.ts:43-74`.
- caller commit 전 base client에서 감사 행이 이미 보임:
  `test/e2e/transactions.e2e-spec.ts:76-101`.
- create/update/delete가 모두 rollback되어도 감사 success 행 3건 잔존:
  `test/e2e/transactions.e2e-spec.ts:103-146`.

### 3.2 P0 — transaction-local diff가 비거나 stale할 수 있다

update 경로는 다음 세 statement를 수행한다.

1. `auditClient`로 before 조회
2. caller tx의 `query(args)`로 update
3. `auditClient`로 after 조회

근거: `src/prisma/audit-extension.ts:798-899`.

기본 모드에서 1번과 3번은 base client이므로 caller transaction의 미커밋 상태를 보지 못한다.
프로젝트 E2E도 다음을 확인한다.

- 이미 커밋된 행을 transaction 안에서 update하면 diff가 `{}`:
  `test/e2e/transactions.e2e-spec.ts:148-178`.
- 같은 transaction에서 create 후 update해도 update diff가 `{}`:
  `test/e2e/transactions.e2e-spec.ts:180-208`.

추가로 transaction 참여만 해결해도 동시성 정확성이 자동으로 보장되지는 않는다.
현재 `findFirst -> update -> findFirst`의 첫 조회에 row lock이 없으므로 다른 writer가 끼어들면
실제 mutation 직전 값과 기록된 `before`가 다를 수 있다. 안정 API 설계 시 `FOR UPDATE`,
Serializable+retry 또는 DB trigger 중 하나를 결정하고 동시성 E2E로 검증해야 한다.

### 3.3 P0 — 배열형 transaction은 원자적 감사 계약이 없다

- 테스트는 두 번째 create의 unique 충돌로 배열 transaction 전체가 rollback되는 것을 확인한다.
- 그러나 감사 행은 `logs.length <= 1`이면 통과한다:
  `test/e2e/transactions.e2e-spec.ts:235-275`.

이 테스트는 안전성을 보장하는 release gate가 아니라 현재 비결정성을 기록하는
characterization test다.

용어를 다음과 같이 구분한다.

- **array/batch transaction**: `$transaction([...])`
- **bulk mutation**: `createMany`, `updateMany`, `deleteMany`

두 범주는 별도의 제품 계약과 테스트가 필요하다.

### 3.4 P0 — `experimentalTxAudit`은 안정 API가 아니다

- 코드 주석상 semver 보장이 없는 experimental 옵션이다:
  `src/prisma/audit-extension.ts:46-51`.
- `__internalParams.transaction`과 private `_createItxClient`에 의존한다:
  `src/prisma/audit-extension.ts:333-357`.
- interactive transaction이 아니면 base client를 사용한다.
- capability probe가 실패하면 best-effort로 fallback한다.
- tx 내부 감사 statement 실패를 코드가 catch하더라도 PostgreSQL transaction은 이미 aborted될
  수 있다. 현재 E2E가 이 동작을 확인한다:
  `test/e2e/transactions-experimental.e2e-spec.ts:95-146`.

안정 API 구현 후 `experimentalTxAudit`은 deprecate하고, 호환성 보조 경로로 유지할지 제거할지
결정한다.

### 3.5 안정적인 기존 원자 경로

`AuditService.log(input, tx)`는 전달받은 `tx`를 직접 사용한다:
`src/services/audit.service.ts:66-143`.

rollback 동반 여부도 실제 PostgreSQL E2E로 검증된다:
`test/e2e/transactions.e2e-spec.ts:210-233`.

이 경로는 안전하지만 수동 이벤트 기록이며 자동 CUD diff를 제공하는 transaction-first API는
현재 공개 표면에 없다: `src/index.ts:4-17`.

### 3.6 P1 — soft-delete 교차 패키지 계약 부재

현재 `nestarc.dev`의 extension chaining 가이드는 다음을 명시한다.

- soft-delete extension은 delete를 캡처한 lower client의 update로 변환한다.
- callback continuation을 호출하지 않아 이후 audit extension이 delete를 보지 못한다.
- lifecycle event를 `AuditService.log()`로 전달하는 예시는 mutation 이후 best-effort다.

근거:
`/Users/ksy/Documents/GitHub/nestarc.dev/guide/prisma-extension-chaining.md:31-52`,
`:223-273`.

현재 audit-log 테스트 스키마의 `User`에는 `deletedAt` 필드가 없다:
`test/e2e/prisma/schema.prisma:11-20`.

먼저 다음 의미 계약을 정한 뒤 양 패키지를 실제 PostgreSQL로 함께 테스트해야 한다.

- soft delete
- restore
- purge/force delete
- repeated delete/restore
- cascade
- bulk soft delete
- transaction commit/rollback
- 행별 감사와 summary 감사의 경계

### 3.7 이미 구현된 기능과 미구현 기능

다음 기능은 이미 존재한다. 새 기능처럼 다시 계획하지 않는다.

- 구조화 검색, tenant scope, keyset cursor, optional total:
  `src/services/audit.service.ts:145-264`.
- retention, flat prune, partition drop/detach:
  `src/services/audit.service.ts:360-563`.
- 월별 partition, BRIN, 선택적 JSONB GIN, `ensurePartitions()`:
  `src/sql/index.ts:158-327`.

다음은 결함이 아니라 현재 미구현 제품 기능이다.

- CSV/JSON export
- forward scan/checkpoint API
- generic HTTP/NDJSON sink
- Datadog, Splunk, S3 등의 provider adapter
- delivery retry, backoff, DLQ, health/metrics

## 4. 상태 표시와 사용자 커뮤니케이션

현재 `nestarc.dev` 카탈로그는 `audit-log` 0.3.0을 `Supported`로 표시한다:
`/Users/ksy/Documents/GitHub/nestarc.dev/data/package-catalog.mjs:158-173`.

사이트의 Preview 정의는 "API 또는 operating contract가 진화 중인 published package"다:
`/Users/ksy/Documents/GitHub/nestarc.dev/packages/index.md:20-29`.

권장 정책은 다음과 같다.

1. capability-level 상태를 지원할 수 있으면:
   - manual log/query/retention: `Supported`
   - automatic Prisma tracking: `Preview`
2. 패키지 단위 상태만 지원하면 transaction-first 안정 계약 완료 전까지 전체를 `Preview`로
   표시한다.
3. `createAuditExtension()` 자체는 이미 설치 opt-in이므로 "자동 추적을 opt-in으로 변경"이라고
   쓰지 않는다. 대신 **비원자적 best-effort consistency mode를 명시적 opt-in으로 변경**한다.

권장 경고 문구:

> Preview — automatic tracking is best-effort and is not transaction-atomic. An automatic
> success row means the extension callback completed; it does not prove that the surrounding
> transaction committed. Use `AuditService.log(input, tx)` for authoritative rollback-consistent
> records until the stable transaction-first API is available.

`nestarc.dev`는 별도 sibling 저장소이므로 상태 변경과 사이트 문서 수정은 별도 작업/PR로
진행한다.

## 5. 목표 계약

### 5.1 일관성 모드

다음과 같은 명시적 모드를 목표로 한다. 최종 명칭은 구현 전 결정한다.

```ts
type AuditConsistency = 'atomic-required' | 'best-effort';
```

- `atomic-required`
  - 새 권장 기본값.
  - transaction-first helper 밖의 tracked mutation은 business query 실행 전에 실패한다.
  - audit pre-read, post-read, INSERT 실패는 business transaction 전체를 rollback한다.
  - 어떤 경우에도 base-client best-effort로 조용히 fallback하지 않는다.
- `best-effort`
  - 기존 동작을 필요로 하는 사용자의 명시적 레거시 선택.
  - rollback 이후 orphan/허위 success 및 stale diff 가능성을 타입 문서와 런타임 경고로 알린다.

마이그레이션 충격을 줄이기 위해 한 릴리스의 deprecation 경고를 둘지, pre-1.0 minor에서 바로
필수 옵션으로 만들지는 구현 착수 전에 결정한다.

### 5.2 transaction-first API 초안

목표 사용 형태:

```ts
const audit = createAuditedClient(basePrisma, {
  consistency: 'atomic-required',
  trackedModels: ['User', 'Invoice'],
});

await audit.withAuditTransaction(
  async (tx) => {
    await tx.user.update({ where: { id }, data: { name: 'After' } });
    await tx.invoice.create({ data: invoice });
  },
  {
    timeout: 10_000,
    maxWait: 5_000,
    isolationLevel: 'Serializable',
  },
);
```

구현 원칙:

1. extended client의 공개 interactive `$transaction(callback, options)`을 helper가 연다.
2. callback이 받은 공식 `tx`를 전용 `AsyncLocalStorage`에 바인딩한다.
3. 사용자 callback에도 같은 `tx` 또는 타입 보존 audited facade를 전달한다.
4. query extension의 pre-read, post-read, audit INSERT는 ALS에 바인딩된 동일 `tx`를 사용한다.
5. 업무 mutation은 기존처럼 해당 tx의 `query(args)` continuation을 사용한다.
6. atomic 모드에서는 `tryAuditLog`처럼 오류를 삼키지 않는다.
7. tx context가 없는 atomic tracked write는 mutation 전에 명시적 오류를 낸다.
8. `_createItxClient`와 `__internalParams`를 안정 경로에서 사용하지 않는다.
9. Prisma 5/6/7의 타입 추론, timeout, maxWait, isolationLevel을 보존한다.
10. 중첩 transaction의 지원 여부와 오류 문구를 명시한다.

### 5.3 동시성 diff 계약

다음 중 하나를 결정해야 한다.

1. Serializable isolation을 기본으로 하고 serialization failure를 제한적으로 retry한다.
2. PK를 해석한 뒤 해당 row를 `FOR UPDATE`로 잠근다.
3. PostgreSQL trigger에서 `OLD/NEW`를 직접 캡처한다.
4. transaction atomicity만 보장하고 exact immediate-preimage는 별도 제한으로 문서화한다.

감사 로그의 핵심 질문이 "누가 무엇을 어떤 값에서 어떤 값으로 바꿨나"이므로 4번은 장기
해결책으로 권장하지 않는다. 어떤 선택이든 같은 row를 동시에 수정하는 E2E가 release gate에
포함되어야 한다.

## 6. 단계별 구현 계획

### Phase 0 — 즉시 위험 커뮤니케이션

- [x] `nestarc.dev`에서 automatic tracking을 `Preview`로 표시한다.
- [x] package landing, installation, auto-tracking 문서 첫 화면에 비원자 경고를 추가한다.
- [x] 사이트가 package-level 상태만 지원하므로 전체 카탈로그 상태를 `Preview`로 내리고,
      landing에서 manual log/query/retention 등 기존 지원 capability와 automatic tracking의
      Preview 범위를 구분한다.
- [x] CHANGELOG의 "transaction E2E coverage"가 원자성 보장을 의미하지 않도록 문구를 수정한다.
- [x] 오래된 v0.2 roadmap/spec 상태(`Proposed`, `Draft`)와 이미 출시된 0.3.0의 관계를 정리한다.

완료 조건: 새 사용자가 자동 success 행을 caller commit 증거로 오해할 수 없어야 한다.

#### Phase 0 완료 기록 (2026-08-20)

완료 조건을 다음과 같이 구현했다.

- 패키지 `README.md` 첫 화면에 automatic tracking Preview 경고와
  `AuditService.log(input, tx)` 대체 경로를 추가했다.
- `CHANGELOG.md`의 v0.2.0 transaction E2E 항목을 원자성 release gate가 아닌 현재
  best-effort 동작의 characterization coverage로 정정하고 Unreleased 경고를 추가했다.
- v0.2.0 roadmap과 6개 상세 spec을 historical planning/implementation 문서로 표시하고,
  현재 계약은 README/CHANGELOG, 미해결 작업은 이 계획 문서를 따르도록 연결했다.
- sibling `nestarc.dev`의 audit-log 카탈로그 상태를 package-level `Preview`로 변경하고 생성형
  package matrix를 갱신했다.
- sibling 사이트의 package landing, installation, auto-tracking 첫 화면과 changelog에
  비원자 경고를 추가했다. Landing은 manual log with explicit tx, query, retention,
  partitioning, schema utilities의 기존 지원 범위와 automatic tracking Preview를 구분한다.
- 패키지와 사이트에 회귀 테스트를 추가하여 경고, 안전한 대체 경로, historical 상태,
  catalog Preview가 제거되거나 완화되지 않도록 했다.

검증 결과:

```text
npm test -- --runInBand
Test Suites: 15 passed, 15 total
Tests:       234 passed, 234 total

npm run build
성공

# ../nestarc.dev
npm run catalog:test
Tests: 69 passed, 69 total

npm run docs:build
VitePress build 성공

git diff --check
두 저장소 모두 성공
```

Phase 0는 문서·상태 커뮤니케이션만 변경하므로 PostgreSQL E2E는 실행하지 않았다. 런타임
원자성 구현과 PostgreSQL release gate는 각각 Phase 1과 Phase 2의 완료 조건으로 남아 있다.

### Phase 1 — 안정된 transaction-first API

- [x] 최종 API 이름과 타입을 확정한다.
- [x] transaction client용 전용 ALS context를 추가한다.
- [x] `withAuditTransaction()`을 구현한다.
- [x] atomic path가 pre/post-read와 INSERT에 동일 tx를 사용하도록 extension을 수정한다.
- [x] atomic path에서 audit 오류를 fail-closed로 처리한다.
- [x] atomic path의 silent fallback을 금지한다.
- [x] helper 밖 atomic tracked mutation을 business query 전에 차단한다.
- [x] timeout/maxWait/isolationLevel 전달과 타입 추론을 보존한다.
- [x] `experimentalTxAudit` deprecation/제거 계획을 CHANGELOG에 기록한다.
- [x] 기존 best-effort 동작은 명시적 consistency mode로만 유지한다.

완료 조건: private Prisma API 없이 caller transaction과 자동 감사가 함께 commit/rollback한다.

#### Phase 1 완료 기록 (2026-08-21)

구현 전 결정을 다음과 같이 확정했다.

1. 공개 팩토리는 `createAuditedClient(basePrisma, options)`, transaction 진입점은 반환
   client의 `withAuditTransaction(callback, options)`으로 정했다. 기존
   `createAuditExtension()`도 동일 helper를 런타임에 제공하지만 타입 추론을 보존하는 권장
   진입점은 `createAuditedClient()`다.
2. `consistency`는 필수이며 `atomic-required | best-effort` 두 값만 허용한다. 0.x 단계에서
   즉시 명시적 선택으로 전환하고 이 변경을 CHANGELOG의 Breaking Changes에 기록했다.
3. `atomic-required`는 helper가 연 공식 Prisma interactive transaction client를 전용
   `AsyncLocalStorage`에 바인딩한다. tracked mutation의 query continuation, pre/post-read,
   INSERT가 같은 tx를 사용하며 private Prisma API나 base-client fallback을 사용하지 않는다.
4. atomic audit read/insert/context 실패는 원래 오류를 보고한 뒤 다시 throw하여 transaction을
   rollback한다. 실패한 업무 mutation의 failure audit은 같은 transaction에 영속될 수 없으므로
   atomic 모드에서는 시도하지 않는다.
5. helper 밖 atomic tracked write는 business query 전에 오류를 내며 nested helper 호출도
   명시적으로 거부한다. callback이 lazy PrismaPromise를 직접 반환해도 ALS 범위를 유지하도록
   helper 내부에서 callback 결과를 await한다.
6. `timeout`, `maxWait`, `isolationLevel`을 그대로 전달하고 공개 타입 테스트로 transaction
   callback/result 추론을 고정했다.
7. `experimentalTxAudit`은 `best-effort` 전용 deprecated 호환 경로로 남겼고
   `atomic-required`와의 동시 설정을 거부한다. 제거 시점은 다음 minor의 실제 peer matrix 결과를
   확인한 뒤 결정한다.
8. 동시성 전략은 Phase 2에서 PK 대상 row lock(`FOR UPDATE`)을 우선 구현·검증한다. Phase 1은
   transaction atomicity와 transaction-local sequential diff를 보장하지만 concurrent writer의
   exact immediate-preimage까지 지원한다고 광고하지 않는다.

추가한 PostgreSQL release gate는 운영 기본 trigger enforcement에서 helper 밖 차단, 정상
create commit, transaction-local create→update diff, delete, 강제 rollback, audit INSERT 실패
rollback을 결정적으로 검증한다. 전체 검증 결과는 이 문서의 Phase 1 변경 기록과 함께 유지한다.

검증 결과:

```text
npm test -- --runInBand
Test Suites: 15 passed, 15 total
Tests:       241 passed, 241 total

npm run build
성공

npm run test:e2e
Test Suites: 8 passed, 8 total
Tests:       42 passed, 42 total

git diff --check
성공
```

로컬 E2E 기준은 PostgreSQL 16, Node.js 24, NestJS 11, Prisma 7.9.1이다. Prisma 5/6 및
NestJS 10 조합은 기존 CI peer matrix에서 검증하며, Phase 2의 전체 matrix release gate로
계속 추적한다.

### Phase 2 — PostgreSQL 원자성 및 동시성 release gate

새 파일 후보: `test/e2e/transactions-atomic.e2e-spec.ts`.

- [x] create 정상 commit: 업무 1건 + 감사 1건 + 정확한 diff.
- [x] update 정상 commit: 정확한 immediate before/after.
- [x] delete 정상 commit: 업무 0건 + before-only 감사.
- [x] create/update/delete 강제 rollback: 업무 상태 원복 + 감사 0건.
- [x] 한 tx 안의 create -> update: 두 감사 행과 정확한 각 diff.
- [x] 한 tx 안의 여러 update: 각 단계의 before/after 정확성.
- [x] audit INSERT 실패: 업무 mutation 포함 전체 rollback.
- [x] pre-read/post-read 실패: atomic 모드의 공개 오류 계약 확인.
- [x] commit 전 base client에서 업무/감사 모두 비가시.
- [x] 정상 commit 후 업무/감사 모두 가시.
- [x] same-row concurrent writers: row lock 후 재조회로 정확한 diff.
- [x] 기본 운영 DDL인 trigger enforcement와 함께 실행.
- [x] atomic suite를 Nest 10/11 x Prisma 5/6/7 peer matrix의 `npm run test:e2e`에 포함.

기존 orphan/stale 테스트는 best-effort 전용 characterization suite로 이름과 설명을 명확히
바꾸고, atomic suite는 정확한 `0`/`1` counts를 단언하는 release blocker로 설정한다.

#### Phase 2 완료 기록 (2026-08-21)

동시성 계약과 release gate를 다음과 같이 확정했다.

1. `atomic-required`의 단건 update/delete/upsert는 기존 pre-read로 대상 PK를 해석한 뒤 같은
   transaction에서 PostgreSQL `SELECT ... FOR UPDATE`를 실행하고, 잠금 획득 후 PK로 preimage를
   다시 조회한다. 업무 mutation과 post-read/audit INSERT는 잠금을 보유한 같은 transaction에서
   이어진다.
2. 따라서 다른 writer가 먼저 row lock을 보유하면 기다린 뒤 그 writer가 commit한 값을
   immediate before로 기록한다. 높은 isolation level에서 PostgreSQL이 serialization failure를
   선택하면 잘못된 diff를 commit하지 않고 transaction 전체가 실패한다.
3. Prisma 7 `prisma-client` generator는 공개 `Prisma.dmmf`에 `@@map`/field mapping 정보를
   제공하지 않는다. private runtime data model을 읽지 않기 위해 공개 `databaseMapping` 옵션을
   추가했다. mapped table/schema/PK column을 사용하는 모델은 metadata를 공개 DMMF에서 얻을 수
   없는 client에서 이 옵션을 지정하며, 누락/오설정은 business mutation 전에 fail-closed한다.
4. atomic E2E를 12개 release-blocking case로 확장했다. 정상 create/update/delete, 한 tx의
   create→update 및 다단 update, create/update/delete 일괄 rollback, audit INSERT failure,
   extension fault injection에 의한 pre/post-read failure, commit 전 base-client 비가시성,
   commit 후 동시 가시성을 정확한 count와 diff로 검증한다.
5. same-row concurrency test는 첫 writer가 update 후 transaction을 유지한 상태에서 두 번째
   writer가 `FOR UPDATE`에 실제 대기 중임을 `pg_stat_activity`로 확인하고 첫 writer를 release한다.
   결과 diff는 `Initial → Writer One`, `Writer One → Writer Two`로 결정적으로 단언한다.
6. atomic suite는 운영 기본 trigger enforcement를 재적용해 실행한다. 기존 transaction suite는
   `best-effort transaction characterization E2E`로 이름을 변경하여 orphan/stale 허용 테스트가
   원자성 보장으로 오해되지 않게 했다.
7. `.github/workflows/ci.yml`의 peer matrix는 Nest 10/11 x Prisma 5/6/7 여섯 조합에서 전체
   `npm run test:e2e`를 실행하므로 새 atomic suite도 모두의 release gate에 포함된다.

검증 결과:

```text
npm test -- --runInBand
Test Suites: 15 passed, 15 total
Tests:       243 passed, 243 total

npm run build
성공

npm run test:e2e
Test Suites: 8 passed, 8 total
Tests:       48 passed, 48 total

git diff --check
성공
```

로컬 PostgreSQL 검증 환경은 PostgreSQL 16, Node.js 24, NestJS 11, Prisma 7.9.1이다. 여섯
peer 조합은 새 suite가 연결된 CI matrix의 필수 release gate이며, 실제 릴리스/merge 전 CI
성공을 별도로 확인한다.

### Phase 3 — array transaction 및 bulk mutation 계약

초기 권장안:

- atomic 모드에서는 `$transaction([...])`을 지원한다고 광고하지 않는다.
- `withAuditTransaction()` callback 안의 순차 mutation을 권장한다.
- 감지가 가능하면 명확한 오류를 내고, 감지가 불가능하면 지원 경계를 문서화한다.

bulk mutation 결정 사항:

- 현재 `createMany/updateMany`는 `targetId: null`, 빈 diff, count-only summary를 기록한다.
- `deleteMany`는 행별 기록 경로를 사용하지만 transaction 및 실패 semantics를 다시 검증해야 한다.

작업:

- [ ] summary-only를 유지할지 atomic 모드에서 거부할지 결정한다.
- [ ] `createManyAndReturn/updateManyAndReturn` 지원 범위를 검토한다.
- [ ] 레코드별 감사에 `maxBatchRecords`와 overflow 정책을 둔다.
- [ ] 성공, 후반 실패, audit 실패, rollback을 실제 PostgreSQL로 검증한다.
- [ ] count-only 로그를 "who changed what" 증거로 오해하지 않도록 action/metadata를 정의한다.

### Phase 4 — soft-delete 교차 패키지 원자성

대상 저장소:

- 현재 저장소: `nestjs-audit-log`
- sibling 저장소: `nestjs-soft-delete`
- 문서 저장소: `nestarc.dev`

작업:

- [ ] 지원하는 extension 적용 순서를 하나로 고정한다.
- [ ] event listener가 아닌 동일 tx 통합 지점을 설계한다.
- [ ] action naming을 확정한다. 예: `Model.softDeleted`, `Model.restored`, `Model.purged`.
- [ ] soft-delete tx client 또는 audit hook을 lifecycle payload에 전달할지 결정한다.
- [ ] cascade의 행별/summary semantics를 정한다.
- [ ] commit/rollback, restore, repeated operation, purge, cascade, bulk E2E를 추가한다.
- [ ] tenant/soft-delete/audit 세 extension의 조합을 실제 PostgreSQL로 검증한다.

완료 조건: 문서에 제시된 공식 조합에서 soft-delete mutation과 감사 행이 항상 함께
commit/rollback하며 action과 diff가 결정적이어야 한다.

### Phase 5 — 감사 제품 기본 무결성 보강

CSV/SIEM 전에 다음을 별도 이슈로 닫는다.

- [ ] nested writes 미지원 범위를 좁히거나 원자적으로 기록한다.
- [ ] 중첩 JSON PII redaction을 지원한다. 현재는 최상위 exact key 위주다:
      `src/prisma/diff.ts:23-49`.
- [ ] UPDATE/DELETE 외 TRUNCATE, table owner 우회, 권한 분리/REVOKE 운영 가이드를 추가한다.
- [ ] retention flat prune의 trigger/RULE catalog 조회를 대상 table OID로 제한한다:
      `src/services/audit.service.ts:503-517`.
- [ ] flat prune rollback, trigger 재활성, detach, dry-run, 경계 partition 보존을 실제 PostgreSQL로
      검증한다.
- [ ] `olderThan`, timeout, maxWait 입력 유효성을 검사한다.

### Phase 6 — tenant-scoped streaming export 및 CSV

현재 `query()`는 newest-first 사용자 조회 API다. 외부 전송에는 forward checkpoint scan이
필요하므로 adapter마다 `query()` 반복 로직을 만들지 않는다.

공유 primitive 초안:

```ts
type AuditExportScope =
  | { tenantId: string; allTenants?: never }
  | { allTenants: true; tenantId?: never };

type AuditScanOptions = AuditExportScope & {
  action?: string;
  actorId?: string;
  targetType?: string;
  targetId?: string;
  from?: Date;
  to?: Date;
  batchSize?: number;
  after?: string;
  until?: string;
  signal?: AbortSignal;
};

interface AuditScanPage {
  entries: AuditEntry[];
  checkpoint: string | null;
  highWatermark: string;
}

scan(options: AuditScanOptions): AsyncIterable<AuditScanPage>;
```

원칙:

- export/stream에서는 ambient tenant scope를 허용하지 않는다.
- `tenantId` 또는 의도적인 `allTenants: true`를 타입과 런타임 모두에서 강제한다.
- COUNT를 실행하지 않는다.
- high-watermark를 고정하여 export 도중 삽입된 행 때문에 범위가 흔들리지 않게 한다.
- CSV는 전체 배열 반환이 아니라 backpressure-aware `Readable`/serializer로 제공한다.
- RFC 4180 escaping, versioned columns, canonical JSON, Excel formula injection 방어를 포함한다.
- HTTP endpoint, 파일 저장, S3 업로드 job은 host application의 책임으로 둔다.

### Phase 7 — durable log stream core와 adapter

write path에서 SIEM callback을 직접 호출하지 않는다. commit된 audit table을 비동기로 tail한다.

필수 운영 계약:

- at-least-once delivery
- audit entry ID 기반 멱등성
- batch ACK 뒤 checkpoint 저장
- retry/backoff 및 `Retry-After`
- terminal 4xx와 DLQ/실패 상태
- backpressure
- tenant별 filter와 redaction
- metrics 및 error hook
- slowest required checkpoint보다 앞선 retention prune 방지 또는 detach-first 운영 절차

구현 순서:

1. generic HTTP JSON/NDJSON sink
2. S3/object storage sink
3. Datadog/Splunk provider mapping
4. 필요 시 Snowflake/GCS 등 추가

스케줄링은 라이브러리 내부에 넣지 않고 host의 cron/BullMQ가 one-shot runner를 호출한다.

## 7. 외부 제품 근거와 해석 범위

공식 문서에서 확인한 기능:

- WorkOS CSV export: organization, 기간 및 filter 기반 비동기 CSV export
  - https://workos.com/docs/audit-logs/exporting-events
- WorkOS Log Streams: Datadog, Splunk, Snowflake, S3, GCS, generic HTTP
  - https://workos.com/docs/audit-logs/log-streams
- WorkOS retention/configuration
  - https://workos.com/docs/reference/audit-logs/configuration
- Pangea Secure Audit Log: search, CSV download, retention tier, forwarding
  - https://pangea.cloud/docs/audit/using-secure-audit-log/log-viewer
  - https://pangea.cloud/docs/audit/getting-started/settings
- Auth0 Log Streams: at-least-once delivery, retry, stream health
  - https://auth0.com/docs/customize/log-streams

해석 시 주의:

- 위 제품은 managed service이고 현재 패키지는 로컬 NestJS/PostgreSQL 라이브러리다.
- 이 비교는 CSV와 외부 전달이 고객 가치가 있음을 보여주지만 provider adapter를 트랜잭션
  정합성보다 먼저 구현해야 한다는 근거는 아니다.
- 정확한 표현은 "검색과 retention은 이미 존재하고 CSV와 외부 전달이 제품 격차"다.

## 8. CI 및 검증 현황

현재 CI는 다음 환경에서 PostgreSQL E2E를 실행하도록 설정되어 있다.

- PostgreSQL 16
- Node.js 20.19, 22.12, 24
- NestJS 10/11
- Prisma 5/6/7

근거: `.github/workflows/ci.yml:9-143`.

2026-08-20 조사 세션에서 직접 실행한 결과:

```text
npm test -- --runInBand
Test Suites: 15 passed, 15 total
Tests:       233 passed, 233 total
```

로컬 Docker daemon이 실행 중이지 않아 PostgreSQL E2E는 이 조사 세션에서 재실행하지 못했다.
이는 제품 테스트 부재를 뜻하지 않으며, 다음 구현 세션에서는 Docker를 켠 뒤 반드시 atomic
suite를 포함한 E2E를 실행해야 한다.

## 9. 권장 검증 명령

먼저 현재 상태를 확인한다.

```bash
git status --short
git log -1 --oneline --decorate
npm test -- --runInBand
npm run build
```

Docker daemon이 준비된 뒤 로컬 PostgreSQL E2E를 실행한다.

```bash
npm run docker:up
npm run prisma:test:push
npm run prisma:test:generate
npm run test:e2e
npm run docker:down
```

주의:

- 현재 `test:e2e:full`은 실패 시 teardown을 자동 보장하지 않는다.
- 로컬 compose는 healthcheck 없이 고정 `sleep 2`에 의존한다. 향후 `healthcheck`와
  `docker compose up --wait` 기반으로 보강한다.
- transaction suite 일부는 운영 기본 trigger가 아니라 legacy RULE enforcement를 사용한다.
  atomic release gate는 기본 trigger DDL에서도 실행한다.

## 10. 완료 정의

automatic tracking을 다시 `Supported`로 올리기 위한 최소 완료 조건:

1. 공개 Prisma API만 사용하는 transaction-first helper가 있다.
2. atomic mode가 기본 또는 명확한 권장 경로다.
3. atomic mode에는 silent best-effort fallback이 없다.
4. create/update/delete commit 및 rollback이 실제 PostgreSQL에서 결정적으로 검증된다.
5. rollback 뒤 automatic success 행은 정확히 0건이다.
6. transaction 내부 diff가 정확하다.
7. audit statement 실패 시 business mutation도 rollback된다.
8. concurrency diff 계약이 구현·검증·문서화된다.
9. array transaction은 지원 또는 명시적 거부 중 하나로 결정적이다.
10. soft-delete/restore/purge 공식 조합이 동일 tx에서 검증된다.
11. Prisma 5/6/7 x Nest 10/11 CI가 통과한다.
12. README, CHANGELOG, API reference, `nestarc.dev`가 같은 계약을 설명한다.

CSV/SIEM 작업은 위 1-8을 충족하기 전 시작하지 않는다. 외부 전송은 잘못된 감사 행의 영향
범위를 확대하기 때문이다.

## 11. 구현 전 결정이 필요한 항목

다음은 코드 작성 전에 짧은 ADR 또는 issue comment로 결정한다.

1. API 이름: `withAuditTransaction`, `audit.transaction`, `createAuditedClient` 중 선택.
2. consistency 이름과 기본값: `atomic-required`/`best-effort` 등.
3. 마이그레이션: 즉시 breaking change 또는 1-release deprecation.
4. concurrency 전략: Serializable+retry, row lock, DB trigger.
5. array `$transaction([...])` 지원 여부.
6. bulk mutation의 행별/summary semantics와 record cap.
7. soft-delete action naming과 cascade 기록 단위.
8. capability-level Preview 표시를 사이트가 지원할지 여부.
9. `experimentalTxAudit` 제거 시점.

## 12. 다음 세션 시작 절차

1. 이 문서와 `README.md:337-349`의 Transaction Model을 읽는다.
2. `git status --short`로 사용자 변경을 확인하고 보존한다.
3. `git log -1`이 기준 커밋 이후라면 다음 심볼을 다시 찾는다.

```bash
rg -n "experimentalTxAudit|resolveAuditClient|createAuditExtension|tryAuditLog" src test
rg -n "transaction consistency|orphan|stale|soft-delete" test docs README.md
```

4. **11. 구현 전 결정이 필요한 항목** 중 1-4를 먼저 확정한다.
5. Phase 1의 최소 API와 atomic E2E 한 건(create rollback -> 업무 0, 감사 0)을 함께 구현한다.
6. 단위 테스트만 통과한 상태에서 완료로 보지 말고 Docker PostgreSQL E2E를 실행한다.
7. atomic suite가 통과한 뒤 update/delete/diff/concurrency로 확장한다.
8. Phase 0에서 반영한 `nestarc.dev` Preview와 경고 문구가 유지되는지 회귀 테스트로 확인한다.

## 13. 범위 밖 또는 별도 추적 항목

- 포트폴리오 전체에서 어느 패키지를 먼저 고칠지에 대한 사용량/사고 노출 비교
- 관리형 audit-log UI 또는 Admin Portal
- 라이브러리 내부 scheduler
- 다중 데이터베이스 지원
- PostgreSQL 외 storage engine
- 법률/컴플라이언스 인증 자체의 보장

`audit-log`가 "전체 패키지 중 무조건 1순위"라는 결론은 포트폴리오 비교 없이는 단정할 수
없다. 다만 감사 데이터 무결성만 기준으로는 최우선 수정 후보가 맞다.
