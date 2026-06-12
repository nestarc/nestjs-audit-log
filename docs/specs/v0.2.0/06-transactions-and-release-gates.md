# v0.2.0 Spec — Transaction Consistency & Release Gates

Date: 2026-06-11
Status: Draft
Roadmap items: #5 (트랜잭션 정합성 최소 대응), Release Gates 1–6

## Goal

1. 자동 감사 경로가 호출자 소유 `$transaction`과 어떻게 상호작용하는지에 대한 **정직한 계약**을
   확립한다: interactive transaction의 고아 행(orphan-row) 동작과 batch rollback의
   no-success-row 동작을 문서·테스트로 고정하고(Tier 1·2),
   Prisma가 내부적으로 노출하는 범위 안에서 트랜잭션 경유 라우팅을 **실험적 옵트인**으로
   제공한다(Tier 3).
2. 검증 보고서가 "0.2.0 전 추가"로 명시한 6개 Release Gate를 구체적인 테스트 파일과
   CI 변경으로 확정한다. 각 게이트는 이 스펙 및 형제 스펙들의 Behavior 번호에 매핑되어
   출시 차단 기준으로 작동한다.

## Background

### 현재 트랜잭션 동작 (코드 근거)

0.1.0 검증 보고서 Finding 1(`docs/2026-04-04-v0.1.0-validation-report.md:37-43`)은
당시 확장이 `query(args)`를 무시하고 뮤테이션을 재실행해 **비즈니스 행까지** 롤백을
이탈한다고 지적했다. 현재 코드는 부분적으로 개선되어, 모든 핸들러가 가로챈
`query(args)` 연속(continuation)을 그대로 실행한다
(`src/prisma/audit-extension.ts:137, 187, 241, 284, 341, 367, 399`). 따라서 **비즈니스
쓰기 자체는 호출자 트랜잭션에 참여하고 롤백된다.**

그러나 감사 측 쿼리는 여전히 전부 트랜잭션 밖이다:

- 확장 정의 시점에 캡처된 base client가 모든 감사 측 작업에 쓰인다
  (`src/prisma/audit-extension.ts:126` — `Prisma.defineExtension((client: any) => ...)`).
- 감사 INSERT: `insertAuditLog`가 `client.$executeRaw`로 실행
  (`src/prisma/audit-extension.ts:65-92`). 호출자 tx가 롤백되어도 이 INSERT는 별도
  커넥션에서 autocommit으로 영구 보존된다 — **일어나지 않은 변경의 감사 행**.
- pre-read: update/delete/upsert의 `findFirst`, deleteMany의 `findMany`가 base client로
  실행(`src/prisma/audit-extension.ts:183-185, 237-239, 280-282, 395-397`) → 트랜잭션
  내에서 변경 중인 행에 대해 **커밋된(트랜잭션 이전) 상태**를 읽는다.
- post-read(canonical 재조회): create `:149-152`, update `:191-196`, upsert `:293-298` —
  역시 base client. READ COMMITTED 격리에서 열린 tx의 미커밋 변경을 볼 수 없으므로,
  tx 내 update의 after-상태가 변경 전 값으로 읽혀 **diff가 빈 객체가 된다**
  (`computeUpdateChanges(before=old, afterCanonical=old)` → `{}`).

반면 수동 경로는 이미 올바른 계약을 갖고 있다: `AuditService.log(input, tx?)`가
명시적 tx 클라이언트를 받아 트랜잭션에 참여한다(`src/services/audit.service.ts:21-22`,
README.md:158-163).

### 문서와 실제의 모순

- 설계 문서 248행: "audit_logs INSERT는 원본 쿼리와 같은 batch transaction으로 실행 →
  원자성 보장"(`docs/2026-04-04-audit-log-design.md:248`) — **거짓**. 같은 문서
  210행("audit_logs INSERT (같은 트랜잭션)")도 동일하게 틀렸다.
- README 20행: "Caller transaction aware — automatic tracking participates in caller's
  `$transaction`; audit insert is best-effort" — 비즈니스 쓰기에 한해서만 참. "best-effort"가
  롤백 시 고아 행을 남긴다는 의미임을 어디에도 말하지 않는다. Transaction Model 표
  (README.md:204-212)도 동일.
- 검증 보고서 평결 "Status: hold external release"(`docs/2026-04-04-v0.1.0-validation-report.md:17`)와
  0.1.0 출시 사실(`CHANGELOG.md:8` — `[0.1.0] - 2026-04-05`, npm 배지)이 미해소 모순.

