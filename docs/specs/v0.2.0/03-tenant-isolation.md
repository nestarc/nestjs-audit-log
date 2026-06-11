# v0.2.0 Spec — Tenant Isolation & Redaction

Date: 2026-06-11
Status: Draft
Roadmap items: #4 (테넌트 격리 정합성), Smaller fixes — 레다크션 강화

## Goal

자동 추적 경로에 `tenantRequired`를 실제로 적용해 0.1.0 검증 보고서가 release-blocking으로
지목한 fail-open(tenant_id NULL 행 기록, 무스코프 교차 테넌트 쿼리)을 제거한다.
`tenantResolver` 옵션으로 `@nestarc/tenancy` 강결합을 해소해 임의의 CLS 기반 테넌시와
연동 가능하게 한다(릴리스 노트 선두 기능). `query()`에 명시적 테넌트 필터와 의도적
교차 테넌트 모드를 추가한다. 레다크션을 모델별 필드 지정으로 확장하고
`AuditService.log()` metadata에도 적용한다.

**GDPR 근거**: audit_logs는 append-only(UPDATE/DELETE 차단)이므로 레다크션을 한 번
놓치면 PII가 영구 보존된다 — 사후 스크럽이 불가능하다. 따라서 레다크션은 쓰기 시점에
완결되어야 하며, 수동 로깅 metadata처럼 레다크션이 전혀 적용되지 않는 경로는 그 자체가
컴플라이언스 결함이다.

## Background

문제는 네 갈래이며 모두 현재 코드로 재검증했다.

1. **자동 경로의 `tenantRequired` 미적용**: `tenantRequired`는 수동 API에서만 검사된다
   (`src/services/audit.service.ts:25-29`의 `log()`, 같은 파일 55-60행의 `query()`).
   자동 경로의 `buildAuditInsertParams`(`src/prisma/audit-extension.ts:30-63`)는 52행에서
   `tenantId: getTenantId()`를 무조건 대입해, 테넌트 컨텍스트가 없으면 검사 없이
   tenant_id NULL 행을 기록한다. 검증 보고서 Finding 2가 지목한 fail-open의 잔존이다.

2. **`@nestarc/tenancy` 강결합**: `getTenantId()`(`src/utils/tenant.ts:3-29`)가
   `require.resolve('@nestarc/tenancy')` 프로브(4-11행, 모듈 레벨 캐시 `tenancyAvailable`
   1행) 후 `new TenancyContext().getTenantId()`(19-20행)를 직접 호출한다. 다른 테넌시
   구현(자체 CLS, nestjs-cls 등)을 쓰는 프로젝트는 테넌트 격리 기능 전체를 쓸 수 없다.
   tenancy가 설치되어 있으나 호출이 실패하면 21-27행에서 `console.warn` 후 null 반환 —
   역시 fail-open.

3. **`query()`의 무스코프 폴백**: 테넌트 컨텍스트 부재 + `tenantRequired: false`(기본값)
   조합에서 63-65행의 `if (tenantId)` 조건이 거짓이 되어 tenant predicate가 통째로
   빠진다 — 전 테넌트 결과 반환. 관리자 엔드포인트에 연결되는 순간 교차 테넌트
   노출이며, 의도적으로 교차 테넌트 조회를 하고 싶어도 명시적 수단이 없다(컨텍스트를
   "안 가진 채" 호출하는 우회뿐).

4. **레다크션 공백**: `sensitiveFields`는 전역·최상위·정확일치
   (`src/prisma/diff.ts:57, 72-73, 87`의 `sensitiveFields.includes(key)`)이고,
   `AuditService.log()`의 metadata는 레다크션 없이 그대로 직렬화된다
   (`src/services/audit.service.ts:30-32`). `User.password`를 가리려면 모든 모델의
   `password`를 전역으로 가려야 하고, 수동 로그에 `{ email: ... }`을 넣으면 영구
   보존된다.

> **Shared Decisions (applied)**: 본 스펙은 v0.2.0 공통 결정을 그대로 따른다 —
> (1) `AuditSharedOptions` 공유 인터페이스 + 모듈/확장 간 런타임 병합 없음(공유 상수
> spread 패턴 문서화), (2) `AuditErrorContext`/`AuditLogger` 형태, (6) 자동 경로
> `tenantRequired`는 감사 INSERT 스킵 + `onAuditError` 보고(비즈니스 진행),
> (7) `query()`의 `tenantId`/`allTenants`, (12) `sensitiveFieldsByModel` 병합 +
> manual log metadata 레다크션, 중첩 경로 매칭 제외.

## Public API Changes

