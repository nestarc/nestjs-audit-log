# v0.2.0 Spec — Extension Reliability & Tracking Defaults

Date: 2026-06-11
Status: Historical v0.2.0 implementation specification — released; not the current package contract
Roadmap items: #2 (추적 기본값 변경 — BREAKING), #3 (신뢰성 강화), #6 (select 프로젝션 targetId 유실 수정), Smaller fixes (`@updatedAt`-only 노이즈 필터, 커스텀 Prisma client output path — 확장·AuditService 양쪽, 중첩 관계 쓰기 경계 문서화·감지 경고)

## Goal

Prisma extension의 자동 추적 경로를 "침묵 실패(fail-silent)"에서 "정직한 실패(fail-loud)"로 전환한다.

1. **추적 기본값 변경 (#2, BREAKING)**: 설정 없는 `createAuditExtension({})`이 아무것도 추적하지 않는 현재 동작을 폐기하고, 기본을 **전체 모델 추적**으로 바꾼다. 위험한 설정 조합은 팩토리 시점에 경고한다.
2. **신뢰성 강화 (#3)**: pre-read 실패가 비즈니스 뮤테이션을 중단시키는 버그를 수정하고(격리), 모든 감사 실패를 `onAuditError` 콜백으로 관측 가능하게 만들며, `logFailures` 옵트인으로 `result='failure'` 항목이 도달 가능해진다.
3. **select 프로젝션 수정 (#6)**: `select`가 PK를 생략해도 `targetId`가 NULL이 되지 않도록 PK를 주입한다.
4. **Smaller fixes**: `@updatedAt` 전용 변경 노이즈 필터(`ignoreTimestampOnlyUpdates`), 커스텀 generator output 프로젝트를 위한 `prismaModule` 주입 옵션 — 확장(`createAuditExtension`)과 모듈(`AuditLogModuleOptions`/`AuditService`) 양쪽 모두(B41–B44, B46), 중첩 관계 쓰기 경계 문서화 + 추적 모델 중첩 쓰기 감지 경고(B45).

이 스펙은 v0.2.0 공통 인터페이스 `AuditSharedOptions` / `AuditErrorContext` / `AuditLogger`의 **정의를 소유**한다. 다른 스펙은 이 정의를 참조한다.

### Shared Decisions (applied)

이 스펙은 다음 고정된 cross-cutting 결정 위에 작성되었다 (재논의 없음):

- **공유 옵션 인터페이스**: `AuditSharedOptions { tableName?; tenantRequired?; tenantResolver?; onAuditError?; logger? }`를 신규 export하고 `AuditExtensionOptions`/`AuditLogModuleOptions`가 이를 extend한다. 모듈↔확장 간 런타임 병합은 없다 — 각 소비자가 자기 사본을 읽고, 문서화된 사용 패턴은 하나의 공유 상수를 두 호출처에 spread하는 것이다.
- **`AuditErrorContext` phase enum**: `'pre-read' | 'insert' | 'post-read' | 'tenant-resolution' | 'context'` (고정).
- **`AuditLogger`**: `{ warn(message: string): void; error(message: string): void }` — console과 NestJS `LoggerService` 양쪽과 구조적으로 호환되는 부분집합.
- **추적 기본값**: 두 리스트 모두 부재 시 전체 모델 추적. 팩토리 시점 경고는 `options.logger ?? console`로 출력.
- **`tenantRequired` 자동 경로**: true + 테넌트 해석 null이면 감사 insert를 **스킵**하고 `onAuditError({ phase: 'tenant-resolution', ... })`로 보고. 비즈니스 연산은 항상 진행. (동작 자체는 로드맵 #4 스펙 소유 — 본 스펙은 핸들러 흐름에서의 접합점만 정의.)
- **select 프로젝션**: create/update/upsert에서 `args.select` 존재 시 쿼리 실행 전 PK 필드를 주입.
- **`prismaModule`**: 하드코딩된 `require('@prisma/client')` 대신 생성된 client 네임스페이스를 옵션으로 주입 — 확장 팩토리와 모듈(`AuditService`의 정적 import, B46) 양쪽에 동일 적용.
- **배치 연산 충실도(#10)와 중첩 쓰기 풀 감사는 0.3.0** — 0.2.0은 경계 문서화 + 감지 경고(로드맵 smaller fix — 본 스펙 B45 소유)까지만 다룬다.

## Background

0.1.0의 자동 추적 경로는 일관되게 fail-silent다. 코드 근거:

**1) 기본값이 침묵 no-op** — `shouldTrackModel`(`src/prisma/diff.ts:36-48`)은 `trackedModels`/`ignoredModels` 둘 다 부재하면 `false`를 반환한다:

```ts
// src/prisma/diff.ts:41-47 (현행)
if (trackedModels && trackedModels.length > 0) {
  return trackedModels.includes(model);
}
if (ignoredModels && ignoredModels.length > 0) {
  return !ignoredModels.includes(model);
}
return false;   // ← createAuditExtension({})은 아무것도 추적하지 않는다. 경고도 없다.
```

컴플라이언스 라이브러리에서 최악의 실패 모드다 — 사고/감사 시점에야 "로그가 한 줄도 없다"는 사실이 발견된다. 같은 이유로 `trackedModels: ['Usr']` 같은 오타도 침묵 no-op이 된다.

**2) pre-read가 비즈니스 연산을 중단시킨다** — update/delete/upsert의 `findFirst`와 deleteMany의 `findMany`가 try 블록 **밖**에서 실행된다:

- update: `src/prisma/audit-extension.ts:183-185`
- delete: `src/prisma/audit-extension.ts:237-239`
- upsert: `src/prisma/audit-extension.ts:280-282`
- deleteMany: `src/prisma/audit-extension.ts:395-397`

감사용 조회가 throw하면(커넥션 풀 고갈, 권한, 타임아웃 등) 원본 뮤테이션이 실행조차 되지 않는다. "감사가 비즈니스를 깨지 않는다"는 설계 약속(`docs/2026-04-04-audit-log-design.md`)의 직접 위반이며, 사실상 버그 수정이다.

**3) 에러 처리가 관측 불가능** — `tryAuditLog`(`src/prisma/audit-extension.ts:105-117`)의 bare `console.warn`과 7개 핸들러의 동일한 catch 블록(`165-170, 220-225, 262-267, 326-331, 352-357, 378-383, 420-425`)이 전부다. 프로덕션에서 감사 유실율을 측정할 방법이 없다 — 그 자체가 SOC2 지적 사항이다.

**4) `result='failure'`가 도달 불가** — `insertAuditLog`가 `${'success'}`를 하드코딩한다(`src/prisma/audit-extension.ts:89`). `AuditEntry.result` 타입은 `'success' | 'failure'`(`src/interfaces/audit-entry.interface.ts:13`)지만 자동 경로에서 'failure'는 절대 기록되지 않는다.

**5) select 프로젝션이 targetId를 유실** — create의 `result[pkField]` 의존(`src/prisma/audit-extension.ts:140-152`)과 upsert의 동일 패턴(`288-298`) 때문에, `select`가 PK를 생략하면 `targetId = null` + canonical 재조회 불가 → changes에 프로젝션된 필드만 남는다. 검증 보고서 Finding 5에서 실증됨 (`create({ select: { name: true } })` → `{"targetId":null,"changes":{"name":{...}}}`). update도 before가 없을 때 `String(result[pkField] ?? null)`(`211-216`)이 **문자열 `"null"`**을 만들어내는 부수 버그가 있다.

**6) `@updatedAt` 노이즈** — `computeUpdateChanges`(`src/prisma/diff.ts:63-78`)는 모든 변경 필드를 diff에 넣으므로, 타임스탬프만 갱신된 update도 `{ updatedAt: { before, after } }` 항목을 만든다. 경쟁 패키지(django-auditlog 등)의 대표적 노이즈 저감 기능이 부재하다.

**7) 커스텀 client output에서 런타임 실패** — `createAuditExtension`이 `require('@prisma/client')`를 하드코딩한다(`src/prisma/audit-extension.ts:123-124`). 이 import에서 실제로 소비하는 것은 `Prisma.defineExtension` 하나뿐이다(126행). Prisma 권장 패턴인 커스텀 generator output(예: `output = "../src/generated/client"`)을 쓰는 프로젝트에서는 `@prisma/client` 기본 위치에 생성물이 없어 require가 throw하거나 미초기화 에러가 난다 — 순수 도입 차단 요인.

## Public API Changes

### 1. 신규 파일 `src/interfaces/audit-shared-options.interface.ts` (본 스펙 소유 — 전체 정의)