### Prisma extension에서 interactive transaction 클라이언트 접근 가능성 조사

Prisma 5.x/6.x 런타임 기준 조사 결과:

1. **공식 API 없음.** query extension 콜백은 `{ model, operation, args, query }`만 공식
   인자로 받는다. 트랜잭션 클라이언트(`tx`)는 어떤 공식 경로로도 콜백에 노출되지
   않는다. 이를 요구하는 업스트림 feature request(prisma/prisma#18276 계열)는
   장기 미해결 상태다.
2. **비공식 internals로 '감지'는 가능.** 콜백에 전달되는 객체에는 문서화되지 않은
   `__internalParams`가 포함되며, 내부 요청 파라미터(`transaction` 디스크립터 —
   interactive tx의 경우 `kind: 'itx'` + id, 배열형의 경우 `kind: 'batch'`)를 담는다.
   이것으로 "지금 호출자 tx 안에서 실행 중인가"의 신뢰성 있는 감지는 가능하다.
3. **'라우팅'은 버전 의존 내부 API가 필요.** `transaction` 디스크립터로부터 실행 가능한
   tx 바운드 클라이언트를 얻는 방법(과거 일부 5.x의 `_createItxClient`, 내부 `_request`에
   `transaction` 전달 등)은 전부 private이고 마이너 버전 간 형태가 다르다. 따라서 라우팅은
   **런타임 capability probe + 실패 시 안전 폴백** 구조로만 출시할 수 있고, 이것이 Tier 3를
   experimental로 한정하는 근거다. probe의 동작 여부는 G5 피어 매트릭스(Prisma 5/6)에서
   버전별로 검증한다.
4. **PostgreSQL 의미론적 한계.** 감사 측 statement를 호출자 itx 안으로 라우팅하면, 그
   statement가 에러를 내는 순간 PostgreSQL은 트랜잭션을 aborted 상태로 만든다(25P02).
   JS에서 catch해도 tx는 복구되지 않는다. 즉 tx 라우팅 모드에서는 "감사 실패가 비즈니스를
   깨지 않는다" 약속이 **트랜잭션 내부에서는 성립할 수 없다**. 이 트레이드오프는 숨기지
   않고 실험 모드의 문서화된 계약으로 명시한다.

결론: 0.2.0의 달성 가능 tier는 — Tier 1(문서 교정, 필수), Tier 2(현행 동작 회귀 테스트
베이스라인, 필수), Tier 3(`experimentalTxAudit` 옵트인, capability probe 성공 시에만 활성,
구현 가능성은 매트릭스에서 입증) 이다.

### Shared Decisions (applied)

이 스펙은 다음 고정 결정 위에서 작성되었다(재논의 없음):

- `AuditSharedOptions` / `AuditErrorContext` / `AuditLogger` 인터페이스와
  `onAuditError`, `logger` 옵션은 신뢰성 스펙(#3 — 스펙 02,
  `src/interfaces/audit-shared-options.interface.ts`)에서 정의된다. 이 스펙은 그 phase 값
  (`'pre-read' | 'insert' | 'post-read' | 'tenant-resolution' | 'context'`)을 그대로 사용한다.
- append-only 강제는 스펙 01의 `getAuditTableSQL({ enforcement: 'trigger' | 'rule' })`
  (기본 `'trigger'`, RULE은 레거시 문서화 모드)를 따른다. G4는 두 모드를 모두 검증한다.
- `tableName` 검증/보간 규칙은 스펙 01 소관. 이 스펙의 신규 테스트는 기본
  `'audit_logs'`를 사용한다.
- 배치 연산 충실도(#10)와 중첩 쓰기 풀 감사는 0.3.0 — 이 스펙은 경계 문서화와
  현행 동작 고정 테스트까지만 다룬다.

## Public API Changes

이 스펙의 코드 변경은 확장 옵션 1개 추가가 전부다. 나머지는 테스트·CI·문서.

현재 (`src/prisma/audit-extension.ts:11-17`):

```typescript
export interface AuditExtensionOptions {
  trackedModels?: string[];
  ignoredModels?: string[];
  sensitiveFields?: string[];
  /** Map of model name to primary key field name. Defaults to 'id'. */
  primaryKey?: Record<string, string>;
}
```

제안 (신뢰성 스펙의 `AuditSharedOptions` 확장 + 본 스펙의 실험 플래그):

```typescript
export interface AuditExtensionOptions extends AuditSharedOptions {
  trackedModels?: string[];
  ignoredModels?: string[];
  sensitiveFields?: string[];
  /** Map of model name to primary key field name. Defaults to 'id'. */
  primaryKey?: Record<string, string>;

  /**
   * EXPERIMENTAL — semver 보장 없음. true일 때, Prisma 내부 API로 호출자
   * interactive transaction을 감지·접근할 수 있으면 pre-read / post-read /
   * 감사 INSERT를 해당 트랜잭션 경유로 실행한다. 롤백 시 감사 행도 함께
   * 사라지고 트랜잭션 내 diff가 정확해지는 대신, 트랜잭션 내부에서 감사 측
   * statement 에러가 호출자 트랜잭션을 abort시킬 수 있다(PostgreSQL 25P02).
   * 내부 API를 사용할 수 없는 Prisma 버전에서는 1회 경고 후 기본 동작으로
   * 폴백한다. Default: false.
   */
  experimentalTxAudit?: boolean;
}
```

(본 스펙 추가분만 표기 — 최종 인터페이스에는 스펙 02의
`logFailures`/`ignoreTimestampOnlyUpdates`/`prismaModule`, 스펙 03의
`sensitiveFieldsByModel`이 추가로 합류한다. 스펙 02 §2의 최종 합류 목록과 일치.)

추가 devDependencies(런타임 API 아님): `supertest`, `@types/supertest` (G2 전용).

CI 워크플로 변경(G5): `.github/workflows/ci.yml`에 `peer-matrix` job 추가 — 아래
Behavior Specification / Test Plan 참조.

## Behavior Specification

### Tier 1 — 문서화된 고아 행 계약 (mandatory)

- B1. README의 "Transaction Model" 섹션(README.md:204-212)은 다음을 명시하는 표/문단으로
  교체된다: (a) 비즈니스 쓰기는 호출자 `$transaction`에 참여한다, (b) 자동 경로의 감사
  INSERT는 트랜잭션에 참여하지 **않으며**, 호출자 롤백 시 일어나지 않은 변경을 기록한
  감사 행이 영구 보존된다(고아 행), (c) 트랜잭션 내부의 update에 대한 before/after diff는
  커밋된 상태 기준이라 비거나 틀릴 수 있다, (d) 트랜잭션 정합성이 필요한 경우의 권장
  경로는 `AuditService.log(input, tx)` 수동 호출이다, (e) `experimentalTxAudit`의 존재와
  트레이드오프. 검증 가능 기준: 위 5개 항목이 각각 README에 문자 그대로 존재한다.
- B2. README Features의 "Caller transaction aware — ... audit insert is best-effort"
  불릿(README.md:20)은 "audit insert does not join the caller's transaction (orphan rows
  on rollback — see Transaction Model)" 취지의 문구로 교체된다.
- B3. 설계 문서의 "같은 트랜잭션/원자성 보장" 서술 2곳
  (`docs/2026-04-04-audit-log-design.md:210, 248`)이 best-effort 모델 서술로 수정되고,
  수정 사실이 문서 하단 변경 이력(또는 인라인 주석)에 날짜와 함께 남는다.
- B4. 검증 보고서(`docs/2026-04-04-v0.1.0-validation-report.md`)는 원문을 수정하지 않고,
  말미에 날짜 명기된 "Disposition (2026-06-11)" 부록을 추가한다: (a) "hold external
  release" 평결에도 불구하고 0.1.0이 2026-04-05 출시되었다는 사실 인정, (b) Finding 1은
  부분 해소(비즈니스 쓰기는 tx 참여, `src/prisma/audit-extension.ts:137` 등) + 잔여분은
  본 스펙 Tier 1/2/3으로 처리, (c) Finding 2→#4(스펙 03), Finding 3→#2/#4(스펙 02/03,
  옵션 표면), Finding 4→0.1.0에서 해소됨(`src/interceptors/audit.interceptor.ts:18` —
  `getAllAndOverride([handler, class])`, CHANGELOG.md:16), Finding 5→#6(스펙 02)으로의
  추적 매핑 표.