### 1. 공유 인터페이스 (정의 소유: 스펙 02 — 본 스펙은 전재·소비만)

아래는 스펙 02의 canonical 정의를 그대로 전재한 것이다(필드별 JSDoc은 스펙 02 원문
참조; 수정 시 스펙 02가 우선한다):

```typescript
// src/interfaces/audit-shared-options.interface.ts (신규 — 스펙 02 소유)
export interface AuditLogger {
  warn(message: string): void;
  error(message: string): void;
}

export type AuditErrorPhase =
  | 'pre-read'
  | 'insert'
  | 'post-read'
  | 'tenant-resolution'
  | 'context';

export interface AuditErrorContext {
  phase: AuditErrorPhase;
  model?: string;
  operation?: string;
  action?: string;
  targetId?: string | null;
  tenantId?: string | null;
}

export interface AuditSharedOptions {
  tableName?: string;
  tenantRequired?: boolean;
  tenantResolver?: () => string | null;
  onAuditError?: (error: unknown, ctx: AuditErrorContext) => void;
  logger?: AuditLogger;
}
```

본 스펙이 소비하는 멤버는 `tenantRequired`, `tenantResolver`, `onAuditError`, `logger`.
`tableName`은 스펙 01 소관(검증·보간 규칙)이며 스펙 05가 조회 경로에 적용한다.
`index.ts` export 4종(`AuditSharedOptions`/`AuditErrorContext`/`AuditErrorPhase`/
`AuditLogger`) 추가는 스펙 02가 수행한다.

### 2. `AuditExtensionOptions` — src/prisma/audit-extension.ts:11-17

현재:

```typescript
export interface AuditExtensionOptions {
  trackedModels?: string[];
  ignoredModels?: string[];
  sensitiveFields?: string[];
  /** Map of model name to primary key field name. Defaults to 'id'. */
  primaryKey?: Record<string, string>;
}
```

제안 (본 스펙 추가분만 표기; `prismaModule` 등은 타 스펙):

```typescript
export interface AuditExtensionOptions extends AuditSharedOptions {
  trackedModels?: string[];
  ignoredModels?: string[];
  sensitiveFields?: string[];
  /** Per-model sensitive fields, union-merged with the global list. Keys are Prisma model names. */
  sensitiveFieldsByModel?: Record<string, string[]>;
  /** Map of model name to primary key field name. Defaults to 'id'. */
  primaryKey?: Record<string, string>;
}
```

### 3. `AuditLogModuleOptions` — src/interfaces/audit-log-options.interface.ts:4-9

현재:

```typescript
export interface AuditLogModuleOptions {
  prisma: any;
  actorExtractor: ActorExtractor;
  /** When true, query() throws if tenant context is unavailable. Default: false */
  tenantRequired?: boolean;
}
```

제안:

```typescript
export interface AuditLogModuleOptions extends AuditSharedOptions {
  prisma: any;
  actorExtractor: ActorExtractor;
  /** Redaction applied to AuditService.log() metadata. Same semantics as the extension copy. */
  sensitiveFields?: string[];
  sensitiveFieldsByModel?: Record<string, string[]>;
}
```

`tenantRequired`는 `AuditSharedOptions`로 이동(의미 동일, JSDoc은 자동 경로 스킵 의미를
포함하도록 갱신). 런타임 병합은 없다 — 모듈은 자기 복사본만 읽고 확장도 자기 복사본만
읽는다. 문서화되는 사용 패턴:

```typescript
const auditShared: AuditSharedOptions & {
  sensitiveFields: string[];
  sensitiveFieldsByModel: Record<string, string[]>;
} = {
  tenantRequired: true,
  tenantResolver: () => myCls.get('tenantId') ?? null,
  sensitiveFields: ['password'],
  sensitiveFieldsByModel: { User: ['ssn'], Payment: ['cardNumber'] },
  onAuditError: (err, ctx) => metrics.increment('audit.error', { phase: ctx.phase }),
};

AuditLogModule.forRoot({ prisma, actorExtractor, ...auditShared });
prisma.$extends(createAuditExtension({ trackedModels: [...], ...auditShared }));
```

### 4. 테넌트 해석 유틸 — src/utils/tenant.ts:3-29

현재:

```typescript
export function getTenantId(): string | null
/** @internal Reset cached probe for testing */
export function _resetTenancyProbe(): void
```

제안 (`getTenantId`는 `index.ts` 미export 내부 함수이므로 deprecation 없이 교체):