```ts
/** console과 NestJS LoggerService 양쪽과 구조적으로 호환되는 최소 로거. */
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

/**
 * 모듈과 확장이 공유하는 옵션. 런타임 병합은 없다 — 각 소비자가 자기 사본을 읽는다.
 * 문서화된 사용 패턴: 하나의 공유 상수를 forRoot()와 createAuditExtension() 양쪽에 spread.
 */
export interface AuditSharedOptions {
  /** 감사 테이블명. Default: 'audit_logs'. 검증/보간 규칙은 DDL/tableName 스펙(로드맵 #1/#11) 소유. */
  tableName?: string;
  /** true면 테넌트 부재 시 fail-closed. 자동 경로 동작은 로드맵 #4 스펙 소유. Default: false */
  tenantRequired?: boolean;
  /** @nestarc/tenancy 강결합 해소용 커스텀 테넌트 해석기. 로드맵 #4 스펙 소유. */
  tenantResolver?: () => string | null;
  /** 모든 감사 실패의 단일 관측 지점. 제공 시 기본 logger.warn 출력을 대체한다. */
  onAuditError?: (error: unknown, ctx: AuditErrorContext) => void;
  /** 팩토리 경고 및 onAuditError 부재 시 폴백 출력. Default: console */
  logger?: AuditLogger;
}
```

`src/index.ts`에 export 추가:

```ts
export type {
  AuditSharedOptions,
  AuditErrorContext,
  AuditErrorPhase,
  AuditLogger,
} from './interfaces/audit-shared-options.interface';
```

### 2. `AuditExtensionOptions` (`src/prisma/audit-extension.ts:11-17`)

현행:

```ts
// src/prisma/audit-extension.ts:11-17 (현행)
export interface AuditExtensionOptions {
  trackedModels?: string[];
  ignoredModels?: string[];
  sensitiveFields?: string[];
  /** Map of model name to primary key field name. Defaults to 'id'. */
  primaryKey?: Record<string, string>;
}
```

제안:

```ts
export interface PrismaModuleLike {
  Prisma: {
    /**
     * 파라미터/반환 타입은 의도적으로 `any`다 (bivariance-safe).
     * `unknown`을 쓰면 repo의 `strict: true`(strictFunctionTypes) 하에서 실제 생성된
     * client의 좁은 시그니처(`defineExtension<R>(extension: ...)`,
     * `sql(strings: readonly string[], ...values: RawValue[])`)가 반공변 파라미터
     * 검사로 할당 불가가 되어, typed import(`import * as client from './generated/client'`)
     * 모듈을 `prismaModule`로 전달할 수 없게 된다(B41/T38의 전제 파괴).
     * T41 컴파일 전용 테스트로 할당 가능성을 고정한다.
     */
    defineExtension: (extension: any) => any;
    /** 스펙 01의 tableName 보간(`INSERT INTO ${Prisma.raw(table)}`)에 사용. @prisma/client 생성물에는 항상 존재. */
    sql?: (strings: TemplateStringsArray | readonly string[], ...values: any[]) => unknown;
    raw?: (value: string) => unknown;
    /** AuditService의 WHERE 절 조립(`Prisma.join`/`Prisma.empty`)에 사용 (B46 — 스펙 05). */
    join?: (values: readonly any[], separator?: string, prefix?: string, suffix?: string) => unknown;
    empty?: unknown;
    /** 생성된 client가 노출하는 datamodel. 모델명 검증과 @updatedAt 필드 감지에 사용(없으면 해당 기능 생략). */
    dmmf?: {
      datamodel?: {
        models?: ReadonlyArray<{
          name: string;
          fields?: ReadonlyArray<{ name: string; isUpdatedAt?: boolean }>;
        }>;
      };
    };
  };
}

export interface AuditExtensionOptions extends AuditSharedOptions {
  trackedModels?: string[];
  ignoredModels?: string[];
  sensitiveFields?: string[];
  /** Map of model name to primary key field name. Defaults to 'id'. */
  primaryKey?: Record<string, string>;
  /** 비즈니스 쿼리 throw 시 result='failure' 항목을 best-effort 기록. 원본 에러는 항상 rethrow. Default: false */
  logFailures?: boolean;
  /** @updatedAt 필드를 update diff에서 제거하고, 그것만 바뀐 update의 항목 생성을 억제. Default: false */
  ignoreTimestampOnlyUpdates?: boolean;
  /** 커스텀 output 경로로 생성된 Prisma client 모듈. 미지정 시 require('@prisma/client') (현행 동작). */
  prismaModule?: PrismaModuleLike;
}
```

(최종 인터페이스에는 스펙 03의 `sensitiveFieldsByModel`, 스펙 06의
`experimentalTxAudit`이 추가로 합류한다 — 각 필드의 정의는 해당 스펙 참조.)

### 3. `AuditLogModuleOptions` (`src/interfaces/audit-log-options.interface.ts:4-9`)

현행:

```ts
// src/interfaces/audit-log-options.interface.ts:4-9 (현행)
export interface AuditLogModuleOptions {
  prisma: any;
  actorExtractor: ActorExtractor;
  /** When true, query() throws if tenant context is unavailable. Default: false */
  tenantRequired?: boolean;
}
```

제안 (extends로 전환 — `tenantRequired`는 공유 인터페이스로 이동하므로 소스/타입 호환):

```ts
export interface AuditLogModuleOptions extends AuditSharedOptions {
  prisma: any;
  actorExtractor: ActorExtractor;
  /**
   * 커스텀 output 경로로 생성된 Prisma client 모듈 (확장 옵션의 동명 필드와 동일 형태).
   * AuditService가 SQL 조립에 쓰는 Prisma 네임스페이스(sql/raw/join/empty)를 이 모듈에서
   * 해소한다. 미지정 시 require('@prisma/client') 폴백 (B46).
   */
  prismaModule?: PrismaModuleLike;
}
```

모듈 측 `tenantRequired`/`tenantResolver`/`tableName` 동작 변경은 각각 로드맵 #4(스펙 03) / #1·#11(스펙 01) 소유. 본 스펙은 인터페이스 정의만 소유한다. (최종 모듈 인터페이스에는 스펙 03의 `sensitiveFields`/`sensitiveFieldsByModel`, 스펙 04의 `excludeRoutes`/`registerGlobalInterceptor`/`correlationIdHeader`/`correlationIdGetter`가 추가로 합류한다.)

`prismaModule`의 모듈 측 도입으로 `src/services/audit.service.ts:2`의 정적
`import { Prisma } from '@prisma/client'`는 제거되고, `AuditService` 생성자가 §8의
`resolvePrismaNamespace({ prismaModule: options.prismaModule })`로 네임스페이스를 1회
해소·보관한다(B46). 서비스 SQL 재작성 시의 적용 지점은 스펙 01 §7(`log()` INSERT의
`Prisma.sql`/`Prisma.raw`)과 스펙 05(`query()`/`getById()`)가 명시한다 — 커스텀 output
문제의 "모듈 측 절반"이 이로써 0.2.0 범위에 들어온다(로드맵 smaller fix 완결).

### 4. `shouldTrackModel` (`src/prisma/diff.ts:36-48`) — 시그니처 유지, 의미 변경

```ts
// 시그니처 불변
export function shouldTrackModel(
  model: string,
  trackedModels?: string[],
  ignoredModels?: string[],
): boolean;
```

신규 진리표 (Behavior B1–B4 참조):

| `trackedModels` | `ignoredModels` | 결과 | 0.1.0 대비 |
|---|---|---|---|
| `undefined` | `undefined` | **true (전체 추적)** | **변경** (기존 false) |
| `undefined` | `[]` | **true (전체 추적)** | **변경** (기존 false) |
| `undefined` | non-empty | `!ignoredModels.includes(model)` | 동일 |
| `[]` | `undefined` | false (명시적 빈 allowlist 존중, W3 경고) | 결과 동일, 경고 신규 |
| `[]` | non-empty | false (allowlist 우선 — B2, W2·W3 경고) | **변경** (0.1.0은 빈 allowlist를 무시하고 denylist를 적용 — `src/prisma/diff.ts:41-47`의 `length > 0` 검사 — 비제외 모델이 추적됐다. 0.2.0은 빈 allowlist를 권위로 취급해 아무것도 감사하지 않는다. CHANGELOG BREAKING 명시) |
| non-empty | any | `trackedModels.includes(model)` (allowlist 우선, 둘 다 있으면 W2 경고) | 결과 동일, 경고 신규 |

참조 구현:

```ts
export function shouldTrackModel(
  model: string,
  trackedModels?: string[],
  ignoredModels?: string[],
): boolean {
  if (trackedModels !== undefined) {
    return trackedModels.includes(model);   // 빈 배열 = 명시적 "추적 없음"
  }
  if (ignoredModels !== undefined && ignoredModels.length > 0) {
    return !ignoredModels.includes(model);
  }
  return true;                              // 기본: 전체 추적 (0.2.0 BREAKING)
}
```

### 5. `computeUpdateChanges` (`src/prisma/diff.ts:63-78`)

현행:

```ts
// src/prisma/diff.ts:63-67 (현행)
export function computeUpdateChanges(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
  sensitiveFields: string[],
): Changes;
```

제안 (4번째 optional 파라미터 추가 — 소스 호환):

```ts
export function computeUpdateChanges(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
  sensitiveFields: string[],
  /** diff에서 무조건 제외할 필드명 (예: @updatedAt 필드). Default: [] */
  ignoreFields?: readonly string[],
): Changes;
```

동작: `ignoreFields`에 포함된 키는 값 비교 없이 건너뛴다 — 변경 여부와 무관하게 결과 `Changes`에 절대 등장하지 않는다. `computeCreateChanges`/`computeDeleteChanges`는 **변경 없음** (스냅샷에는 타임스탬프 유지 — Decisions D9).