### Tier 2 — 현행 동작 회귀 베이스라인 (mandatory, `experimentalTxAudit` 미설정 기준)

- B5. 호출자 itx 내 `tx.user.create(...)` 후 강제 throw로 롤백하면: `users` 행은 존재하지
  않고, `action = 'User.created'`인 감사 행이 **1건 존재**한다(고아 행). 감사 행의
  `target_id`는 롤백된(존재하지 않는) 행의 PK 문자열이다.
- B6. 하나의 itx 안에서 create + update + delete를 수행하고 롤백하면, 각 연산에 대응하는
  감사 행이 모두 잔존한다(고아 행 N건).
- B7. itx가 아직 열려 있는 시점(커밋 전)에 base client로 `audit_logs`를 조회하면 해당
  연산의 감사 행이 이미 보인다 — 감사 INSERT가 트랜잭션에 참여하지 않음의 직접 증거.
- B8. 트랜잭션 **이전에 커밋된** 행을 itx 안에서 update하면, 커밋 후 감사 행의 `changes`는
  빈 객체 `{}`다(post-read가 base client로 변경 전 상태를 읽기 때문 —
  `src/prisma/audit-extension.ts:191-196`).
- B9. **같은 itx 안에서** create한 행을 이어서 update하면, pre-read `findFirst`가 null을
  반환하여(`src/prisma/audit-extension.ts:183-185`) `changes = {}`이고 `target_id`는
  `result[pkField]`에서 채워진다.