```typescript
/**
 * Resolves the current tenant id.
 * Fallback order: opts.tenantResolver → @nestarc/tenancy probe → null.
 * Exceptions thrown by the active source PROPAGATE to the caller —
 * each consumer decides fail-open vs fail-closed (see Behavior B5, B13).
 */
export function resolveTenantId(opts?: {
  tenantResolver?: () => string | null;
}): string | null;

/** @internal Reset cached probe for testing */
export function _resetTenancyProbe(): void;
```

캐시된 프로브의 운명: 모듈 레벨 `tenancyAvailable` 캐시(`src/utils/tenant.ts:1`)는
**유지**하되 폴백 경로 전용이 된다. `tenantResolver`가 제공되면 프로브는 아예 실행되지
않는다(`require.resolve` 호출 없음, 캐시 기록 없음). 프로브 결과는 기존과 동일하게
프로세스 전역에 1회 캐시되며, 프로세스 기동 후 tenancy를 늦게 설치해도 재프로브하지
않는다(기존 동작 유지). `_resetTenancyProbe()`는 테스트용으로 유지. 기존 21-27행의
내부 catch+warn은 제거 — 예외는 전파되고 처리 책임이 소비자로 이동한다(아래 Error
Handling).

### 5. `buildAuditInsertParams` — src/prisma/audit-extension.ts:30-63

현재:

```typescript
export function buildAuditInsertParams(input: {
  action: string;
  targetType: string;
  targetId: string | null;
  changes: Changes;
  metadata?: Record<string, unknown>;
}): { tenantId: string | null; /* ... */ }
```

제안 (스펙 02 §6과 동일한 **최종 병합 시그니처** — `result`는 스펙 02,
metadata 병합은 스펙 04 소유):

```typescript
export function buildAuditInsertParams(
  input: {
    action: string;
    targetType: string;
    targetId: string | null;
    changes: Changes;
    metadata?: Record<string, unknown>;
    /** Prisma operation name for error context, e.g. 'create', 'deleteMany'. */
    operation?: string;
    /** Default: 'success'. logFailures 경로에서만 'failure'. (스펙 02) */
    result?: 'success' | 'failure';
  },
  options: AuditExtensionOptions,
): AuditInsertParams | null;

export interface AuditInsertParams {
  tenantId: string | null;
  actorId: string | null;
  actorType: string;
  actorIp: string | null;
  action: string;
  targetType: string;
  targetId: string | null;
  source: 'auto';
  changes: Changes;
  metadata?: Record<string, unknown>;
  result: 'success' | 'failure';
}
```

`null` 반환 = "감사 항목 생성 안 함"(테넌트 게이트로 스킵). 7개 핸들러는 `options`를
전달하고 `operation`을 채우며, `tryAuditLog`(105-117행)는 `params === null`이면
no-op이다. 내부 처리 순서(canonical — 스펙 02 §6, 스펙 04 §8과 동일한 순서 계약):

0. 컨텍스트 부재 1회 경고 (스펙 04 B14 — 테넌트 게이트 이전, 함수 진입부)
1. 테넌트 해석 + `tenantRequired` 게이트 (스킵이면 즉시 `null` 반환 — 이후 단계 미실행)
2. 컨텍스트 metadata 병합 (스펙 04 소관)
3. metadata 레다크션 (본 스펙 — 병합 결과까지 레다크션되도록 마지막)

### 6. `AuditQueryOptions` — src/interfaces/audit-entry.interface.ts:17-26

현재:

```typescript
export interface AuditQueryOptions {
  actorId?: string;
  action?: string;
  targetType?: string;
  targetId?: string;
  from?: Date;
  to?: Date;
  limit?: number;
  offset?: number;
}
```

제안 (본 스펙 추가분만; cursor/`includeTotal`/`actorType`/`source`/`result`는 스펙 05):

```typescript
export interface AuditQueryOptions {
  // ... 기존 필드 유지 ...
  /** Explicit tenant filter. Overrides ambient tenant context. Caller is responsible for authorization. */
  tenantId?: string;
  /** Deliberate cross-tenant query — removes the tenant predicate entirely. Mutually exclusive with tenantId. */
  allTenants?: boolean;
}
```

### 7. 레다크션 헬퍼 — src/prisma/diff.ts (내부, index.ts 미export)

```typescript
/** Union of global and per-model sensitive fields. model이 null이거나 맵에 없으면 전역 리스트만. */
export function getSensitiveFieldsFor(
  model: string | null,
  options: {
    sensitiveFields?: string[];
    sensitiveFieldsByModel?: Record<string, string[]>;
  },
): string[];

/** Top-level, exact-match key redaction. Returns a shallow copy with matched values replaced by '[REDACTED]'. */
export function redactObject(
  obj: Record<string, unknown>,
  fields: string[],
): Record<string, unknown>;
```