### 6. `buildAuditInsertParams` (`src/prisma/audit-extension.ts:30-63`)

현행:

```ts
// src/prisma/audit-extension.ts:30-47 (현행, 발췌)
export function buildAuditInsertParams(input: {
  action: string;
  targetType: string;
  targetId: string | null;
  changes: Changes;
  metadata?: Record<string, unknown>;
}): {
  tenantId: string | null;
  // ... actorId, actorType, actorIp, action, targetType, targetId,
  source: 'auto';
  changes: Changes;
  metadata?: Record<string, unknown>;
};
```

제안 (스펙 02/03/04 3개 스펙이 이 함수를 수정하므로, 아래가 **최종 병합 시그니처**다 —
`operation`·`options` 파라미터·null 게이트는 스펙 03, metadata 병합은 스펙 04,
`result`는 본 스펙 소유):

```ts
export function buildAuditInsertParams(
  input: {
    action: string;
    targetType: string;
    targetId: string | null;
    changes: Changes;
    metadata?: Record<string, unknown>;
    /** Prisma operation name for error context, e.g. 'create', 'deleteMany'. (스펙 03) */
    operation?: string;
    /** Default: 'success'. logFailures 경로에서만 'failure'. (본 스펙) */
    result?: 'success' | 'failure';
  },
  options: AuditExtensionOptions,
): AuditInsertParams | null;
```

명명 반환 타입 `AuditInsertParams`(필드: tenantId/actorId/actorType/actorIp/action/
targetType/targetId/source/changes/metadata + `result: 'success' | 'failure'`)는
스펙 03 §5에 정의된다. 함수 내부 처리 순서(canonical — 스펙 03 §5와 동일):
(0) 컨텍스트 부재 1회 경고(스펙 04 B14, 함수 진입부) → (1) 테넌트 게이트(스킵 시
즉시 null) → (2) 컨텍스트 metadata 병합(스펙 04) → (3) metadata 레다크션(스펙 03).