- B10. `AuditService.log(input, tx)`로 기록한 수동 감사 행은 호출자 tx 롤백 시 함께
  사라진다(`src/services/audit.service.ts:21-22` 계약의 회귀 고정).
- B11. 배열형 `$transaction([...])`(batch)에서 배치 전체가 실패하면, 개별 mutation
  extension 핸들러의 `await query(args)`는 성공 result로 resolve되지 않는다. 따라서 기본
  `logFailures: false` 자동 성공 감사 INSERT는 실행되지 않고, 배치 롤백 후 비즈니스 행과
  해당 성공 감사 행은 모두 0건이다(Prisma 6.19.3 관측 동작 고정).

주: B5–B9는 #3(스펙 02 — pre-read를 try 안으로 이동)과 동일 코드 경로를 공유한다.
테스트는 "감사 행 내용"이 아닌 위에 명시한 관측 가능 결과만 단언하여 스펙 02 구현
후에도 깨지지 않게 작성한다.

### Tier 3 — `experimentalTxAudit` (experimental, capability probe 성공 시에만 활성)

- B12. `experimentalTxAudit`이 미설정/false면 어떤 Prisma 내부 API에도 접근하지 않으며
  B5–B11의 동작이 그대로 유지된다.
- B13. `experimentalTxAudit: true`이고 런타임 probe가 성공하면(콜백 인자의
  `__internalParams.transaction`이 `kind: 'itx'`로 존재하고 tx 바운드 실행 수단 확보):
  pre-read, post-read, 감사 INSERT가 모두 호출자 tx 경유로 실행된다. 결과: (a) B5/B6
  시나리오에서 롤백 시 감사 행도 **0건**, (b) B8 시나리오에서 `changes`가 올바른
  before/after diff를 가진다, (c) B7 시나리오에서 커밋 전 base client 조회 시 감사 행이
  보이지 않는다.
- B14. `experimentalTxAudit: true`이지만 probe가 실패하면(내부 API 부재/형태 불일치):
  `(options.logger ?? console).warn`으로 **프로세스당 1회** "tx-aware audit unavailable on
  this Prisma version, falling back to best-effort" 경고를 내고 B5–B11 동작으로 폴백한다.
  throw하지 않는다.
- B15. `experimentalTxAudit: true` 활성 상태에서 tx 경유 감사 statement가 에러를 내면:
  에러는 catch되어 `onAuditError`로 해당 phase(`'pre-read'`/`'insert'`/`'post-read'`)와
  함께 보고되지만, PostgreSQL 트랜잭션은 이미 aborted 상태(25P02)이므로 호출자의 후속
  statement는 실패한다. 이 동작은 README 실험 섹션에 문서화되며 테스트는 문서화된
  결과(후속 statement 실패 + onAuditError 호출)를 단언한다.
- B16. `kind: 'batch'` 트랜잭션은 Tier 3 라우팅에서 제외된다 — itx가 아니면 감지되어도
  기본 동작으로 처리한다(라우팅 시도 없음, 경고 없음).

### Release Gates (출시 차단 기준)