`computeCreateChanges` / `computeUpdateChanges` / `computeDeleteChanges`
(`src/prisma/diff.ts:50, 63, 80`)의 시그니처는 **변경 없음** — 핸들러가
`getSensitiveFieldsFor(model, options)`로 유효 리스트를 만들어 기존 파라미터로 넘긴다.

### 8. `AuditService.log()` / `query()` — 시그니처 불변, 동작 변경

`log(input: ManualAuditLogInput, tx?: any): Promise<void>`와
`query(options: AuditQueryOptions): Promise<AuditQueryResult>` 시그니처는 유지된다.
내부에서 `getTenantId()` 직접 호출(`src/services/audit.service.ts:24, 54`)이
`resolveTenantId({ tenantResolver: this.options.tenantResolver })`로 교체되고,
`log()`는 metadata 레다크션을 수행한다.

## Behavior Specification

### Tenant resolution (`resolveTenantId`)

- B1. `tenantResolver`가 제공되면 그것만 사용한다. `@nestarc/tenancy` 프로브는 실행되지
  않으며(`require.resolve` 미호출) `tenancyAvailable` 캐시도 기록되지 않는다.
- B2. `tenantResolver` 부재 시 0.1.0과 동일한 tenancy 프로브 폴백: 설치 미감지 → null,
  감지 → `new TenancyContext().getTenantId()` 결과 반환.
- B3. 프로브 결과는 프로세스당 최대 1회 평가되어 모듈 레벨에 캐시된다.
  `_resetTenancyProbe()`로 테스트에서 초기화 가능. 프로세스 기동 후 tenancy 설치는
  재프로브되지 않는다(기존 동작 유지, 문서화).
- B4. 활성 소스(resolver 또는 TenancyContext)가 null을 반환하면 null을 반환한다.
- B5. 활성 소스가 throw하면 예외는 **그대로 전파**된다. `resolveTenantId` 내부에서
  삼키지 않는다(0.1.0의 `src/utils/tenant.ts:21-27` catch+warn 제거).

### Automatic path — `buildAuditInsertParams` 게이트

- B6. `tenantRequired: true` + 테넌트 해석 결과 null → `buildAuditInsertParams`가
  `null`을 반환하고 감사 INSERT는 실행되지 않는다(tenant_id NULL 행을 절대 쓰지 않음).
  `onAuditError(error, { phase: 'tenant-resolution', model, operation, action, targetId,
  tenantId: null })`가 정확히 1회 호출된다. `error`는 합성
  `Error('[@nestarc/audit-log] tenant context required but unavailable; audit entry skipped')`.
- B7. B6 상황에서도 비즈니스 뮤테이션은 항상 정상 실행·반환된다. 게이트는 감사 항목
  생성 여부에만 영향을 주며 원본 쿼리 결과를 변경하거나 예외를 던지지 않는다.
- B8. `tenantRequired`가 false이거나 미설정(기본) + 테넌트 null → 0.1.0과 동일하게
  tenant_id NULL로 행을 기록한다.
- B9. 자동 경로에서 resolver가 throw하면: `onAuditError(thrownError,
  { phase: 'tenant-resolution', ... })` 1회 호출 후 tenantId를 null로 간주한다. 이어서
  `tenantRequired: true`면 B6의 스킵이 적용되되 **두 번째 onAuditError 호출은 없다**
  (예외 보고가 스킵 보고를 겸한다); false면 B8대로 NULL 기록.
- B10. `onAuditError` 미제공 시 동일 정보를 `(options.logger ?? console).warn`으로 1회
  보고한다. 보고 경로(콜백/로거)는 어떤 경우에도 비즈니스 경로로 예외를 전파하지
  않는다 — 콜백 자체가 throw하면 `(options.logger ?? console).error`로 삼킨다.
- B11. `tryAuditLog`는 `params === null`이면 INSERT와 추가 보고 없이 즉시 반환한다
  (이중 보고 금지).

### Manual path — `AuditService.log()`

- B12. `log()`는 `resolveTenantId({ tenantResolver: this.options.tenantResolver })`로
  테넌트를 해석한다(모듈 옵션 복사본 사용 — 확장 옵션과 런타임 병합 없음).
- B13. `tenantRequired: true` + 해석 결과 null → 기존과 동일하게 throw(fail-closed,
  `src/services/audit.service.ts:25-29` 유지). 메시지는 tenantResolver 안내를 포함하도록
  갱신: `'tenant context required but not available. Provide tenantResolver or ensure
  the ambient tenant context is set.'`. 자동 경로(스킵)와의 비대칭은 의도적이다 —
  수동 호출자는 감사 기록 자체가 목적이므로 실패를 즉시 알아야 한다(문서화).