반환 타입에 `| null` 추가: **테넌트 스킵 접합점** — `tenantRequired === true`이고 테넌트 해석이 null일 때만 null을 반환한다(그 내부 동작·보고는 로드맵 #4 스펙 — 스펙 03 — 소유). 모든 핸들러는 null을 받으면 insert 없이 조용히 진행한다(B-T1). 이 계약을 여기서 고정해 두 스펙이 같은 접합점을 쓰게 한다.

### 7. 내부 헬퍼 (export 안 함 — 구현 지침)

```ts
/** 모든 감사 실패의 단일 보고 지점. 절대 throw하지 않는다. */
function reportAuditError(
  options: AuditExtensionOptions,
  error: unknown,
  ctx: AuditErrorContext,
): void;

// src/prisma/audit-extension.ts:105-117 (현행) → 시그니처 변경
async function tryAuditLog(
  client: any,
  params: NonNullable<ReturnType<typeof buildAuditInsertParams>>,
  options: AuditExtensionOptions,
  ctx: Omit<AuditErrorContext, 'phase'>,
): Promise<void>;
// catch 시 reportAuditError(options, error,
//   { ...ctx, phase: 'insert', action: params.action,
//     targetId: params.targetId, tenantId: params.tenantId })

// src/prisma/audit-extension.ts:65-92 (현행) → 89행 ${'success'} 를 ${params.result} 로
async function insertAuditLog(client, params): Promise<void>;
```

### 8. `createAuditExtension` (`src/prisma/audit-extension.ts:119`)

시그니처: `export function createAuditExtension(options: AuditExtensionOptions): any` —
파라미터는 불변이지만 **반환 타입을 명시적 `any`로 선언**한다. 현행은
`require('@prisma/client')`가 `any`라 추론 반환도 `any`인데, §2의 구조적 타이핑 도입 후
추론에 맡기면 반환이 `unknown`으로 좁아져 기존 소비자의
`prisma.$extends(createAuditExtension(...))` 호출이 컴파일되지 않는다(`$extends`는
`unknown`을 받지 않음 — 하위 호환 침묵 파괴). 명시적 `any`로 회귀를 차단하고 T41
컴파일 테스트로 고정한다.

`require('@prisma/client')` 해소 로직 변경 (현행 `123-124`):

```ts
// 현행 (src/prisma/audit-extension.ts:123-124)
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { Prisma } = require('@prisma/client');

// 제안 — 확장 팩토리와 AuditService(B46)가 공유하는 내부 헬퍼 (배럴 export 안 함)
function resolvePrismaNamespace(options: { prismaModule?: PrismaModuleLike }): PrismaModuleLike['Prisma'] {
  if (options.prismaModule) {
    if (typeof options.prismaModule.Prisma?.defineExtension !== 'function') {
      throw new Error(
        '[@nestarc/audit-log] prismaModule.Prisma.defineExtension is not a function. ' +
          'Pass the generated client module, e.g. prismaModule: require("./generated/client").',
      );
    }
    return options.prismaModule.Prisma;
  }
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require('@prisma/client').Prisma;
  } catch (cause) {
    throw new Error(
      '[@nestarc/audit-log] Could not load @prisma/client. If your Prisma client is ' +
        'generated to a custom output path, pass it via the prismaModule option: ' +
        'createAuditExtension({ prismaModule: require("./generated/client") }).',
      { cause },
    );
  }
}
```

주: 위 코드의 2-인자 `new Error(message, { cause })`는 `lib.es2022.error`의
`ErrorOptions` 선언을 요구한다 — 현행 tsconfig는 `lib: ["ES2021"]`이라 TS2554
(`Expected 0-1 arguments`)로 컴파일되지 않는다. 본 스펙의 Migration & Docs Impact가
tsconfig `lib`를 `["ES2022"]`로 상향한다(`target: ES2021` 유지 — 런타임은 패키지
바닥선인 Node 18+에서 이미 지원). 스펙 03 B14의 cause 래핑도 같은 상향에 의존한다.

## Behavior Specification

표기: `logger* = options.logger ?? console`. 모든 경고 문자열은 테스트 가능하도록 접두사 `[@nestarc/audit-log]`를 포함한다.

### Tracking defaults (#2)

- **B1.** `trackedModels`와 `ignoredModels`가 모두 `undefined`이면 모든 모델이 추적된다 (`shouldTrackModel === true`).
- **B2.** `trackedModels`가 배열로 제공되면(빈 배열 포함) allowlist 모드: `trackedModels.includes(model)`만으로 결정되고 `ignoredModels`는 무시된다.
- **B3.** `trackedModels === undefined`이고 `ignoredModels`가 비어있지 않으면 denylist 모드: `!ignoredModels.includes(model)`.
- **B4.** `trackedModels === undefined`이고 `ignoredModels === []`이면 모든 모델이 추적된다 (0.1.0에서는 아무것도 추적하지 않았음 — BREAKING의 일부로 문서화).
- **B5.** `createAuditExtension()` 호출 시점에 두 리스트 모두 부재하면 `logger*.warn`으로 W1을 정확히 1회 출력한다:
  `[@nestarc/audit-log] No trackedModels/ignoredModels configured — auditing ALL models. Set trackedModels (allowlist) or ignoredModels (denylist) to narrow scope. (v0.2.0 changed the default from tracking nothing.)`
- **B6.** 두 리스트가 모두 제공되면 W2를 1회 출력한다:
  `[@nestarc/audit-log] Both trackedModels and ignoredModels are set — trackedModels (allowlist) wins; ignoredModels is ignored.`
- **B7.** `trackedModels === []`이면 W3을 1회 출력한다:
  `[@nestarc/audit-log] trackedModels is an empty array — NO models will be audited. Remove the option entirely to audit all models.`
- **B8.** datamodel을 확보할 수 있을 때(`prismaModule.Prisma.dmmf?.datamodel?.models` 또는 `require('@prisma/client').Prisma.dmmf?.datamodel?.models`), `trackedModels`/`ignoredModels`에 datamodel에 없는 모델명이 있으면 W4를 리스트당 1회 출력한다(이름 나열):
  `[@nestarc/audit-log] Unknown model name(s) in trackedModels: 'Usr', 'Acount' — not found in the Prisma datamodel. These entries have no effect.`
  datamodel이 없으면(dmmf 미노출 client) 이 검사는 조용히 생략된다.
- **B9.** B5–B8의 경고는 `createAuditExtension()` 호출당 각 1회이며, 핸들러 실행 시마다 반복되지 않는다.

### Reliability — pre-read 격리 (#3)

- **B10.** update: pre-read(`findFirst`, 현행 `183-185`)가 throw해도 비즈니스 쿼리는 정상 실행·반환된다. 실패는 `onAuditError(error, { phase: 'pre-read', model, operation: 'update' })`로 보고하고, 감사 항목은 `changes: {}` + `metadata: { preReadFailed: true }`로 여전히 기록한다 (감사 존재 > diff 충실도).
- **B11.** delete: 동일 규칙 (현행 `237-239`). pre-read 실패 시 `changes: {}`, `targetId`는 `result[pkField]` 폴백, `metadata.preReadFailed: true`.
- **B12.** upsert: pre-read(현행 `280-282`) **실패** 시 create/update 분기를 판단할 수 없으므로 action을 `${model}.upserted`(불확정 표기)로 기록하고, changes는 after-상태 스냅샷(`computeCreateChanges` 형태), `metadata.preReadFailed: true`. pre-read가 성공하고 null을 반환한 경우(레코드 없음)는 현행대로 create 분기.
- **B13.** deleteMany: pre-read(`findMany`, 현행 `395-397`) 실패 시 레코드별 항목 대신 **fallback 1건** — action `${model}.deletedMany`, `changes: {}`, `metadata: { count: result.count, preReadFailed: true }` — 을 기록하고 phase `'pre-read'`로 보고한다. (벌크 삭제가 있었다는 사실 자체는 보존.)
- **B14.** post-read(canonical 재조회: create 현행 `147-152`, update `191-196`, upsert `293-298`)가 throw하면 after-상태를 `result`로 폴백해 항목은 여전히 기록하고, `onAuditError({ phase: 'post-read', ... })`로 보고하며 `metadata.postReadFailed: true`를 추가한다.
- **B15.** diff 계산·파라미터 조립 등 나머지 감사 조립 코드가 throw하면 해당 항목만 포기하고 `onAuditError({ phase: 'context', ... })`로 보고한다. 비즈니스 결과는 정상 반환.
- **B16.** 감사 INSERT 실패(`tryAuditLog`)는 `onAuditError({ phase: 'insert', model, operation, action, targetId, tenantId })`로 보고하고 swallow한다.
- **B17.** `onAuditError` 미제공 시 확장 내 `reportAuditError` 경유 모든 phase의 폴백은 `logger*.warn('[@nestarc/audit-log] audit <phase> failed for <model>.<operation>: <message>')` — 현행 bare `console.warn`(105-117, 각 핸들러 catch)을 대체한다. `onAuditError` 제공 시 기본 warn 출력은 발생하지 않는다(이중 출력 금지). (모듈 측 미들웨어의 `actorExtractor`/`correlationIdGetter` 실패는 스펙 04 B3이 별도로 `logger*.error` 폴백을 규정한다 — 액터 유실은 심각도가 높아 의도된 차등.)
- **B18.** `onAuditError` 콜백 자체가 throw하면 swallow하고 `logger*.error('[@nestarc/audit-log] onAuditError callback threw: <message>')`를 출력한다. 비즈니스 결과에 영향 없음.
- **B19.** deleteMany 루프(현행 `402-419`, catch `420-425`가 루프 전체를 감싸 한 레코드 실패가 나머지를 중단시킴): 레코드별로 격리한다 — 한 레코드의 조립 실패(phase `'context'`)나 insert 실패(phase `'insert'`)가 다른 레코드의 기록을 막지 않는다. N+1 INSERT 구조 자체는 유지(multi-row INSERT는 #10/0.3.0).
- **B20.** `insertAuditLog`(현행 `65-92`)는 `params.result`를 바인드한다(89행 `${'success'}` 하드코딩 제거). 자동 경로 기본값은 `'success'`.
- **B-T1.** (접합점) `buildAuditInsertParams()`가 `null`을 반환하면 핸들러는 insert를 시도하지 않고 정상 진행한다. null 반환 조건과 `phase: 'tenant-resolution'` 보고는 로드맵 #4 스펙(스펙 03 B6–B11)이 정의한다. 본 스펙의 catch들은 이 경로를 에러로 이중 보고하지 않는다(예외가 아닌 반환값이므로 자연 충족).

### logFailures (#3, 옵트인)

- **B21.** `logFailures` 기본값은 `false`. false면 비즈니스 쿼리 throw 시 어떤 감사 기록도 시도하지 않고 원본 에러를 그대로 전파한다.
- **B22.** `logFailures: true`일 때 7개 핸들러 모두에서 `await query(args)` throw 시: 제외 대상(B23–B24)이 아니면 `result: 'failure'` 항목을 best-effort 기록한 뒤, **원본 에러 객체를 동일 참조로 rethrow**한다(래핑·메시지 변경·스택 소실 금지). 기록 시도가 끝나기 전에 rethrow하지 않는다(await).
- **B23.** `(error as any)?.code === 'P2025'`(record not found — 가드된 update/delete의 예상 가능한 결과)이면 failure 항목을 기록하지 않고 rethrow만 한다. 판정은 duck-typing — Prisma 에러 클래스를 import하지 않는다(커스텀 client 호환).
- **B24.** `(error as any)?.name === 'PrismaClientValidationError'`(클라이언트 측 검증 — DB 도달 전)이면 기록하지 않고 rethrow만 한다. 그 외 에러 코드는 모두 기록 대상이다(P2002 unique 위반 포함 — 시도된 쓰기 실패는 감사 관점에서 유의미. Decisions D7).
- **B25.** failure 항목 내용:
  - `action`: create→`${model}.created`, update→`${model}.updated`, delete→`${model}.deleted`, upsert→`${model}.upserted`, createMany→`${model}.createdMany`, updateMany→`${model}.updatedMany`, deleteMany→`${model}.deletedMany`
  - `result: 'failure'`, `changes: {}` (아무것도 커밋되지 않았으므로)
  - `targetId` best-effort: pre-read 성공 시 `before[pkField]`; 아니면 `args.where?.[pkField]`가 string/number일 때 `String(...)`; create는 `args.data?.[pkField]`; `*Many`는 null.
  - `metadata: { operation, error: { name, code?, message } }` — message는 500자에서 truncate (Prisma 에러 메시지에 쿼리 인자가 포함될 수 있음 — 문서화). 스펙 03의 metadata 레다크션(B24/B25)은 **최상위 키 정확일치**만 다루므로 중첩된 `error.message` 내부 값은 레다크션되지 않는다 — README의 `logFailures` 캐비엇에 이 한계를 함께 명시한다.
- **B26.** failure 항목의 INSERT 자체가 실패하면 phase `'insert'`로 보고·swallow하고, 원본 비즈니스 에러의 rethrow는 그대로 수행된다 (감사 실패가 원본 에러를 가리지 않는다).
- **B27.** failure 항목에도 테넌트 스킵 규칙(B-T1)이 적용된다 — `tenantRequired: true` + 테넌트 부재면 failure 항목도 기록하지 않는다.

### select 프로젝션 fix (#6)

- **B28.** create/update/upsert에서 `args.select`가 객체이고 `args.select[pkField]`가 `true`가 아니면(부재 또는 `false`), 쿼리 실행 전 `args.select[pkField] = true`로 주입하고 주입 사실을 기억한다.
- **B29.** 주입한 경우에만, 호출자에게 반환하기 직전 `result`에서 `pkField` 속성을 제거한다(`delete result[pkField]`) — 호출자의 프로젝션 계약을 비트 단위로 보존. 사용자가 원래 `select[pkField]: true`를 지정했다면 주입·제거 모두 하지 않는다.
- **B30.** `args.omit?.[pkField] === true`(Prisma omit API)이면 `args.omit[pkField] = false`로 교체하고 B29와 동일하게 반환 전 제거한다.
- **B31.** 주입 결과 `result[pkField]`가 항상 존재하므로: `targetId`가 null이 되지 않고, create/upsert의 canonical 재조회(현행 `147-152`, `293-298`)가 복원되어 changes에 프로젝션과 무관한 **전체 필드 스냅샷**이 기록된다 (검증 보고서 Finding 5 해소).
- **B32.** 주입 로직 자체의 예외는 비즈니스 쿼리를 막지 않는다 — phase `'context'`로 보고 후 미주입 상태로 진행(0.1.0 동작으로 강등).
- **B33.** 검사는 top-level select/omit에 한정한다. 중첩 relation select는 건드리지 않는다. delete의 `select`는 주입 대상이 아니다(targetId는 pre-read에서 확보; pre-read와 result 양쪽 모두 PK가 없을 때만 null — 문서화된 edge).
- **B34.** update의 targetId 폴백(현행 `211-216`)에서 `String(null)` → 문자열 `"null"` 버그를 수정한다: `pkValue != null ? String(pkValue) : null`.

### ignoreTimestampOnlyUpdates (smaller fix)

- **B35.** 기본값 `false` — diff 동작은 0.1.0과 비트 단위로 동일하다.
- **B36.** `true`일 때 update 및 upsert의 update 분기에서 해당 모델의 `@updatedAt` 필드를 `computeUpdateChanges`의 `ignoreFields`로 전달한다. 그 결과 `@updatedAt` 필드는 **비어있지 않은 diff에서도 절대 등장하지 않는다** (Decisions D9).
- **B37.** `true`이고 pre-read가 성공해 `before`가 존재하며 제외 후 diff가 `{}`이면 감사 항목 생성을 **억제**한다(INSERT 없음, 보고 없음 — 정상 동작이지 에러가 아님). 순수 no-op update(아무 필드도 안 바뀜)도 동일하게 억제된다 — 문서화.
- **B38.** pre-read 실패로 `before === null`인 update는 억제하지 않는다(B10의 `preReadFailed` 항목 유지 — 빈 diff의 원인이 다름).
- **B39.** create/delete의 스냅샷 changes에는 `@updatedAt` 필드가 그대로 포함된다(전체 상태 기록은 노이즈가 아님).
- **B40.** `@updatedAt` 필드 결정: datamodel 확보 가능 시 `fields[].isUpdatedAt === true`인 필드명 집합(모델별로 1회 계산·메모이즈); datamodel 불가 시 리터럴 필드명 `'updatedAt'` 휴리스틱으로 폴백.

### prismaModule (smaller fix)

- **B41.** `options.prismaModule` 제공 시 `require('@prisma/client')`는 호출되지 않는다. `prismaModule.Prisma.defineExtension`으로 확장을 정의한다.
- **B42.** `prismaModule.Prisma.defineExtension`이 함수가 아니면 `createAuditExtension()`이 즉시 설명적 `Error`를 throw한다 (Public API Changes §8의 메시지).
- **B43.** `prismaModule` 미제공 + `@prisma/client` require 실패 시, raw `MODULE_NOT_FOUND` 대신 `prismaModule` 옵션을 안내하는 `Error`를 throw한다 (§8의 메시지, `cause` 체인 유지).
- **B44.** `prismaModule.Prisma.dmmf`가 없으면 B8(모델명 검증)과 B40의 dmmf 기반 감지만 비활성화되고 나머지는 정상 동작한다.

### prismaModule — AuditService 측 (smaller fix, 모듈 절반)

- **B46.** `AuditLogModuleOptions.prismaModule`(§3) 제공 시 `AuditService`는 정적
  `import { Prisma } from '@prisma/client'`(`src/services/audit.service.ts:2`) 대신
  생성자에서 §8의 `resolvePrismaNamespace({ prismaModule: options.prismaModule })`로
  네임스페이스를 1회 해소·보관하고, 모든 SQL 조립 — `log()` INSERT(스펙 01 §7의
  `Prisma.sql`/`Prisma.raw` 재작성), `query()`/`getById()`(스펙 05의
  `sql`/`raw`/`join`/`empty`) — 에 그 네임스페이스를 사용한다. 정적 import는 제거된다.
  미제공 + `@prisma/client` 미해소 시 B43과 동일한 안내 `Error`를 생성자(부트 경로)에서
  throw 한다. 결과: 커스텀 output 프로젝트에서 `AuditService` 로드/사용이 더 이상
  실패하지 않는다 — 확장(B41)과 합쳐 로드맵 smaller fix("순수 도입 차단 요인 제거")가
  완결된다.

### 중첩 관계 쓰기 경계 — 감지 경고 (smaller fix)

- **B45.** 추적 대상 모델의 뮤테이션에서 중첩 관계 쓰기를 감지하면 (모델, relation
  필드) 조합당 **프로세스당 1회** W5를 `logger*.warn`으로 출력한다(채널은 logger —
  `onAuditError`가 아니다: 실패가 아닌 경계 고지). 내부 테스트 헬퍼
  `_resetNestedWriteWarnings()`를 스펙 04 B14의 `_resetNoContextWarning()` 패턴으로
  제공한다:
  `[@nestarc/audit-log] nested write on <Model>.<relation> is not audited — only the top-level <Model> mutation is recorded. (full nested-write auditing is planned for 0.3.0)`
  - 감지 대상: create/update/upsert(create·update 분기 모두)의 `args.data`(upsert는
    `args.create`/`args.update`) **최상위 키** 중, 값이 중첩 쓰기 연산자 키
    (`create`/`createMany`/`connectOrCreate`/`update`/`updateMany`/`upsert`/`delete`/
    `deleteMany`/`set`)를 포함하는 객체인 것. datamodel 확보 가능 시(B8/B40과 동일
    경로) relation 필드(`kind === 'object'`)로 한정해 Json 스칼라 컬럼 오탐을
    제거하고, dmmf 부재 시 연산자 키 휴리스틱만 사용한다. `connect`/`disconnect`
    단독은 관계 연결로서 경고 대상이 아니다(부모 행 변경은 정상 감사됨).
  - 경고는 기록 억제가 아니다 — 부모 모델 항목은 현행대로 기록된다. 감지는 얕다
    (`args.data` 최상위 키만 — 더 깊은 중첩은 검사하지 않음). 감지 로직 자체는 **절대
    throw하지 않는다** — 전체를 try/catch로 감싸 예외 시
    `reportAuditError(options, error, { phase: 'context', model, operation })`로 보고만
    하고 뮤테이션·감사 기록 모두 정상 진행한다.
  - 경계 자체는 README "Nested writes" 섹션으로 문서화한다(Migration & Docs Impact).
    풀 감사는 0.3.0(로드맵 Out of Scope 승계) — 본 Behavior가 로드맵 smaller fix
    "경계 문서화 + 감지 경고"의 소유 스펙 배정이다(스펙 06 G6 체크리스트 항목).

### 핸들러별 try/catch 경계 이동 요약

공통 신규 골격 (update를 정본으로):

```ts
async update({ model, args, query }: any) {
  if (shouldSkip(model, trackedModels, ignoredModels)) return query(args);
  const pkField = getPkField(model, options);
  const delegate = (client as any)[modelDelegateName(model)];

  // [0] select/omit PK 주입 — 실패해도 진행 (B28-B32)
  const pkInjected = tryInjectPk(args, pkField, options, { model, operation: 'update' });

  // [1] pre-read — 격리 (B10)
  let before: any = null;
  let preReadFailed = false;
  try {
    before = await delegate.findFirst({ where: args.where });
  } catch (error) {
    preReadFailed = true;
    reportAuditError(options, error, { phase: 'pre-read', model, operation: 'update' });
  }

  // [2] 비즈니스 쿼리 — 감사가 절대 막지 않음 + logFailures (B21-B27)
  let result: any;
  try {
    result = await query(args);
  } catch (error) {
    if (options.logFailures && !isExpectedBusinessError(error)) {
      await tryLogFailure(client, options, { model, operation: 'update', args, before, pkField, error });
    }
    throw error; // 원본 동일 참조 rethrow
  }

  // [3] post-read — 격리, result로 폴백 (B14)
  let after: any = result;
  let postReadFailed = false;
  const beforePk = before?.[pkField];
  if (beforePk != null) {
    try {
      after = (await delegate.findFirst({ where: { [pkField]: beforePk } })) ?? result;
    } catch (error) {
      postReadFailed = true;
      reportAuditError(options, error, { phase: 'post-read', model, operation: 'update' });
    }
  }

  // [4] 조립 + 삽입 — 격리 (B15, B16, B36-B38)
  try {
    const changes = before
      ? computeUpdateChanges(before, after, sensitiveFields, updatedAtFieldsFor(model))
      : {};
    if (options.ignoreTimestampOnlyUpdates && before && isEmpty(changes)) {
      // B37: 억제
    } else {
      const pkValue = beforePk ?? result?.[pkField];
      const params = buildAuditInsertParams({
        action: `${model}.updated`,
        targetType: model,
        targetId: pkValue != null ? String(pkValue) : null,  // B34
        changes,
        metadata: auditFlags(preReadFailed, postReadFailed), // 둘 다 false면 undefined
        operation: 'update',
      }, options);
      if (params) await tryAuditLog(client, params, options, { model, operation: 'update' });
    }
  } catch (error) {
    reportAuditError(options, error, { phase: 'context', model, operation: 'update' });
  }

  // [5] 주입 PK 제거 후 반환 (B29)
  if (pkInjected) stripInjectedPk(result, pkField);
  return result;
}
```

| 핸들러 | 현행 경계 | 신규 경계 |
|---|---|---|
| create | pre-read 없음. canonical 재조회+조립+삽입이 한 try(139-164), catch `165-170` | [0] PK 주입 → [2] 쿼리(logFailures 랩) → [3] canonical 재조회를 별도 try로 분리(phase `'post-read'`, `canonical ?? result` 폴백 유지) → [4] 조립 catch는 phase `'context'`, 삽입은 tryAuditLog(phase `'insert'`) → [5] 주입 PK 제거 |
| update | pre-read `183-185` **try 밖**, catch `220-225` | 위 정본 골격. pre-read를 [1]의 전용 try로 이동(phase `'pre-read'`), catch `220-225`는 [3] `'post-read'` + [4] `'context'` 로 분해 |
| delete | pre-read `237-239` **try 밖**, catch `262-267` | [1] pre-read 격리(phase `'pre-read'`, 실패 시 `metadata.preReadFailed`) → [2] 쿼리 → [4] 조립 catch는 phase `'context'` (post-read 없음). PK 주입 없음(B33) |
| upsert | pre-read `280-282` **try 밖**, catch `326-331` | [0] PK 주입 → [1] pre-read 격리(실패 시 B12: action `${model}.upserted`) → [2] 쿼리 → [3] canonical 재조회 분리(`'post-read'`) → [4] `'context'` → [5] 제거 |
| createMany | 읽기 없음, catch `352-357` | [2] 쿼리(logFailures 랩) → [4] 조립 catch는 phase `'context'`, 삽입은 `'insert'`. 그 외 변경 없음(count-only 유지, #10은 0.3.0) |
| updateMany | 읽기 없음, catch `378-383` | createMany와 동일 |
| deleteMany | pre-read `395-397` **try 밖**, 루프 전체 catch `420-425` | [1] pre-read 격리(실패 시 B13 fallback 1건) → [2] 쿼리 → [4] **레코드별** try(B19): 조립 실패 `'context'`, 삽입 실패 `'insert'`, 다음 레코드 계속 |
| (공통) | `tryAuditLog` catch `105-117`: bare console.warn | `reportAuditError(..., { phase: 'insert', ... })` (B16, B17) |

## SQL / DDL

해당 없음. 본 스펙은 DDL을 변경하지 않는다.

- `insertAuditLog`의 변경은 바인드 파라미터 1개(89행 `${'success'}` → `${params.result}`)뿐이며 스키마 영향이 없다. `result` 컬럼은 0.1.0 스키마(`src/sql/audit-log-schema.sql`)에 이미 존재한다.
- INSERT 문의 테이블명(`audit_logs` 리터럴, `src/prisma/audit-extension.ts:75`)의 `tableName` 치환은 DDL/tableName 스펙(로드맵 #1/#11 — 스펙 01 §7) 소유. 확인 완료: 스펙 01의 `Prisma.raw(table)` 보간과 본 스펙의 `${params.result}` 바인드는 같은 `insertAuditLog` 함수를 수정하므로 한 PR에서 함께 적용한다.

## Error Handling

모든 실패 경로의 전수표. "보고"는 `reportAuditError` 경유: `onAuditError` 제공 시 콜백 호출(기본 warn 억제), 미제공 시 `logger*.warn`. 콜백 throw는 swallow + `logger*.error`(B18).

| # | 실패 지점 | phase | 비즈니스 연산 | 감사 항목 | 전파 |
|---|---|---|---|---|---|
| 1 | pre-read `findFirst`/`findMany` (update/delete/upsert/deleteMany) | `'pre-read'` | **정상 진행** (0.1.0에선 중단 — 수정) | 기록함: `changes:{}` 또는 스냅샷, `metadata.preReadFailed:true` (deleteMany는 B13 fallback 1건) | swallow |
| 2 | 비즈니스 쿼리 throw, `logFailures:false` | — | throw | 없음 | 원본 rethrow |
| 3 | 비즈니스 쿼리 throw, `logFailures:true`, 비제외 에러 | (기록 실패 시 `'insert'`) | throw | `result:'failure'` best-effort (B25) | 원본 동일 참조 rethrow (B22) |
| 4 | 비즈니스 쿼리 throw, P2025 또는 PrismaClientValidationError | — | throw | 없음 (B23-B24) | 원본 rethrow |
| 5 | post-read canonical 재조회 (create/update/upsert) | `'post-read'` | 정상 | 기록함: after=`result` 폴백, `metadata.postReadFailed:true` | swallow |
| 6 | diff 계산 / 파라미터 조립 / PK 주입 로직 | `'context'` | 정상 | 해당 항목 포기 (deleteMany는 해당 레코드만, B19) | swallow |
| 7 | 감사 INSERT (`tryAuditLog`) | `'insert'` | 정상 | 유실 (관측 가능) | swallow |
| 8 | `onAuditError` 콜백 자체 throw | — | 정상 | (무관) | swallow + `logger*.error` |
| 9 | 테넌트 해석 실패/부재 (`tenantRequired:true`) | `'tenant-resolution'` (로드맵 #4 — 스펙 03 소유) | 정상 | 스킵 (`buildAuditInsertParams` → null, B-T1) | swallow |
| 10 | `createAuditExtension()`/`AuditService` 생성자 설정 오류: `prismaModule.Prisma.defineExtension` 부재, `@prisma/client` 미해소 | — | (앱 부트 시점) | — | **throw** (B42, B43, B46 — 설정 오류는 fail-fast) |
| 11 | 중첩 쓰기 감지(W5) 로직 자체의 예외 | `'context'` | 정상 | 정상 기록 (경고만 생략) | swallow — `reportAuditError` phase `'context'` 보고 후 진행 (B45) |

원칙: **런타임(요청 경로)에서는 절대 throw하지 않고, 팩토리(부트 경로)의 설정 오류는 즉시 throw한다.** 단 하나의 의도된 런타임 throw는 logFailures의 원본 에러 rethrow(#3)이며 이는 호출자의 에러다.

## Test Plan

표기: [U]=unit, [E]=E2E(실제 PostgreSQL), (RG-n)=로드맵 Release Gate n 충족.

### Unit — `test/diff.spec.ts`

- T1. 진리표 전행 검증: (undefined,undefined)→true, (undefined,[])→true, ([],undefined)→false, ([],['X'])→false, (['A'],undefined)→A만 true, (['A'],['A'])→A true (allowlist 우선), (undefined,['A'])→A만 false — B1–B4. [U]
- T2. `computeUpdateChanges(b, a, [], ['updatedAt'])`: updatedAt만 변경 → `{}`; updatedAt+name 변경 → name만 포함 — B36. [U]
- T3. `ignoreFields` 미전달 시 0.1.0과 동일 결과(기존 스냅샷 테스트 불변) — B35. [U]

### Unit — `test/audit-extension.spec.ts` (mock client/delegate)

- T4. `createAuditExtension({})` → W1 warn 1회, 임의 모델 create가 감사 기록됨 — B1, B5, B9. [U]
- T5. 두 리스트 동시 지정 → W2; `trackedModels: []` → W3 + 모든 모델 skip — B6, B7. [U]
- T6. mock `prismaModule`(dmmf 포함)로 `trackedModels: ['Usr']` → W4에 'Usr' 포함; dmmf 없는 prismaModule → W4 미출력 — B8, B44. [U]
- T7. `logger` 옵션 제공 시 console이 아닌 주입 로거로 출력 — B5/B17 공통 전제. [U]
- T8. update/delete/upsert/deleteMany에서 pre-read mock이 reject → 비즈니스 query mock은 호출되고 결과 반환; `onAuditError` phase `'pre-read'` 1회; 항목 `metadata.preReadFailed` — B10–B13. (핸들러 4종 각각) [U]
- T9. upsert pre-read reject → action `${model}.upserted` — B12. [U]
- T10. deleteMany pre-read reject → `${model}.deletedMany` fallback 1건 + count — B13. [U]
- T11. post-read reject (create/update/upsert) → 항목 기록(after=result 폴백) + phase `'post-read'` + `metadata.postReadFailed` — B14. [U]
- T12. insert reject → phase `'insert'` 보고, 비즈니스 결과 정상 — B16. [U]
- T13. `onAuditError` 미제공 → logger.warn 폴백; 제공 → warn 미출력 — B17. [U]
- T14. `onAuditError`가 throw → swallow + logger.error, 결과 정상 — B18. [U]
- T15. deleteMany 3건 중 2번째 레코드 insert reject → 1·3번째는 기록됨 — B19. [U]
- T16. `logFailures: false`(기본) + query reject → insert 시도 0회, 동일 에러 객체 rethrow — B21. [U]
- T17. `logFailures: true` + query reject(P2003 등) → `result:'failure'` 항목 1건(action/changes/metadata/targetId 규칙 검증) 후 동일 참조 rethrow — B22, B25. (7개 핸들러 각각 action명 검증) [U]
- T18. `code:'P2025'` / `name:'PrismaClientValidationError'` → failure 항목 없음, rethrow만 — B23, B24. [U]
- T19. failure insert 자체 reject → phase `'insert'` 보고 + 원본 에러 rethrow 유지 — B26. [U]
- T20. `create({ select: { name: true } })` → query에 전달된 args.select에 pkField 포함, 기록된 targetId 非null, 반환 result에 pkField 없음 — B28, B29, B31. [U]
- T21. `select: { id: true, name: true }`(사용자가 PK 포함) → 주입·제거 없음, result에 id 유지 — B29. [U]
- T22. `omit: { id: true }` → omit 해제 + 반환 전 제거, targetId 확보 — B30. [U]
- T23. update에서 before 없음 + result에 PK 없음 → targetId가 문자열 `"null"`이 아닌 null — B34. [U]
- T24. `ignoreTimestampOnlyUpdates: true` + updatedAt만 변경된 update → INSERT 0회, onAuditError 0회; name+updatedAt 변경 → 항목 1건에 updatedAt 부재 — B36, B37. [U]
- T25. 동일 옵션 + pre-read 실패 → 억제되지 않고 preReadFailed 항목 기록 — B38. [U]
- T26. create/delete 스냅샷에 updatedAt 포함 — B39. [U]
- T27. dmmf로 `isUpdatedAt` 커스텀 필드명(`modifiedAt`) 감지; dmmf 부재 시 'updatedAt' 휴리스틱 — B40. [U]
- T28. `prismaModule` 제공 시 `@prisma/client` require 미발생(jest 모듈 mock으로 검증) — B41. [U]
- T29. `prismaModule.Prisma.defineExtension` 부재 → 팩토리 throw(메시지 검증); `@prisma/client` 미설치 시뮬레이션 → prismaModule 안내 메시지 throw — B42, B43. [U]
- T30. `buildAuditInsertParams`가 null 반환하도록 mock → 핸들러 insert 미시도·무보고 — B-T1. [U]
- T39. `computeUpdateChanges` mock throw → `onAuditError` phase `'context'` 보고, insert 미시도, 비즈니스 결과 정상 반환 — B15. [U]
- T40. `logFailures: true` + `tenantRequired: true` + 테넌트 부재 + query reject → failure insert 0회, 원본 에러 동일 참조 rethrow — B27 (B-T1 게이트가 [2] catch의 failure 경로에도 적용됨). [U]
- T41. 타입 전용(compile-only — tsd 또는 `--noEmit` 컴파일 spec): 커스텀 output으로 생성한 typed client 모듈 형태(`import * as client from './generated/client'`를 모사한 좁은 시그니처의 리터럴 타입)가 `prismaModule: PrismaModuleLike`에 할당 가능하고, `createAuditExtension(...)` 반환값이 `prisma.$extends(...)` 인자로 컴파일됨(`unknown` 회귀 방지) — §2 타이핑, §8 명시적 `any` 반환. [U]
- T42. `tryInjectPk` 강제 throw → phase `'context'` 보고, 쿼리는 원본(미주입) args로 실행, 결과 정상 — B32. [U]
- T43. `create({ select: { posts: { select: { title: true } } } })` → 중첩 relation select 불변(주입은 top-level만); `delete({ select: { name: true } })` → select 주입 없음 — B33. [U]
- T44. update에 `data: { posts: { create: [...] } }` → W5 1회(`User.posts` 명시), 같은 모델·relation 재호출 시 무경고(`_resetNestedWriteWarnings()` 후 재경고); 스칼라 필드만 있는 update는 무경고; dmmf 제공 시 Json 스칼라 컬럼의 연산자형 객체는 미경고; `connect` 단독은 미경고; 감지 로직 강제 throw → phase `'context'` 보고 + 뮤테이션·감사 기록 정상 (감지는 절대 throw하지 않음) — B45. [U]
- T45. `AuditService`를 `prismaModule` 제공 모듈 옵션으로 생성 → `@prisma/client` require 미발생(jest 모듈 mock), `log()`/`query()` SQL 조립이 주입 네임스페이스의 sql/raw/join 사용 — B46. [U]

### E2E — `test/e2e` (실제 PostgreSQL)

- T31. 옵션 없는 확장으로 create/update/delete → 3건 기록 (기본 전체 추적의 실DB 검증) — B1. [E]
- T32. `create({ select: { name: true } })` → `targetId` 非null + changes에 **전체 필드** 스냅샷 (검증 보고서 Finding 5 재현 케이스의 역전) — B31. [E]
- T33. **upsert E2E**: create 분기/update 분기 각 1회 + `upsert({ select })` 프로젝션 — B28, B31. (RG-3) [E]
- T34. **createMany/updateMany E2E**: count metadata 기록 + `logFailures` off/on 경로 — B21, B25. (RG-3) [E]
- T35. `logFailures: true`로 FK 위반 create 시도 → DB에 `result='failure'` 행 존재, 비즈니스 행 부재, 호출자에 원본 Prisma 에러 도달 — B22, B25. [E]
- T36. P2025 update(존재하지 않는 where) → failure 행 0건 — B23. [E]
- T37. `ignoreTimestampOnlyUpdates: true` + 동일 값 update(@updatedAt만 갱신) → audit_logs 행 증가 0 — B37. [E]
- T38. 커스텀 output으로 생성한 client를 `prismaModule`로 전달해 전체 추적 스모크 — B41. [E]

Release Gates 매핑: T33·T34가 **RG-3 (upsert/createMany/updateMany E2E)**에 기여한다 — 게이트 사인오프 소유는 스펙 06 G3(`test/e2e/batch-and-upsert.e2e-spec.ts`)이며 T33·T34는 그 파일에 수록한다. RG-1(롤백 회귀)은 스펙 06 G1, RG-2(HTTP 경로 E2E)는 스펙 06 G2(스펙 04 E1–E4/E6 수록), RG-4(append-only)는 스펙 06 G4(스펙 01 E1–E4/E7 연동), RG-5(CI 매트릭스)·RG-6(문서 정합성)은 스펙 06 G5/G6 소유. 단 본 스펙의 모든 신규 유닛 테스트는 RG-5의 피어 매트릭스(Nest 10/11 × Prisma 5/6)에서 통과해야 한다 — 특히 `omit`(B30)은 Prisma 5 구버전에 없으므로 조건부 스킵 처리.

## Migration & Docs Impact

### CHANGELOG (0.2.0, 최상단 BREAKING 노트 필수)

```markdown
## 0.2.0

### BREAKING CHANGES
- **Tracking default changed**: `createAuditExtension({})` (or with neither
  `trackedModels` nor `ignoredModels`) now audits **ALL models**. In 0.1.x it
  silently audited nothing. To keep the old narrow behavior, set
  `trackedModels: ['User', ...]` explicitly. An empty `ignoredModels: []` now
  also means "audit everything".
- **Empty allowlist now wins over a denylist**: if you passed `trackedModels: []`
  together with a non-empty `ignoredModels`, 0.1.x ignored the empty allowlist
  and applied the denylist (non-ignored models WERE audited); 0.2.0 treats the
  empty allowlist as authoritative and audits **nothing** (the W3 factory
  warning fires). Remove `trackedModels: []` to keep denylist behavior.

### Fixed
- Audit pre-reads (update/delete/upsert/deleteMany) no longer abort the
  business mutation when they fail; auditing degrades gracefully instead.
- `create`/`update`/`upsert` with a `select` (or `omit`) projection that omits
  the primary key no longer produce `targetId: null` audit rows.
- `update` no longer records the literal string "null" as targetId when the
  primary key cannot be resolved.

### Added
- `AuditSharedOptions`, `AuditErrorContext`, `AuditErrorPhase`, `AuditLogger` exported types.
- `onAuditError` / `logger` options: every audit failure is now observable.
- `logFailures` (opt-in): records `result='failure'` rows when the business
  query throws (P2025 and client-side validation errors excluded; the original
  error is always rethrown).
- `ignoreTimestampOnlyUpdates` (opt-in): suppresses `@updatedAt`-only update
  entries and removes the timestamp field from update diffs.
- `prismaModule` option (extension factory **and** module options): support for
  Prisma clients generated to custom output paths — `createAuditExtension` no longer
  hard-requires `@prisma/client`, and `AuditService`'s static `@prisma/client` import
  is removed (resolved via the same option).
- Nested-write boundary warning: a once-per-relation `logger.warn` is emitted when a
  tracked model mutation contains nested relation writes (nested writes are not
  audited — see the README "Nested writes" section).
- Factory-time configuration warnings (default-track-all notice, allowlist/denylist
  conflict, empty allowlist, unknown model names).
```

### tsconfig

`lib`를 `["ES2022"]`로 상향한다(`tsconfig.json` — `tsconfig.build.json`은 extends로
상속). `target: ES2021`은 유지. §8의 `new Error(message, { cause })`와 스펙 03 B14의
cause 래핑이 `lib.es2022.error`를 요구하기 때문(현행 `lib: ["ES2021"]`에서는 TS2554).
런타임은 Node 18+에서 기존 지원이므로 산출물 호환성 영향 없음.

(별도 검토: pre-read 격리는 사실상 버그 수정이므로 로드맵 #3의 제안대로 0.1.x 패치 선행 출시 후보 — 릴리스 매니저 결정 사항으로 남긴다.)

### README

- Options 표에 `logFailures`, `ignoreTimestampOnlyUpdates`, `prismaModule`, `onAuditError`, `logger` 추가. 기본 추적 동작 설명을 "configure nothing → audit everything"으로 갱신.
- 공유 옵션 패턴 예시 추가 (모듈/확장 간 병합이 없다는 명시 포함):

```ts
const auditShared: AuditSharedOptions = {
  tenantRequired: true,
  onAuditError: (err, ctx) => metrics.increment(`audit.${ctx.phase}_failed`),
};
AuditLogModule.forRoot({ prisma, actorExtractor, ...auditShared });
prisma.$extends(createAuditExtension({ ignoredModels: ['Session'], ...auditShared }));
```

- 커스텀 output 섹션: `prismaModule: require('./generated/client')` 예시 — 확장과
  `AuditLogModule.forRoot` 양쪽에 전달하는 패턴(B46).
- `logFailures` 캐비엇: 에러 메시지 metadata에 쿼리 인자가 일부 포함될 수 있음(500자 truncate), 노이즈 특성상 엄격 옵트인.
- 신규 "Nested writes" 경계 섹션 (B45): `user.update({ data: { posts: { create } } })`는
  부모(User)만 감사되고 중첩된 Post 쓰기는 기록되지 않음을 명시, W5 경고의 의미와
  모델·relation당 1회 정책, 풀 감사는 0.3.0 로드맵임을 안내.

### Design doc (`docs/2026-04-04-audit-log-design.md`)

- Registration 예시(36-55행)의 "화이트리스트" 서술과 Performance Considerations의 "trackedModels 화이트리스트로 추적 대상 제한"(246행)을 새 기본값 기준으로 갱신.
- Prisma Extension Behavior 표(213-225행)에 pre-read/post-read 실패 시 폴백 동작 열 추가.
- (248행 "원자성 보장" 수정은 로드맵 #5 스펙 소유 — 본 스펙에서 건드리지 않음.)

## Decisions

로드맵/할당 범위에서 본 스펙이 확정한 결정 (cross-cutting 고정 결정 외):

- **D1. `trackedModels: []`는 "추적 없음"으로 존중 + W3 경고.** 명시적으로 제공된 allowlist는 비어 있어도 사용자 의도로 취급한다(설정값을 침묵으로 뒤집지 않음). 대신 오타/실수 가능성이 높으므로 팩토리 경고로 fail-loud. `undefined`와 `[]`의 구분이 진리표의 축이 된다.
- **D2. `ignoredModels: []` → 전체 추적.** 빈 denylist는 "아무것도 제외하지 않음"이 자연 의미. 0.1.0의 "빈 denylist=전체 미추적"은 #2가 고치려는 바로 그 침묵 no-op이므로 함께 변경하고 BREAKING 노트에 포함.
- **D3. catch 분해와 phase 매핑.** 현행 핸들러당 1개의 광역 catch를 phase별 4개 경계(pre-read / post-read / context / insert)로 분해한다. phase 의미를 고정: `'pre-read'`=뮤테이션 전 감사용 읽기, `'post-read'`=뮤테이션 후 canonical 재조회, `'context'`=감사 컨텍스트의 획득·조립 실패 전반 — 확장 내 diff·파라미터 조립 등 비 I/O 감사 코드와, 스펙 04가 규정하는 미들웨어 `actorExtractor`/`correlationIdGetter` 실패 및 컨텍스트 store 부재 경고를 포함한다 —, `'insert'`=감사 INSERT, `'tenant-resolution'`=테넌트 해석(#4 — 스펙 03 전용). 단일 catch 유지 대비 구현이 커지지만, `onAuditError` 소비자(메트릭/알림)가 phase로 유실 원인을 분류할 수 있는 것이 #3의 존재 이유다.
- **D4. 읽기 실패 시 "항목 포기"가 아니라 "강등 기록".** pre-read 실패 → `changes:{}` + `preReadFailed`, post-read 실패 → `after=result` 폴백 + `postReadFailed`. 감사 행의 존재(무엇이 언제 일어났나)가 diff 충실도보다 우선한다는 컴플라이언스 원칙. metadata 플래그로 강등 사실 자체도 감사 가능. 본 스펙의 예약 metadata 키(`preReadFailed`/`postReadFailed`/`operation`/`error`/`count`)는 핸들러가 `input.metadata`로 전달하므로, 스펙 04의 병합 우선순위(`input.metadata` > `store.reason` > `store.metadata`, D4/B11)에 의해 사용자 `setMetadata`의 동일 키를 항상 이긴다 — 예약 키는 충돌 시 보존된다.
- **D5. deleteMany pre-read 실패 시 `${model}.deletedMany` fallback 1건.** 레코드별 기록이 불가능해진 상황에서 침묵하면 벌크 삭제 자체가 무기록이 된다. count-only 1건이라도 남기는 것이 fail-loud. `*.deletedMany`는 이 폴백과 logFailures 실패 항목에만 쓰이는 신규 action명으로 문서화.
- **D6. deleteMany 루프 레코드별 격리.** 현행 루프 전체 catch(420-425)는 2번째 레코드 실패가 3번째 이후 전부를 유실시킨다. N+1 구조는 #10(0.3.0)까지 유지하되 격리만 선행.
- **D7. logFailures 제외 목록은 P2025 + PrismaClientValidationError, duck-typed 고정 (옵션 없음).** P2025는 가드된 update/delete의 예상 결과, ValidationError는 DB 미도달 클라이언트 버그라 감사 가치가 없다. P2002(unique 위반)는 **포함** — 실패한 쓰기 시도는 보안 감사 신호다. 판정은 `error.code`/`error.name` duck-typing으로 하여 Prisma 에러 클래스 import(=커스텀 client 문제 재발)를 회피한다. 제외 목록 커스터마이즈 옵션은 수요 확인 전까지 추가하지 않는다(옵션 표면 최소화).
- **D8. upsert의 불확정 상태는 `${model}.upserted`.** pre-read 실패(B12)·logFailures 실패(B25)에서 create/update 분기를 알 수 없을 때 거짓 단정(`created`/`updated`) 대신 정직한 신규 action명을 쓴다.
- **D9. `ignoreTimestampOnlyUpdates: true`면 `@updatedAt` 필드는 비어있지 않은 update diff에서도 제거한다.** (할당된 결정 사항) 로드맵 문구 "모든 diff에서 updatedAt 노이즈 제거"를 채택 — 절반만 제거하면 "왜 어떤 행엔 있고 어떤 행엔 없나"는 더 큰 혼란. 단 create/delete 스냅샷은 전체 상태 기록이므로 유지(B39). 순수 no-op update가 함께 억제되는 것은 수용 가능한 의도된 동작으로 문서화(B37). 기본값은 0.2.0에서 `false`(비파괴) — 0.3.0에서 기본 true 전환 여부 재평가.
- **D10. 주입한 PK는 반환 전 제거.** 프로젝션 계약(반환 형태)을 호출자가 관찰할 수 없게 보존한다. `select[pkField]: false`는 부재와 동일 취급, Prisma `omit` API도 대칭 처리(B30). top-level만 검사(B33) — 중첩 쓰기는 0.3.0 경계.
- **D11. `prismaModule`은 모듈 네임스페이스 형태(`{ Prisma: { defineExtension, dmmf? } }`).** 현행 코드가 `require('@prisma/client')`에서 소비하는 것은 `Prisma.defineExtension` 단 하나(123-126행)이고, 본 스펙의 신규 수요는 `Prisma.dmmf.datamodel`(모델명 검증 B8, `isUpdatedAt` 감지 B40)이다. 따라서 사용자가 `require('./generated/client')` 결과를 그대로 넘기는 최소 형태로 고정. dmmf 부재 시 해당 기능만 우아하게 비활성(B44) — 미래 Prisma 버전의 dmmf 제거에 견딘다.
- **D12. 모드 announcement는 기본-전체-추적일 때만 warn으로 출력.** `AuditLogger`는 고정 결정상 `warn`/`error`만 가지므로 info 레벨이 없다. 명시적 allowlist/denylist 설정은 자기 문서적이므로 무출력, 주의가 필요한 4가지 상황(W1–W4)만 warn — 로드맵 #2의 "활성 모드 1회 로그"를 noise 없이 충족하는 해석.
- **D13. `String(null)` → `"null"` 문자열 버그(update 211-216) 동시 수정.** select 주입으로 도달 빈도는 줄지만 방어적으로 null 처리 통일(B34).
- **D14. `buildAuditInsertParams`의 null 반환을 테넌트 스킵의 공식 접합점으로 고정.** 핸들러 흐름(본 스펙)과 테넌트 규칙(#4 스펙)이 같은 지점에서 만나도록 반환 타입을 본 스펙에서 선언 — 예외가 아닌 반환값이므로 본 스펙의 catch들과 상호작용하지 않는다.

## Out of Scope

- **배치 연산 충실도 (#10)**: createMany/updateMany의 레코드별 diff, `*AndReturn` 후킹, deleteMany multi-row INSERT — 0.3.0. 본 스펙은 count-only 동작과 그 한계 문서를 유지한다.
- **중첩 관계 쓰기 풀 감사**: 0.3.0. 경계 문서화·감지 경고(로드맵 smaller fix)는 본 스펙 B45가 소유한다 — 0.2.0 범위. PK 주입도 top-level만(B33).
- **테넌트 해석 동작** (`tenantRequired` 자동 경로, `tenantResolver`, `query()` 격리): 로드맵 #4 — 스펙 03. 본 스펙은 `AuditSharedOptions` 정의와 B-T1 접합점만 제공.
- **`tableName` 검증·보간과 DDL/트리거/파티셔닝**: 로드맵 #1/#11 — 스펙 01. 본 스펙은 인터페이스 필드 선언만.
- **컨텍스트 metadata enricher / correlation ID / `@AuditReason`** (`buildAuditInsertParams` 내 병합): 로드맵 #9 — 스펙 04.
- **레다크션 강화** (`sensitiveFieldsByModel`, manual log metadata 레다크션): 스펙 03.
- **트랜잭션 정합성** (캡처된 base client, 롤백 고아 행): 로드맵 #5 — 스펙 06.
- ~~`AuditService`의 정적 `import { Prisma } from '@prisma/client'`~~ — 더 이상 Out of Scope가 아니다. 커스텀 output 문제의 모듈 측 절반은 **본 스펙 B46이 소유**한다(§3 `AuditLogModuleOptions.prismaModule`, T45). 네임스페이스 적용 지점은 스펙 01 §7(`log()` INSERT)과 스펙 05(`query()`/`getById()`)가 명시한다.
- logFailures 제외 목록 커스터마이즈 옵션, `ignoreTimestampOnlyUpdates`의 기본 true 전환, 추가 타임스탬프 필드 지정 옵션(`timestampFields`) — 수요 확인 후 0.3.0 재평가.