각 게이트는 로드맵 Release Gates 1–6(`docs/2026-06-11-v0.2.0-roadmap.md:256-268`)에 1:1
대응한다.

- G1. **외부 트랜잭션 롤백 회귀 E2E** — 신규 파일 `test/e2e/transactions.e2e-spec.ts`가
  B5–B11을, `test/e2e/transactions-experimental.e2e-spec.ts`가 B12–B16을 검증한다
  (후자는 probe 미지원 환경에서 B14만 단언하고 나머지는 skip 처리). 검증 보고서 89행
  게이트 1 충족.
- G2. **실제 HTTP 미들웨어+인터셉터 경로 E2E** — 신규 파일
  `test/e2e/http-path.e2e-spec.ts`. supertest로 실제 요청을 보내 검증:
  (a) `AuditActorMiddleware`(`src/middleware/audit-actor.middleware.ts:13-16`)가 요청
  헤더 기반 actor를 감사 행에 기록, (b) `@NoAudit()` 라우트의 쓰기가 감사 미기록 —
  핸들러 레벨과 컨트롤러 클래스 레벨 각각, (c) `@AuditAction('...')` 오버라이드가 자동
  감사 행의 action에 반영, (d) correlation ID 헤더(기본 `x-request-id`)가
  `metadata.correlationId`로 저장(스펙 04 B10/B11), (e) async `actorExtractor`(스펙 04 B1)
  경유 요청도 (a)와 동일 결과. 스펙 04의 E2E E1–E4/E6은 이 파일에 수록한다.
  현재 E2E가 `AuditContext.run` 직접 호출로 우회하던 경로
  (`test/e2e/audit-log.e2e-spec.ts:106-120`, 검증 보고서 79행)의 실커버리지.
- G3. **upsert/createMany/updateMany E2E** — 신규 파일
  `test/e2e/batch-and-upsert.e2e-spec.ts`: (a) upsert create 분기 → `Model.created` 행 +
  after-only changes, (b) upsert update 분기 → `Model.updated` 행 + before/after diff,
  (c) upsert에 `select` 프로젝션 사용 시 `target_id` 비-null(스펙 02 B28/B31),
  (d) createMany/updateMany → count-only metadata 1행(0.3.0 #10 경계의 현행 동작 고정;
  count 값 일치 단언), (e) deleteMany 다건 개별 행(기존 테스트와 중복되면 기존 파일
  유지). 스펙 02의 T33·T34는 이 파일에 수록한다. 검증 보고서 80행 충족.
- G4. **append-only 강제 검증** — 신규 파일 `test/e2e/append-only.e2e-spec.ts`.
  스펙 01의 두 enforcement 모드 각각에 대해 별도 테이블(예: `audit_logs_rule_mode`,
  `audit_logs_trigger_mode`)을 `getAuditTableSQL({ tableName, enforcement })`로 생성 후:
  (a) rule 모드 — `UPDATE`/`DELETE`가 에러 없이 영향 행 0을 반환하고 원본 행 불변
  (침묵 no-op의 명시적 고정, 스펙 01 B9/B29), (b) trigger 모드 — `UPDATE`/`DELETE`가
  예외를 던지고(스펙 01 B28의 `P0001` `RAISE EXCEPTION`이 Prisma raw 실행에서 P2010으로
  표면화), 원본 행 불변, (c) 두 모드 모두 `INSERT`는 정상 동작. 스펙 01의 DDL Behavior
  (B8 트리거 생성 / B9 RULE 생성) 검증을 겸하며, 스펙 01 Test Plan의 E1–E4/E7과
  연동한다(게이트 사인오프는 본 스펙 G4가 소유, 중복 케이스는 머지 시 본 파일로 통합).
- G5. **CI 피어 매트릭스** — 현재 CI는 Node 18/20/22만 가변이고
  (`.github/workflows/ci.yml:13-15`) 피어 조합은 Nest 11 + Prisma 6 고정
  (`package.json:52-68` devDependencies)인 반면, README:11-15와
  `package.json:40-45`는 Nest 10/11 + Prisma 5/6을 광고한다. `ci.yml`에 `peer-matrix`
  job을 추가하여 4개 조합(Nest 10/11 × Prisma 5/6) 전부에서 build + unit + E2E를
  실행한다(아래 YAML). Nest 10 조합은 express 4 / `@types/express` 4와 짝지어 설치한다.