- B14. `log()`에서 resolver가 throw하면: `tenantRequired: true` → 원본 예외를 cause로
  감싼 Error를 throw; false → `(logger ?? console).warn` 후 tenant_id NULL로 기록.

### Query path — `AuditService.query()` 테넌트 시맨틱스

전 조합 매트릭스 (ambient = `resolveTenantId` 결과; "—"는 해당 변수와 무관, 모든 값
조합을 포괄). 이 매트릭스가 규범(normative)이며, 스펙 05의 `query()` 재기술(B27–B29)과
`getById()`(B24–B26)에 동일하게 적용된다:

| # | `options.tenantId` | `options.allTenants` | ambient tenant | `tenantRequired` | 동작 |
|---|---|---|---|---|---|
| Q1 | 설정 | `true` | — | — | throw `TypeError` (상호 배타 옵션 동시 지정 — 프로그래밍 오류) |
| Q2 | 설정 | 미설정 | — | — | `WHERE tenant_id = options.tenantId`. ambient 해석 자체를 수행하지 않음. 인가는 호출자 책임(문서화) |
| Q3 | 미설정 | `true` | — | — | tenant predicate 없음(의도적 교차 테넌트). ambient 해석 자체를 수행하지 않음 |
| Q4 | 미설정 | 미설정 | 존재 | — | `WHERE tenant_id = ambient` (0.1.0 동작 유지) |
| Q5 | 미설정 | 미설정 | 부재 | `true` | throw (0.1.0 동작 유지, `src/services/audit.service.ts:55-60`). 메시지는 명시 옵션 안내를 포함하도록 갱신 — 스펙 05 E4와 동일 문자열: `'[@nestarc/audit-log] tenant context required but not available. Pass an explicit tenantId or allTenants option, or ensure tenant context is set (tenantResolver / @nestarc/tenancy).'` |
| Q6 | 미설정 | 미설정 | 부재 | `false` | 무스코프 쿼리(0.1.0 하위 호환 유지) + `(logger ?? console).warn` 경고 — AuditService 인스턴스당 최초 1회 |

- B15. Q1: `tenantId`와 `allTenants: true` 동시 지정은 즉시 `TypeError` throw. DB 접근
  없음. 메시지(스펙 05 E3과 동일 문자열):
  `'[@nestarc/audit-log] tenantId and allTenants are mutually exclusive.'`
- B16. Q2: 명시적 `tenantId`는 ambient 컨텍스트와 `tenantRequired`를 모두 무시하고
  해당 테넌트로 필터한다. `tenantRequired: true` + ambient 부재 상태에서도 동작한다
  (관리자 "특정 테넌트 조회" 경로). ambient가 존재해도 명시값이 이긴다.
- B17. Q3: `allTenants: true`는 `tenantRequired` 값과 무관하게 tenant predicate를
  제거한다 — 교차 테넌트 조회의 유일한 명시적 진입로.
- B18. Q2/Q3에서는 `resolveTenantId`를 호출하지 않는다 — resolver 부재/실패가 명시적
  모드를 방해하지 않는다.
- B19. Q4/Q5/Q6 경로에서 resolver가 throw하면: `tenantRequired: true` → 원본 예외를
  cause로 throw; false → `(logger ?? console).warn` 후 ambient 부재로 간주(Q6 적용).
- B20. Q6의 경고는 인스턴스 수명당 1회만 출력한다(단일 테넌트 설치의 로그 폭주 방지).
  메시지: `'[@nestarc/audit-log] query() executed without tenant scope. Pass tenantId,
  set allTenants: true explicitly, or enable tenantRequired.'`
  스펙 05의 `getById()` 무스코프 경로도 같은 인스턴스당 1회 경고 상태를 공유한다
  (query/getById 합산 1회 — 별도 카운터를 두지 않는다).

### Redaction

- B21. 유효 민감 필드 = `sensitiveFields`(전역) ∪ `sensitiveFieldsByModel[model]`
  (합집합 병합, override 아님). 맵에 없는 모델은 전역 리스트만 적용.
- B22. 자동 경로의 changes diff(`computeCreateChanges`/`computeUpdateChanges`/
  `computeDeleteChanges`)는 핸들러의 `model` 기준 유효 리스트로 레다크션된다. 기존
  `'[REDACTED]'` 치환 방식(`src/prisma/diff.ts:57, 72-73, 87`) 유지.