- G6. **문서 정합성** — B1–B4가 전부 머지되어야 한다. 추가로 README의 Transaction
  Model/Multi-Tenancy/옵션 표가 형제 스펙들의 최종 API와 일치하는지 출시 직전 1회
  교차 점검(하모나이저 체크리스트 항목). 체크리스트에는 로드맵 smaller fix 2건의
  소유 스펙 배정·머지 확인을 포함한다: (a) 중첩 관계 쓰기 경계 문서화(README
  "Nested writes" 섹션) + 감지 경고 W5 — **스펙 02 B45 소유**, (b) 커스텀 Prisma
  client output의 모듈 측(`AuditService`) 절반 — **스펙 02 B46 소유**(확장 측
  B41–B44와 합쳐 로드맵 항목 완결).

G5의 ci.yml 변경(발췌 — 기존 `test` job은 유지):

```yaml
  peer-matrix:
    runs-on: ubuntu-latest
    needs: test
    strategy:
      fail-fast: false
      matrix:
        include:
          - { nest: 10, prisma: 5, express: 4 }
          - { nest: 10, prisma: 6, express: 4 }
          - { nest: 11, prisma: 5, express: 5 }
          - { nest: 11, prisma: 6, express: 5 }
    services:
      postgres:
        image: postgres:16-alpine
        env: { POSTGRES_DB: audit_test, POSTGRES_USER: test, POSTGRES_PASSWORD: test }
        ports: ['5432:5432']
        options: >-
          --health-cmd "pg_isready -U test -d audit_test"
          --health-interval 5s --health-timeout 5s --health-retries 5
    env:
      DATABASE_URL: postgresql://test:test@localhost:5432/audit_test
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 20, cache: npm }
      - run: npm ci
      - name: Install peer combination
        run: |
          npm install --no-save \
            @nestjs/common@^${{ matrix.nest }} \
            @nestjs/core@^${{ matrix.nest }} \
            @nestjs/platform-express@^${{ matrix.nest }} \
            @nestjs/testing@^${{ matrix.nest }} \
            express@^${{ matrix.express }} \
            @types/express@^${{ matrix.express }} \
            @prisma/client@^${{ matrix.prisma }} \
            prisma@^${{ matrix.prisma }}
      - run: npx prisma generate --schema=test/e2e/prisma/schema.prisma
      - run: npm run build
      - run: npm test
      - run: npx prisma db push --schema=test/e2e/prisma/schema.prisma --skip-generate
      - run: npm run test:e2e
```

## SQL / DDL

이 스펙은 DDL을 추가하지 않는다(스키마 변형은 스펙 01 소관). G4가 사용하는 단언용
SQL만 명시한다:

```sql
-- rule 모드: 영향 행 0 기대 (침묵 no-op)
UPDATE audit_logs_rule_mode SET action = 'tampered' WHERE id = $1;   -- affected = 0
DELETE FROM audit_logs_rule_mode WHERE id = $1;                      -- affected = 0

-- trigger 모드: 예외 기대 (Prisma $executeRawUnsafe → P2010)
UPDATE audit_logs_trigger_mode SET action = 'tampered' WHERE id = $1; -- RAISE EXCEPTION
DELETE FROM audit_logs_trigger_mode WHERE id = $1;                    -- RAISE EXCEPTION
```

## Error Handling

| 상황 | 모드 | 처리 |
|------|------|------|
| 감사 INSERT 실패 (tx 밖, 현행) | 기본 | catch 후 `onAuditError({ phase: 'insert', model, operation, action, targetId, tenantId })` 보고(스펙 02 B16 경로), 비즈니스 결과 반환에 영향 없음 |
| pre-read/post-read 실패 (tx 밖) | 기본 | 스펙 02 B10–B14대로 catch → `onAuditError({ phase: 'pre-read' \| 'post-read', ... })`, 감사만 포기 |
| capability probe 실패 | experimental | `(options.logger ?? console).warn` 1회, 기본 동작 폴백, throw 없음 (B14). 고정된 `AuditErrorContext.phase` 열거에 트랜잭션 phase가 없으므로 `onAuditError`는 사용하지 않는다 |
| tx 경유 감사 statement 에러 | experimental | catch → `onAuditError(해당 phase)` 보고. 단 PostgreSQL tx는 이미 aborted(25P02) — 호출자 후속 statement 실패는 라이브러리가 막을 수 없으며 문서화된 계약이다 (B15) |
| batch tx 감지 | experimental | 라우팅 시도/경고 없이 기본 동작 (B16) |
| 옵션 동시 설정 (`experimentalTxAudit` + probe 불가 Prisma) | experimental | 팩토리 시점이 아닌 첫 감지 시점에 경고 — probe는 첫 itx 콜백에서만 판정 가능 |