- B23. `AuditService.log()`는 `input.metadata`의 **최상위 키**를
  `getSensitiveFieldsFor(input.targetType ?? null, this.options)` 결과와 정확일치
  비교하여 `'[REDACTED]'`로 치환한 뒤 직렬화한다(`src/services/audit.service.ts:30-32`
  직전). `targetType`이 맵 키와 일치하지 않는 커스텀 문자열이면 전역 리스트만 적용.
- B24. 자동 경로 metadata(현재는 `*Many`의 `{ count }`, 스펙 04 이후 컨텍스트 metadata
  포함)도 `buildAuditInsertParams` 내부에서 동일 유효 리스트로 레다크션된다(처리 순서는
  Public API Changes §5 — 병합 후 마지막 단계).
- B25. 매칭은 최상위·정확일치·대소문자 구분(기존 diff 동작과 동일). 중첩 객체 내부 키는
  치환되지 않는다 — 0.2.0 한계로 README에 명시("metadata에 중첩 PII를 넣지 말거나
  호출 전 직접 레다크션하라").
- B26. `redactObject`는 입력을 변형하지 않고 얕은 복사본을 반환하며, 어떤 입력에도
  throw하지 않는다. 원본 `args.data`/비즈니스 객체는 절대 변형되지 않는다.
- B27. 레다크션은 키 존재 기준이다 — 값이 null/undefined여도 키가 매칭되면
  `'[REDACTED]'`로 치환된다(값 부재 자체가 정보가 될 수 있으므로 일관 치환).

## SQL / DDL

해당 없음. 본 스펙은 스키마를 변경하지 않는다. `tenant_id` 컬럼과
`idx_audit_tenant_created (tenant_id, created_at DESC)` 인덱스는 기존 그대로이며,
Q2/Q4의 동등 필터는 이 인덱스를 그대로 탄다. 본 스펙의 SQL 예시는 `audit_logs`
리터럴을 가정하나, 스펙 01의 `tableName` 검증+`Prisma.raw` 보간(스펙 05가 조회
경로에 적용)이 동일 지점에 적용된다.

## Error Handling

| 실패 경로 | 처리 | phase |
|---|---|---|
| 자동 경로: resolver throw | onAuditError(원본 에러) 1회 → tenantId null 간주 → B6/B8 분기. 비즈니스 진행 | `tenant-resolution` |
| 자동 경로: `tenantRequired` + null | 감사 INSERT 스킵, onAuditError(합성 Error) 1회. 비즈니스 진행 | `tenant-resolution` |
| 자동 경로: onAuditError 미제공 | `(logger ?? console).warn` 폴백 | `tenant-resolution` |
| 자동 경로: onAuditError 콜백 자체 throw | `(logger ?? console).error`로 삼킴. 비즈니스 영향 없음 | — |
| `log()`: `tenantRequired` + null | **throw** (fail-closed, 기존 동작 유지) | — (동기 throw, 콜백 미사용) |
| `log()`: resolver throw, required | cause를 보존한 Error **throw** | — |
| `log()`: resolver throw, not required | logger.warn 후 NULL 기록 | — |
| `query()`: `tenantId`+`allTenants` 동시 | **throw TypeError** (메시지는 B15 — 스펙 05 E3과 동일) | — |
| `query()`: ambient 부재, required | **throw** (기존 동작 유지, 메시지는 Q5 — 스펙 05 E4와 동일) | — |
| `query()`: ambient 부재, not required | 무스코프 + 인스턴스당 1회 logger.warn | — |
| 레다크션 | 어떤 입력에도 throw하지 않음 (B26) | — |

`pre-read`/`insert`/`post-read` phase의 onAuditError 사용은 스펙 02(신뢰성 강화) 소관 —
본 스펙은 `tenant-resolution`만 사용한다. 수동 API는 onAuditError를 사용하지 않는다:
호출자가 동기적으로 예외를 받으므로 콜백 보고는 중복이다(Decisions D5).

## Test Plan

### Unit

| 테스트 | 검증 대상 |
|---|---|
| resolver 제공 시 require.resolve 미호출 (jest spy) + 캐시 미기록 | B1 |
| resolver 부재 시 tenancy 프로브 폴백, 미설치 → null | B2, B3 |
| `_resetTenancyProbe` 후 재프로브 | B3 |
| resolver null 반환 → null | B4 |
| resolver throw → 예외 전파 | B5 |
| buildAuditInsertParams: required+null → null 반환 + onAuditError 1회 (phase/model/operation/action 검증) | B6 |
| buildAuditInsertParams: required 미설정 + null → NULL tenant 파라미터 반환 | B8 |
| buildAuditInsertParams: resolver throw → onAuditError 1회(원본 에러), 이중 호출 없음 | B9 |
| onAuditError 미제공 → logger.warn 폴백; 콜백 throw → logger.error로 삼킴 | B10 |
| tryAuditLog(null) → $executeRaw 미호출 | B11 |
| log(): module tenantResolver 사용 확인 | B12 |
| log(): required+null → throw (메시지 검증) | B13 |
| log(): resolver throw → required면 throw(cause), 아니면 warn+NULL | B14 |
| query(): Q1~Q6 매트릭스 전 행 — 생성된 SQL의 tenant predicate 유무/값 검증 | B15–B17, Q4–Q6 |
| query(): Q2/Q3에서 resolveTenantId 미호출 (spy) | B18 |
| query(): resolver throw 분기 | B19 |
| query(): 무스코프 경고 인스턴스당 1회 | B20 |
| getSensitiveFieldsFor: 합집합/전역-only/미일치 모델 | B21 |
| create/update/delete diff에 모델별 필드 적용 | B22 |
| log() metadata 레다크션 (targetType 일치/불일치/부재) | B23 |
| buildAuditInsertParams metadata 레다크션 | B24 |
| 중첩 키 미치환, 대소문자 구분 | B25 |
| redactObject: 원본 불변, null 값 키 치환, 비정상 입력 무throw | B26, B27 |

### E2E (실 PostgreSQL)

| 테스트 | 검증 대상 | Release Gate |
|---|---|---|
| required+컨텍스트 부재에서 user.create → 비즈니스 행 존재, audit_logs 0행, onAuditError 1회 | B6, B7 | 검증 보고서 Release Gate "fail closed when tenancy unavailable" 직접 해소 |
| 커스텀 CLS resolver로 HTTP 요청 경유 create → tenant_id 기록 확인 | B1, B12 | Gate 2 (실 HTTP 미들웨어+인터셉터 E2E)에 기여 |
| upsert/deleteMany 경로에서도 B6 스킵 동작 | B6 × 핸들러 | Gate 3 (upsert/배치 E2E)에 기여 |
| 두 테넌트 데이터 시드 후 query() Q2/Q3/Q4/Q5/Q6 매트릭스 행별 결과 검증 | B15–B20 | — |
| sensitiveFieldsByModel 설정 후 User.update → changes의 모델별 필드 `[REDACTED]`, 타 모델은 비레다크션 | B21, B22 | — |
| log() metadata에 민감 키 포함 → DB 저장값 `[REDACTED]` 확인 (append-only 상태에서 사후 수정 불가 확인 겸용) | B23 | Gate 4 (append-only 검증)와 연계 |

## Migration & Docs Impact

- **CHANGELOG (0.2.0)**:
  - Added (선두 기능): `tenantResolver` — 임의의 CLS 기반 테넌시 연동.
    `@nestarc/tenancy` 없이도 테넌트 격리 사용 가능.
  - Added: `query({ tenantId })` 명시 필터, `query({ allTenants: true })` 교차 테넌트
    모드, `sensitiveFieldsByModel`, manual `log()` metadata 레다크션.
  - Changed (non-breaking, 동작 수정): `tenantRequired: true`가 자동 경로에도 적용 —
    테넌트 미해석 시 tenant_id NULL 감사 행을 쓰는 대신 스킵하고 `onAuditError`로
    보고. 플래그 옵트인이므로 breaking 아님. 단, 0.1.0에서 `tenantRequired: true`를
    켜고 NULL 행에 의존하던 설치는 행이 사라짐을 명시(마이그레이션 노트).
  - Changed: tenancy 호출 실패가 더 이상 침묵 null이 아님 — required면 fail-closed.
- **README**: 공유 상수 spread 패턴(§Public API Changes 3 예시), 테넌트 시맨틱스
  매트릭스(Q1–Q6 표 전재), 레다크션 섹션에 모델별 설정 + "중첩 PII 미지원, append-only
  특성상 유출 시 영구 보존" 경고, `onAuditError` tenant-resolution phase.
- **설계 문서**: §"@nestarc/tenancy Integration"(227-242행)의 하드코딩 require 예시를
  resolver 폴백 순서로 교체, §Security(255행) "테넌트 격리" 항목에 query 매트릭스 참조
  추가. Query API 예시(80-93행)의 "tenantId는 자동 주입" 서술에 명시/allTenants 모드
  추가.
- **검증 보고서 추적**: Finding 2(fail-open)를 본 스펙 B6/B13/Q5가 해소함을 0.2.0
  릴리스 노트에서 명시.

## Decisions

- D1. **자동 경로 스킵 vs throw vs NULL 기록**: 스킵 + onAuditError 보고 (공통 결정 6
  적용). 비즈니스 쓰기를 감사 실패로 중단하지 않는다는 설계 약속과, NULL 테넌트 행을
  절대 만들지 않는다는 격리 요구를 동시에 만족하는 유일한 조합.
- D2. **모듈/확장 옵션 전달 문제**: 공유 인터페이스 + spread 패턴, 런타임 병합 없음
  (공통 결정 1 적용). 병합 레이어는 "어느 쪽 설정이 이겼나"라는 새 디버깅 문제를
  만든다.
- D3. **`tenantId`+`allTenants` 동시 지정 → throw**: 침묵 우선순위는 어느 쪽이든
  교차 테넌트 사고로 이어질 수 있는 모호함. 프로그래밍 오류로 즉시 표면화.
- D4. **무스코프 쿼리 경고는 인스턴스당 1회**: fail-loud 철학과 단일 테넌트 설치(테넌시
  자체를 안 쓰는 사용자)의 로그 폭주 방지 간 균형. 매 호출 경고는 옵트아웃 요구를
  부르고, 0회는 0.1.0 침묵 노출의 반복.
- D5. **수동 경로는 계속 throw (자동 경로와 비대칭)**: `log()` 호출자는 감사 기록이
  목적인 코드이므로 실패를 동기적으로 알아야 하고 자체 재시도/보상이 가능하다. 자동
  경로의 호출자는 비즈니스 코드이므로 중단 불가. onAuditError는 수동 경로에서
  사용하지 않는다(동기 예외와 중복 보고 방지).
- D6. **resolver 예외는 `resolveTenantId`에서 전파**: 0.1.0의 내부 catch+warn
  (`src/utils/tenant.ts:21-27`)이 Finding 2 fail-open의 원인. fail-open/fail-closed
  결정은 `tenantRequired`를 아는 소비자만 내릴 수 있으므로 유틸은 판단하지 않는다.
- D7. **`sensitiveFieldsByModel`은 합집합 병합**: override 시맨틱은 "모델 키를
  추가했더니 전역 보호가 풀렸다"는 레다크션 후퇴를 만든다. append-only 환경에서
  레다크션 후퇴는 비가역 사고이므로 보수적 합집합만 허용 (공통 결정 12의 "merged"
  해석 확정).
- D8. **자동 경로 metadata도 레다크션**: 공통 결정 12의 문면은 `log()` metadata지만,
  스펙 04의 `setMetadata` enricher로 자동 항목에도 임의 metadata가 들어오므로 같은
  구멍이 생긴다. `buildAuditInsertParams` 한 곳에서 동일 헬퍼로 처리 — 추가 비용
  미미, GDPR 일관성 확보.
- D9. **`tenantResolver`는 동기 전용** (`() => string | null`, 공통 결정 1의 형태
  그대로): CLS 조회는 본질적으로 동기. async resolver는 자동 경로 7개 핸들러의 흐름을
  바꾸므로 0.2.0 범위 밖. 비동기 actor 추출(스펙 #8 영역)과 혼동하지 않도록 문서화.
- D10. **`getTenantId` → `resolveTenantId` 무보존 교체**: `getTenantId`는 `index.ts`에서
  export되지 않는 내부 유틸이므로 공개 계약 위반 없음. deprecated alias 불필요.

## Out of Scope

- 중첩 경로 레다크션(`profile.ssn` 등 dot-path) — 0.3.0 후보 (공통 결정 12).
- PostgreSQL RLS 기반 audit_logs 테넌트 격리 — tenancy 패키지 영역.
- 비동기 `tenantResolver` — D9 참조.
- `query()`의 테넌트 인가(호출자가 해당 tenantId를 볼 권한이 있는지) — 애플리케이션
  책임으로 문서화.
- 배치 연산의 레코드별 충실도(#10) 및 중첩 관계 쓰기 감사 — 0.3.0. 본 스펙의 테넌트
  게이트는 현행 count-only `*Many` 항목에도 동일하게 적용된다는 경계만 명시.
- 커서 페이지네이션, `includeTotal`, `actorType`/`source`/`result` 필터, `getById` —
  스펙 05 (Query API v2) 소관. 단 Q1–Q6 테넌트 매트릭스는 `getById()`에도 동일하게
  적용된다(스펙 05 B24–B26, D9 — 본 스펙이 매트릭스의 규범 소유자로서 승인).