어느 경로에서도 비즈니스 연산의 결과/예외를 변조하지 않는다(experimental 모드의
PG-abort 부수효과 제외 — 이는 라이브러리 throw가 아니라 DB 의미론이다).

## Test Plan

단위 테스트 (`test/`):

| 케이스 | 검증 Behavior |
|--------|---------------|
| `transactions-probe.spec.ts`: 콜백 인자에 `__internalParams.transaction(kind:'itx')` 모킹 → 라우팅 경로 선택 | B13 (선택 로직) |
| 동: `__internalParams` 부재/형태 불일치 → 1회 warn + 폴백, 두 번째 호출은 warn 없음 | B14 |
| 동: `kind:'batch'` → 라우팅 미시도 | B16 |
| 동: `experimentalTxAudit` 미설정 → internals 미접근(모킹 객체 프로퍼티 접근 추적) | B12 |

E2E 테스트 (`test/e2e/`, 실제 PostgreSQL):

| 파일 | 케이스 → Behavior | Release Gate |
|------|-------------------|--------------|
| `transactions.e2e-spec.ts` | create 롤백 고아 행(B5), 다중 연산 롤백 N건(B6), 커밋 전 가시성(B7), tx 내 update 빈 diff(B8), 동일 tx create→update(B9), 수동 log(tx) 롤백 동반(B10), batch rollback 성공 감사 행 0건(B11) | **G1** |
| `transactions-experimental.e2e-spec.ts` | probe 지원 시: 롤백 시 감사 행 0건 + 올바른 in-tx diff + 커밋 전 비가시성(B13), statement 에러 시 25P02 + onAuditError(B15); probe 미지원 시: 경고 후 폴백만 단언(B14), 나머지 skip | **G1** (experimental 분) |
| `http-path.e2e-spec.ts` (supertest) | actor 추출(a), @NoAudit 핸들러/클래스(b), @AuditAction(c), correlationId(d → 스펙 04 B10/B11), async extractor(e → 스펙 04 B1) | **G2** |
| `batch-and-upsert.e2e-spec.ts` | upsert create/update 분기, upsert+select 프로젝션(→ 스펙 02 B28/B31), createMany/updateMany count-only 고정(→ #10 경계) | **G3** |
| `append-only.e2e-spec.ts` | rule 침묵 no-op / trigger RAISE / INSERT 정상 (→ 스펙 01 B8/B9/B28/B29) | **G4** |

CI:

- `peer-matrix` job(위 YAML)이 4개 조합에서 위 전체 스위트를 실행 — **G5**.
  `transactions-experimental.e2e-spec.ts`의 probe 판정이 Prisma 5와 6에서 각각 어느
  분기(B13 vs B14)를 타는지 매트릭스 로그로 확인 가능해야 한다(테스트가 판정 결과를
  stdout에 1줄 출력).
- 문서 게이트 **G6**은 CI가 아닌 출시 체크리스트 항목: B1–B4 머지 확인.

기존 E2E의 RULE drop/recreate 정리 패턴(`test/e2e/audit-log.e2e-spec.ts:78-89`)은 신규
파일에서 재사용하되, 스펙 01 trigger 모드 테이블에는 trigger DISABLE/ENABLE 대신 별도
테이블 생성·폐기로 격리한다(운영 권장 경로를 테스트가 우회하는 모양을 만들지 않기 위함).

## Migration & Docs Impact

- CHANGELOG (0.2.0):
  - Added: `experimentalTxAudit` (experimental, no semver guarantee) — opt-in tx-aware
    audit routing with runtime capability probe and safe fallback.
  - Changed (docs): Transaction Model section rewritten — automatic audit inserts do
    **not** join caller transactions; orphan rows on rollback documented.
  - Added (tests/CI): transaction regression suite, real HTTP path E2E,
    upsert/batch E2E, append-only enforcement E2E, NestJS 10/11 × Prisma 5/6 peer matrix.
- README: Features 불릿(B2), Transaction Model 섹션(B1), 신규 "Experimental:
  transaction-aware auditing" 섹션(옵션 표에 `experimentalTxAudit` 행 추가, B15 경고 포함).
- 설계 문서: 210행·248행 수정(B3).
- 검증 보고서: Disposition 부록(B4).
- Breaking change 없음. `experimentalTxAudit`은 기본 off이며 semver 보장 제외를 옵션
  주석과 README 양쪽에 명시한다.

## Decisions

- D1. **Tier 3는 `experimentalTxAudit` 옵트인 + 런타임 capability probe로 출시한다.**
  근거: 공식 tx 클라이언트 노출이 업스트림에서 막혀 있고, 내부 API는 Prisma 마이너
  버전 간 비호환이다. probe 실패 시 폴백(B14)이 있으므로 어떤 환경에서도 회귀가 없다.
- D2. **experimental 모드는 read만이 아니라 감사 INSERT까지 tx로 라우팅한다.**
  근거: 로드맵 #5의 핵심 결함은 고아 행(거짓 증거)이다. read만 라우팅하면 diff는
  고쳐져도 고아 행이 남아 절반의 해결이다. INSERT 라우팅의 대가(B15의 tx-abort
  가능성)는 옵트인 + 문서화로 수용한다.
- D3. **probe 실패 경고는 `onAuditError`가 아닌 `logger.warn`으로 보고한다.**
  근거: `AuditErrorContext.phase` 열거는 고정 결정이며 트랜잭션 감지에 해당하는 phase가
  없다. 설정/환경 수준 진단은 에러 콜백이 아닌 로거의 영역이다.
- D4. **검증 보고서 모순은 원문 수정이 아닌 날짜 명기 부록으로 해소한다.**
  근거: 감사 도구의 문서가 사후 수정되는 선례를 만들지 않는다. 평결과 출시의 불일치
  자체를 기록으로 남기고 finding별 처리 현황을 매핑한다(B4).
- D5. **피어 매트릭스는 Node 20 단일, 별도 job, 4개 조합 전부 실행한다.** Nest 11 +
  Prisma 6 셀은 기존 `test` job과 중복이지만, 설치 경로(`npm install --no-save` 오버레이)가
  달라 디버깅 기준점으로 유지한다. Node 가변 매트릭스는 기존 job에 남긴다(비용 통제).
- D6. **Nest 10 조합은 express 4 / `@types/express` 4와 짝지어 설치한다.** 근거: Nest 10의
  platform-express는 express 4 기반이며, README가 광고하는 것은 "Nest 10 환경"이지
  "Nest 10 + express 5" 같은 비현실 조합이 아니다.
- D7. **Tier 2 테스트는 관측 가능 결과만 단언한다**(행 존재/부재, changes `{}`, 가시성
  타이밍). 근거: 스펙 02(#3 pre-read try 이동·onAuditError, #6 select PK 주입)가 같은
  핸들러를 수정하므로, 내부 호출 형태를 단언하면 베이스라인이 형제 스펙 구현에 의해
  깨진다.
- D8. **batch(`$transaction([...])`) 트랜잭션은 Tier 3 제외(B16).** 근거: batch는 지연
  실행 PrismaPromise 결합이라 콜백 시점에 라우팅할 실행 수단이 itx와 다르고, 사용
  빈도 대비 내부 결합 위험이 크다. 0.3.0에서 #10(배치 충실도)과 함께 재평가.

## Out of Scope

- 트랜잭션 풀 해결: 공식 tx-client 플러밍(업스트림 의존), transactional-outbox 모드 —
  수요와 업스트림 진행에 따라 0.3.0+ 재평가.
- 배치 연산 레코드별 충실도(#10), `*AndReturn` 후킹 — 0.3.0 (이 스펙은 G3에서 현행
  count-only 동작을 고정하는 것까지만).
- 중첩 관계 쓰기 **풀 감사** — 0.3.0. 0.2.0 범위인 경계 문서화 + 감지 경고(로드맵
  smaller fix)는 **스펙 02 B45가 소유**한다(배정 확정 — G6 체크리스트에서 머지 확인).
- 인-라이브러리 스케줄러, SIEM export, 해시 체인 — 로드맵 Out of Scope 승계.
- `experimentalTxAudit`의 안정화(semver 보장) — probe가 두 Prisma major에서 1개
  마이너 사이클 이상 안정 동작함이 매트릭스로 입증된 후 별도 결정.
