# v0.2.0 Spec — Actor Context & Request Metadata

Date: 2026-06-11
Status: Historical v0.2.0 implementation specification — released; not the current package contract
Roadmap items: #8, #9

## Goal

HTTP 요청 밖(BullMQ, cron, 마이크로서비스 컨슈머)에서 실행되는 쓰기에 정확한 액터를
부여할 수 있게 하고, 모든 감사 항목에 요청 단위 메타데이터(커스텀 메타데이터,
Correlation ID, 변경 사유)를 병합하는 범용 프리미티브를 추가한다. 동시에 0.1.0의
침묵 실패 두 가지 — 컨텍스트 부재 시 무경고 `actorId: null / actorType: 'system'`
기록, 제외 수단 없는 무조건적 미들웨어/인터셉터 등록 — 를 fail-loud 원칙에 맞게
교정한다.

## Background

### 문제 1 — 동기 전용 ActorExtractor

`ActorExtractor`가 동기 시그니처로 고정되어 있다.

```typescript
// src/interfaces/actor.interface.ts:7 (현재)
export type ActorExtractor = (req: any) => AuditActor;
```

미들웨어도 반환값을 await 없이 그대로 사용한다.

```typescript
// src/middleware/audit-actor.middleware.ts:13-16 (현재)
use(req: any, _res: any, next: () => void): void {
  const actor = this.options.actorExtractor(req);
  AuditContext.run({ actor, noAudit: false }, next);
}
```

토큰 introspection, 세션 스토어 조회, API 키 DB 검증 같은 비동기 액터 식별이
불가능하다. Promise를 반환하면 `actor`가 Promise 객체 그대로 store에 들어가
`actor?.id`가 undefined → 모든 항목이 `actorId: null`로 침묵 기록된다.

### 문제 2 — 제외 불가능한 미들웨어/인터셉터 등록

```typescript
// src/audit-log.module.ts:19-21 (현재)
configure(consumer: MiddlewareConsumer): void {
  consumer.apply(AuditActorMiddleware).forRoutes('*');
}
```

```typescript
// src/audit-log.module.ts:31 (forRoot), :50 (forRootAsync) (현재)
{ provide: APP_INTERCEPTOR, useClass: AuditInterceptor },
```

- 미들웨어가 무조건 `forRoutes('*')` — health check, 메트릭 엔드포인트, 정적 파일
  등을 제외할 수단이 없다.
- 인터셉터가 무조건 전역 등록 — 사용자가 자체 인터셉터 순서를 제어하거나 특정
  모듈에만 적용하는 것이 불가능하다. `AuditInterceptor`와 `AuditActorMiddleware`는
  배럴(`src/index.ts`)에서 export조차 되지 않아 수동 구성 자체가 막혀 있다.
- bare `'*'`는 Nest 11 + Express 5(path-to-regexp v8)에서 deprecated 경로 문법이다.
  Nest 11은 `LegacyRouteConverter`로 변환해 주지만 기동 시 deprecation 경고를
  출력한다. README가 광고하는 Nest 10/11 매트릭스 양쪽에서 경고 없이 동작해야 한다.

### 문제 3 — 컨텍스트 부재의 침묵 실패

BullMQ 워커, `@Cron` 핸들러, `@MessagePattern` 컨슈머에서 실행되는 추적 대상 쓰기는
미들웨어를 거치지 않으므로 `AuditContext.getStore()`가 undefined이고, 모든 항목이
경고 한 줄 없이 `actorId: null / actorType: 'system'`이 된다
(`src/prisma/audit-extension.ts:48-62`의 `actor?.type ?? 'system'` 폴백).
사고 조사 시점에야 "누가 했는지 모르는" 행 더미를 발견하게 되는, #2(추적 기본값)와
동일 계열의 침묵 실패다. 핵심 능력(`AuditContext.run`)은 이미 공개되어 있으나
(`src/services/audit-context.ts:13-15`) 슈가도 문서도 없다.

### 문제 4 — 메타데이터 주입 수단 부재

`AuditContextStore`는 actor/noAudit/actionOverride만 보유한다
(`src/services/audit-context.ts:4-8`). 자동 추적 항목에 요청 단위 컨텍스트
(correlation ID, 변경 사유, feature flag 상태 등)를 싣는 방법이 없다.
`buildAuditInsertParams`는 핸들러가 넘긴 `input.metadata`를 그대로 통과시킬 뿐이다
(`src/prisma/audit-extension.ts:61`). `@AuditAction`은 액션명 오버라이드만 지원하고
(`src/decorators/audit-action.decorator.ts:3-5`,
`src/interceptors/audit.interceptor.ts:17-36`), audited gem의 `audit_comment`에
해당하는 변경 사유 기록 수단이 없다.

### Shared Decisions (applied)

이 스펙은 다음 고정된 cross-cutting 결정 위에 작성되었다 (재논의 없음):

- **결정 1**: `AuditLogModuleOptions`는 새 공유 인터페이스 `AuditSharedOptions`
  (`tableName` / `tenantRequired` / `tenantResolver` / `onAuditError` / `logger`)를
  extends 한다. 모듈/확장 간 런타임 병합은 없다.
- **결정 2**: `AuditErrorContext.phase`에 `'context'`가 포함된다. `AuditLogger`는
  `{ warn(message: string): void; error(message: string): void }`.
- **결정 8**: `AuditContext.setMetadata()` 병합은 `buildAuditInsertParams`
  (`src/prisma/audit-extension.ts:48-62`) 내부 한 곳에서 구현한다(핸들러별 수정 금지).
  Correlation ID는 모듈 옵션 `correlationIdHeader`(기본 `'x-request-id'`) +
  `correlationIdGetter`, `metadata.correlationId`로 저장. 변경 사유는
  `@AuditReason` + `AuditContext.setReason()`, `metadata.reason`으로 저장,
  요청 단위 적용 범위(`@AuditAction`과 동일한 blast radius).

## Public API Changes

### 1. `ActorExtractor` — 비동기 허용

```typescript
// src/interfaces/actor.interface.ts:7 (현재)
export type ActorExtractor = (req: any) => AuditActor;

// (제안)
export type ActorExtractor = (req: any) => AuditActor | Promise<AuditActor>;
```

### 2. `AuditActorMiddleware.use` — async + correlation ID 리프팅

```typescript
// src/middleware/audit-actor.middleware.ts:13-16 (현재)
use(req: any, _res: any, next: () => void): void {
  const actor = this.options.actorExtractor(req);
  AuditContext.run({ actor, noAudit: false }, next);
}

// (제안)
async use(req: any, _res: any, next: () => void): Promise<void> {
  let actor: AuditActor | null = null;
  try {
    actor = await this.options.actorExtractor(req);
  } catch (error) {
    this.reportContextError(error); // onAuditError(phase 'context') / logger 폴백 — Error Handling 참조
  }
  const metadata = this.resolveCorrelationMetadata(req); // { correlationId } | undefined
  AuditContext.run({ actor, noAudit: false, metadata }, next);
}
```

### 3. `AuditLogModuleOptions` — 공유 옵션 상속 + 신규 옵션 4종

```typescript
// src/interfaces/audit-log-options.interface.ts:4-9 (현재)
export interface AuditLogModuleOptions {
  prisma: any;
  actorExtractor: ActorExtractor;
  /** When true, query() throws if tenant context is unavailable. Default: false */
  tenantRequired?: boolean;
}

// (제안)
import { RouteInfo } from '@nestjs/common/interfaces';
import { AuditSharedOptions } from './audit-shared-options.interface'; // 스펙 02 소유

export interface AuditLogModuleOptions extends AuditSharedOptions {
  prisma: any;
  actorExtractor: ActorExtractor;
  /** AuditActorMiddleware 적용에서 제외할 라우트. consumer.exclude(...)로 전달된다. */
  excludeRoutes?: RouteInfo[];
  /** false면 APP_INTERCEPTOR 전역 등록을 생략한다. Default: true */
  registerGlobalInterceptor?: boolean;
  /** correlation ID를 읽을 요청 헤더명. Default: 'x-request-id' */
  correlationIdHeader?: string;
  /** 제공 시 헤더 조회를 완전히 대체하는 커스텀 getter. */
  correlationIdGetter?: (req: any) => string | undefined;
}
```

`tenantRequired`는 `AuditSharedOptions`로 이동하므로 인터페이스 본문에서 제거되지만
타입 표면은 동일하다(소비자 코드 무영향). (본 스펙 추가분만 표기 — 최종 모듈
인터페이스에는 스펙 02의 `prismaModule`(B46 — `AuditService`의 Prisma 네임스페이스
해소)과 스펙 03의 `sensitiveFields`/`sensitiveFieldsByModel`이 추가로
합류한다. 스펙 02 §3의 최종 합류 목록과 일치.)

### 4. `AuditLogModule` — 옵션 주입 + 스코핑 + 와일드카드 현대화

```typescript
// src/audit-log.module.ts:17-21, 31, 50 (현재)
@Module({})
export class AuditLogModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(AuditActorMiddleware).forRoutes('*');
  }
  // forRoot/forRootAsync 양쪽 providers에:
  // { provide: APP_INTERCEPTOR, useClass: AuditInterceptor },

// (제안)
@Module({})
export class AuditLogModule implements NestModule {
  constructor(
    @Inject(AUDIT_LOG_OPTIONS)
    private readonly options: AuditLogModuleOptions,
  ) {}

  configure(consumer: MiddlewareConsumer): void {
    const proxy = consumer.apply(AuditActorMiddleware);
    const excluded = this.options.excludeRoutes ?? [];
    const target = excluded.length > 0 ? proxy.exclude(...excluded) : proxy;
    target.forRoutes(resolveMiddlewareWildcard());
  }
  // forRoot/forRootAsync 공통 providers (제안):
  //   AuditInterceptor,                       // 항상 일반 프로바이더로 등록 (수동 바인딩용)
  //   ...(options.registerGlobalInterceptor !== false
  //     ? [{ provide: APP_INTERCEPTOR, useExisting: AuditInterceptor }]
  //     : []),
  // exports: [AuditService, AuditInterceptor]
}

/** @internal Nest 메이저 버전에 따라 '{*splat}' 또는 '*'를 반환 */
export function resolveMiddlewareWildcard(): string;
```

`forRootAsync`에서는 옵션이 팩토리 결과라 `registerGlobalInterceptor`를 provider
배열 구성 시점에 알 수 없으므로, `APP_INTERCEPTOR`는 `useFactory`로 등록하고 팩토리
내부에서 옵션을 보고 인터셉터 인스턴스 또는 no-op 인터셉터를 반환하는 방식 대신
**옵션 주입 후 분기하는 래퍼 인터셉터를 쓰지 않고**, `APP_INTERCEPTOR`
useFactory가 `options.registerGlobalInterceptor !== false`일 때만 실제
`AuditInterceptor`를, false면 패스스루(`intercept = (_, next) => next.handle()`)
객체를 반환한다 (Nest는 `APP_INTERCEPTOR` 등록 자체를 조건부로 만들 수 없는
async-factory 제약이 있음). `forRoot`(동기)는 provider 배열에서 직접 생략한다.

### 5. `AuditContextStore` / `AuditContext` — metadata, reason, runAs

```typescript
// src/services/audit-context.ts:4-8 (현재)
export interface AuditContextStore {
  actor: AuditActor | null;
  noAudit: boolean;
  actionOverride?: string;
}

// (제안)
export interface AuditContextStore {
  actor: AuditActor | null;
  noAudit: boolean;
  actionOverride?: string;
  metadata?: Record<string, unknown>;  // NEW — setMetadata 누적분 + correlationId 시드
  reason?: string;                     // NEW — @AuditReason / setReason
}
```

```typescript
// src/services/audit-context.ts:10-32 (현재 — 메서드 5종)
export class AuditContext {
  static run<T>(store: AuditContextStore, fn: () => T): T;
  static getStore(): AuditContextStore | undefined;
  static getActor(): AuditActor | null;
  static isNoAudit(): boolean;
  static getActionOverride(): string | undefined;
}

// (제안 — 기존 5종 무변경 + 신규 5종)
export class AuditContext {
  // ... 기존 메서드 동일 ...

  /** run({ actor, noAudit: false }, fn) 슈가. 새 store를 생성한다(부모 상속 없음). */
  static runAs<T>(actor: AuditActor, fn: () => T): T;

  /** 활성 store.metadata에 shallow merge. store 부재 시 no-op. */
  static setMetadata(obj: Record<string, unknown>): void;
  static getMetadata(): Record<string, unknown> | undefined;

  /** 활성 store.reason 설정. store 부재 시 no-op. */
  static setReason(reason: string): void;
  static getReason(): string | undefined;
}

/**
 * @internal 단일 병합 구현. buildAuditInsertParams와 AuditService.log()만 호출한다.
 * 우선순위: input > store.reason > store.metadata. 결과가 빈 객체면 undefined.
 */
export function mergeContextMetadata(
  input?: Record<string, unknown>,
): Record<string, unknown> | undefined;
```

### 6. `@AuditReason` 데코레이터 (신규 파일)

```typescript
// src/decorators/audit-reason.decorator.ts (신규 — audit-action.decorator.ts:3-5 미러)
import { SetMetadata } from '@nestjs/common';

export const AUDIT_REASON_KEY = 'AUDIT_REASON';
export const AuditReason = (reason: string) =>
  SetMetadata(AUDIT_REASON_KEY, reason);
```

### 7. `AuditInterceptor` — reason 읽기 추가

```typescript
// src/interceptors/audit.interceptor.ts:17-36 (현재 — NO_AUDIT_KEY, AUDIT_ACTION_KEY만 읽음)

// (제안 — intercept 내부, actionOverride 처리 직후 추가)
const reason = this.reflector.getAllAndOverride<string>(
  AUDIT_REASON_KEY,
  targets, // [context.getHandler(), context.getClass()] — 기존과 동일, handler가 class를 override
);
if (store && reason !== undefined) {
  store.reason = reason;
}
```

### 8. `buildAuditInsertParams` — 병합 단일 지점

```typescript
// src/prisma/audit-extension.ts:61 (현재)
    metadata: input.metadata,

// (제안)
    metadata: mergeContextMetadata(input.metadata),
```

같은 함수 진입부에 컨텍스트 부재 1회 경고(B14)를 위치시킨다. 7개 핸들러는 수정하지
않는다 (Shared Decision 8). 이 함수의 최종 병합 시그니처와 내부 처리 순서는
스펙 02 §6 / 스펙 03 §5가 고정한다: (0) 컨텍스트 부재 경고(본 스펙 B14, 진입부) →
(1) 테넌트 게이트(스펙 03) → (2) 본 단계의 metadata 병합 → (3) metadata 레다크션
(스펙 03 B24 — 병합 결과가 레다크션 대상에 포함된다).

### 9. `AuditService.log` — 동일 병합 적용

```typescript
// src/services/audit.service.ts:30-32 (현재)
    const metadataJson = input.metadata
      ? JSON.stringify(input.metadata)
      : null;

// (제안)
    const merged = mergeContextMetadata(input.metadata);
    const metadataJson = merged ? JSON.stringify(merged) : null;
```

병합 결과는 직렬화 전에 스펙 03 B23의 metadata 레다크션을 통과한다 — 순서는
자동 경로와 동일하게 병합 → 레다크션이며, correlationId/reason/setMetadata 분도
레다크션 대상에 포함된다.

### 10. 배럴 export 추가 (`src/index.ts`)

```typescript
export { AuditReason, AUDIT_REASON_KEY } from './decorators/audit-reason.decorator';
export { AuditInterceptor } from './interceptors/audit.interceptor';
export { AuditActorMiddleware } from './middleware/audit-actor.middleware';
```

(`registerGlobalInterceptor: false` 시 `@UseInterceptors(AuditInterceptor)` 수동
바인딩, 커스텀 미들웨어 구성에 필요.)

## Behavior Specification

**액터 추출 (async)**

- B1. `actorExtractor`가 `Promise<AuditActor>`를 반환하면 미들웨어는 resolve를
  await한 뒤 컨텍스트를 시작한다. `next()` 내부(컨트롤러/서비스)에서
  `AuditContext.getActor()`는 resolve된 액터를 반환한다.
- B2. `actorExtractor`가 동기 `AuditActor`를 반환하는 기존 코드는 무변경으로 동일하게
  동작한다 (하위 호환).
- B3. `actorExtractor`가 throw하거나 reject되면: (a) 요청은 중단되지 않고 `next()`가
  호출된다, (b) 컨텍스트는 `actor: null`로 생성된다, (c) 오류는
  `onAuditError(error, { phase: 'context' })`로 보고되고, `onAuditError` 미설정 시
  `(logger ?? console).error`로 출력된다.

**미들웨어 스코핑 / 인터셉터 등록**

- B4. `excludeRoutes`에 매칭되는 라우트에는 `AuditActorMiddleware`가 적용되지 않는다.
  해당 라우트에서 추적 대상 쓰기가 발생하면 컨텍스트 부재 경로(B14)를 따른다.
- B5. `registerGlobalInterceptor`가 생략되거나 true면 현행과 동일하게
  `APP_INTERCEPTOR`가 등록된다. false면 전역 등록이 생략되고, `AuditInterceptor`는
  일반 프로바이더로 등록·export되어 `@UseInterceptors(AuditInterceptor)` 수동
  바인딩이 동작한다 (`@NoAudit`/`@AuditAction`/`@AuditReason` 모두).
- B6. `resolveMiddlewareWildcard()`는 `@nestjs/core` 메이저 버전이 11 이상이면
  `'{*splat}'`, 10 이하 또는 판별 실패 시 `'*'`를 반환한다. Nest 11 + Express 5
  기동 시 `LegacyRouteConverter` deprecation 경고가 출력되지 않아야 하고,
  Nest 10 + Express 4에서 미들웨어가 모든 라우트에 적용되어야 한다.

**runAs / 컨텍스트 부재 경고**

- B7. `AuditContext.runAs(actor, fn)`은 `AuditContext.run({ actor, noAudit: false }, fn)`과
  동일하게 동작하며 `fn`의 반환값을 그대로 반환한다 (sync/async 모두).
- B14. 컨텍스트 store가 없는 상태(`AuditContext.getStore() === undefined`)에서 추적
  대상 쓰기가 `buildAuditInsertParams`에 도달하면, **프로세스당 1회** 경고를
  `onAuditError(syntheticError, { phase: 'context', model, operation, action })`으로
  보고한다 (`onAuditError` 미설정 시 `(logger ?? console).warn` 폴백). 합성 Error의
  메시지는 다음 리터럴로 고정한다(U15/E3가 정확 문자열을 단언):
  `'[@nestarc/audit-log] audited write executed without an audit context store — actorId will be null. Wrap background work in AuditContext.runAs(actor, fn). (warned once per process)'`.
  두 번째 이후
  발생은 무경고. 감사 행 자체는 현행대로 `actorId: null / actorType: 'system'`으로
  기록된다 (기록 억제 없음). 내부 테스트 헬퍼 `_resetNoContextWarning()`을
  `src/utils/tenant.ts:32-34`의 `_resetTenancyProbe` 패턴으로 제공한다.

**메타데이터 enricher**

- B8. `AuditContext.setMetadata(obj)`는 활성 store의 `metadata`에 shallow merge한다
  (`Object.assign` 의미론 — 동일 키는 마지막 호출이 승리). store 부재 시 no-op이며
  throw하지 않는다.
- B11. `buildAuditInsertParams`의 metadata 병합 결과는
  `{ ...store.metadata, ...(store.reason !== undefined ? { reason: store.reason } : {}), ...input.metadata }`
  이고, 결과가 빈 객체면 `undefined`를 유지한다 (metadata 없는 항목은 현행대로
  `NULL`::jsonb로 기록 — 0.1.0 행 형태와 동일).
- B12. `AuditService.log()`도 같은 `mergeContextMetadata` 헬퍼로 병합한다. 수동
  항목에도 correlationId / reason / setMetadata 분이 동일하게 실린다.
  `input.metadata`의 동일 키가 컨텍스트 분을 덮어쓴다.
- B13. 핸들러 고유 metadata와 컨텍스트 metadata는 공존한다. 예: createMany 항목은
  `{ count: 3, correlationId: 'req-1' }` 형태가 된다
  (`src/prisma/audit-extension.ts:349`의 count는 `input.metadata`로 전달되므로
  B11 우선순위상 보존된다).
- B16. `AuditContextStore`의 신규 필드는 모두 optional — 기존
  `AuditContext.run({ actor, noAudit }, fn)` 호출 코드는 무수정 컴파일된다.

**Correlation ID**

- B10. 미들웨어는 컨텍스트 시작 전에 correlation ID를 계산한다:
  (a) `correlationIdGetter`가 제공되면 `correlationIdGetter(req)`의 결과만 사용한다
  (헤더 폴백 없음 — undefined 반환 시 correlationId 없음),
  (b) 미제공 시 `req.headers[correlationIdHeader.toLowerCase()]`를 읽고
  (기본 `'x-request-id'`), 값이 배열이면 첫 요소를 취한다.
  결과가 비어 있지 않은 문자열이면 store를 `metadata: { correlationId }`로 시드한다.
  이후 B11에 의해 모든 자동/수동 항목의 `metadata.correlationId`로 기록된다.

**@AuditReason / setReason**

- B9. `@AuditReason('...')`이 핸들러 또는 클래스에 선언되면 인터셉터가
  `getAllAndOverride([handler, class])`로 읽어 `store.reason`을 설정한다
  (핸들러 선언이 클래스 선언을 override — `@AuditAction`과 동일 규칙,
  `src/interceptors/audit.interceptor.ts:18-25` 패턴). 데코레이터 부재 시
  `store.reason`은 건드리지 않는다.
- B15. 핸들러 본문에서 `AuditContext.setReason()`을 호출하면 데코레이터 값을
  덮어쓴다 (인터셉터가 핸들러 실행 전에 먼저 실행되므로 자연 순서). 하나의 reason이
  요청 내 **모든** 자동/수동 쓰기 항목에 적용된다 — `@AuditAction`과 같은
  요청 단위 blast radius이며 README에 명시 문서화한다.

## SQL / DDL

해당 없음. 이 스펙의 모든 신규 데이터(correlationId, reason, 커스텀 메타데이터)는
기존 `metadata JSONB` 컬럼에 저장되어 스키마 마이그레이션이 발생하지 않는다.

## Error Handling

| 실패 경로 | 처리 | 채널 |
|-----------|------|------|
| `actorExtractor` throw/reject (B3) | 요청 진행, `actor: null`로 컨텍스트 생성 | `onAuditError(error, { phase: 'context' })` → 폴백 `(logger ?? console).error` |
| `correlationIdGetter` throw | 요청 진행, correlationId 없이 컨텍스트 생성 | `onAuditError(error, { phase: 'context' })` → 폴백 `(logger ?? console).error` |
| 컨텍스트 store 부재 + 추적 대상 쓰기 (B14) | 감사 행은 현행대로 기록, 프로세스당 1회만 보고 | `onAuditError(new Error('[@nestarc/audit-log] audited write executed without an audit context store — actorId will be null. Wrap background work in AuditContext.runAs(actor, fn). (warned once per process)'), { phase: 'context', model, operation, action })` → 폴백 `(logger ?? console).warn` (B14의 고정 리터럴) |
| storeless `setMetadata` / `setReason` (B8) | 침묵 no-op (throw 없음, 문서화) | 없음 — B14 경고가 관측망 역할 |
| 병합된 metadata의 JSON 직렬화 실패 | 02 신뢰성 스펙의 `tryAuditLog` catch에 포착 (`src/prisma/audit-extension.ts:105-117`), 비즈니스 결과는 정상 반환 | `phase: 'insert'` (02 스펙 소관) |
| `excludeRoutes`에 잘못된 RouteInfo | Nest `consumer.exclude`가 기동 시 throw — 라이브러리는 검증/swallow하지 않음 | Nest 기동 오류 (fail-fast) |

원칙: 어떤 실패도 비즈니스 요청/쓰기를 중단시키지 않는다 (excludeRoutes 구성 오류는
기동 시점 fail-fast이므로 예외).

## Test Plan

### Unit

| # | 검증 대상 | Behavior |
|---|-----------|----------|
| U1 | 동기 extractor — next 내부에서 getActor() 일치 | B2 |
| U2 | async extractor — await 후 next, Promise 객체가 store에 들어가지 않음 | B1 |
| U3 | reject되는 extractor — onAuditError(phase 'context') 호출 + next 호출 + actor null | B3 |
| U4 | onAuditError 미설정 시 logger.error 폴백 | B3 |
| U5 | 기본 헤더 `x-request-id` → store.metadata.correlationId | B10 |
| U6 | 커스텀 correlationIdHeader + 배열 헤더값 첫 요소 선택 | B10 |
| U7 | correlationIdGetter 우선 / getter undefined 반환 시 헤더 폴백 없음 | B10 |
| U8 | getter throw → phase 'context' 보고 + 요청 진행 | B10, EH |
| U9 | runAs == run({actor, noAudit:false}) 등가성 (sync/async fn) | B7 |
| U10 | setMetadata shallow merge, last-write-wins, storeless no-op | B8 |
| U11 | 인터셉터: 핸들러/클래스 @AuditReason, 핸들러 override | B9 |
| U12 | setReason이 데코레이터 값을 덮어씀 | B15 |
| U13 | mergeContextMetadata 우선순위 (input > reason > context), 빈 결과 → undefined | B11, B13 |
| U14 | AuditService.log()에 correlationId/reason/setMetadata 병합 | B12 |
| U15 | 컨텍스트 부재 1회 경고: 첫 쓰기만 보고, _resetNoContextWarning 후 재보고, 채널 선택(onAuditError vs logger.warn), B14 고정 리터럴 정확 문자열 단언 | B14 |
| U16 | forRoot({registerGlobalInterceptor:false}) — APP_INTERCEPTOR 부재 + AuditInterceptor 주입 가능; forRootAsync 동등 동작 | B5 |
| U17 | resolveMiddlewareWildcard: 버전 mock별 반환값 (11→'{*splat}', 10→'*', 판별 실패→'*') | B6 |
| U18 | 기존 AuditContextStore 리터럴 컴파일 (타입 회귀) | B16 |

### E2E (실 PostgreSQL + 실 HTTP, supertest)

| # | 시나리오 | Behavior | Release Gate |
|---|----------|----------|--------------|
| E1 | HTTP POST → 미들웨어(헤더 x-request-id) → 인터셉터 → 컨트롤러 → Prisma create → 감사 행의 actorId/actorIp/metadata.correlationId 검증 | B1, B10, B11 | **Gate 2 (HTTP 미들웨어+인터셉터 경로 E2E)** — 게이트 소유는 스펙 06 G2; E1–E4/E6은 그 파일(`test/e2e/http-path.e2e-spec.ts`)에 수록 |
| E2 | `@AuditReason` 선언 핸들러의 update → metadata.reason 기록; 같은 요청 내 수동 log() 항목에도 동일 reason | B9, B12, B15 | Gate 2 |
| E3 | excludeRoutes 라우트의 쓰기 → actor null/'system' 행 + onAuditError(phase 'context') 1회 호출 | B4, B14 | Gate 2 |
| E4 | async actorExtractor(50ms 지연 세션 조회 모사) end-to-end | B1 | Gate 2 |
| E5 | HTTP 밖 시뮬레이션: runAs로 감싼 워커형 쓰기 → 지정 액터 기록 (쿡북 레시피 검증) | B7 | — |
| E6 | registerGlobalInterceptor:false + @UseInterceptors 수동 바인딩 → @AuditAction/@AuditReason 정상 | B5 | Gate 2 |
| E7 | createMany 항목에서 count + correlationId 공존 | B13 | Gate 3 (배치 E2E)와 공유 |

### CI 매트릭스

- E1/E3는 **Nest 10 + Express 4** 레그와 **Nest 11 + Express 5** 레그 양쪽에서
  실행한다 — **Gate 5 (CI 피어 매트릭스)는 스펙 06 G5 소유**이며, 스펙 06의
  `peer-matrix` job이 E2E 전체 수트(본 스펙 E1–E7 포함)를 4개 조합에서 실행한다.
  Nest 11 레그에서는 기동 로그에 `LegacyRouteConverter` deprecation 경고가 없음을
  assert한다 (B6).

## Migration & Docs Impact

### CHANGELOG (0.2.0)

- **Added**: `ActorExtractor`가 `Promise<AuditActor>` 반환을 지원 (비동기 토큰/세션 조회).
- **Added**: 모듈 옵션 `excludeRoutes`, `registerGlobalInterceptor`,
  `correlationIdHeader`, `correlationIdGetter`.
- **Added**: `AuditContext.runAs()` / `setMetadata()` / `getMetadata()` /
  `setReason()` / `getReason()`, `AuditContextStore.metadata` / `.reason`.
- **Added**: `@AuditReason()` 데코레이터 — 항목 `metadata.reason`으로 기록.
- **Added**: 모든 항목에 `metadata.correlationId` 자동 기록 (기본 헤더 `x-request-id`).
- **Added**: 배럴 export — `AuditInterceptor`, `AuditActorMiddleware`,
  `AuditReason`, `AUDIT_REASON_KEY`.
- **Changed**: 컨텍스트 store 없이 추적 대상 쓰기 실행 시 프로세스당 1회 경고
  (`onAuditError` phase `'context'`).
- **Fixed**: Nest 11/Express 5에서 미들웨어 `forRoutes('*')` deprecation 경고 제거.

### Breaking 여부

없음 (전부 additive). 단 타이핑 주의 1건: `ActorExtractor`의 반환 타입이 유니언으로
넓어지므로, 라이브러리 밖에서 `options.actorExtractor(req)`를 직접 호출해 동기
결과로 취급하던 (비정상적) 소비자 코드는 컴파일 오류가 날 수 있다 — CHANGELOG
각주로 안내.

### README

- 옵션 표에 신규 4종 추가, async extractor 예제(세션 조회), `runAs` 예제,
  `@AuditReason` 예제, correlation ID 섹션.
- `@AuditReason`/`@AuditAction`의 요청 단위 blast radius 명시 (B15).
- "background jobs는 actor가 비어 기록됩니다 → `runAs`를 쓰세요" 경고 박스 + 쿡북 링크.

### 설계 문서 (`docs/2026-04-04-audit-log-design.md`)

- Data Flow(200-211행)에 metadata/correlation 병합 단계 추가.
- Out of Scope의 "Microservice transport audit"(264행)에 "0.2.0부터 `runAs` 수동
  레시피로 부분 지원 — 쿡북 참조" 주석.

### 쿡북 (신규 docs 산출물) — `docs/2026-06-11-actor-context-cookbook.md`

목차 (각 레시피는 동작하는 코드 블록 + 검증 쿼리 포함):

1. **BullMQ 워커**: processor를
   `AuditContext.runAs({ id: 'worker:' + queueName, type: 'system' }, ...)`로 감싸기;
   `AuditContext.setMetadata({ correlationId: job.data.correlationId ?? String(job.id), jobName: job.name })`로
   HTTP 요청에서 enqueue 시 전달한 correlation ID 복원.
2. **Cron (@nestjs/schedule)**: `@Cron` 핸들러 본문 전체를 runAs로 래핑하는 패턴 +
   데코레이터 기반 래퍼 헬퍼를 직접 만드는 예시.
3. **마이크로서비스 (@MessagePattern/@EventPattern)**: HTTP 미들웨어가 실행되지
   않음을 명시; 메시지 페이로드/헤더(Kafka headers 등)에서 actor와 correlationId를
   추출해 핸들러 내 runAs + setMetadata로 복원하는 레시피; 전송 계층 공용 인터셉터
   직접 작성 예시 (`AuditInterceptor`는 reflector 기반이라 그대로 재사용 가능).
4. **시딩/CLI 스크립트**: `runAs({ id: 'cli:seed', type: 'system' }, ...)` vs
   감사 제외(`AuditContext.run({ actor: null, noAudit: true }, ...)`) 선택 가이드.
5. **Correlation ID 엔드투엔드**: 게이트웨이 → HTTP(미들웨어 자동) → BullMQ job
   data로 전파 → 워커에서 setMetadata 복원 → `query({ ... })`로 한 요청의 전체
   감사 트레일 조회하는 흐름.

## Decisions

- **D1. 컨텍스트 부재 경고 채널 = `onAuditError` phase `'context'`, 폴백
  `(logger ?? console).warn`** — 로드맵이 "onAuditError 또는 logger 중 택일"을
  요구. `AuditErrorContext`에 `'context'` phase가 고정 정의되어 있어 구조화 보고가
  1급 경로이고, 콜백 미설정 설치에서도 관측 가능해야 하므로 logger 폴백을 둔다.
  경고는 프로세스당 1회 (쓰기마다 반복하면 백그라운드 워커에서 로그 폭주).
- **D2. extractor 실패 시 요청 진행 + actor null** — "감사가 비즈니스를 깨지
  않는다"는 0.1.0 설계 약속 유지. 단 침묵하지 않고 phase 'context'로 보고한다.
  요청을 500으로 죽이는 strict 모드는 수요 확인 후 0.3.0 검토.
- **D3. `correlationIdGetter`는 헤더 조회를 완전히 대체 (폴백 없음)** — getter가
  undefined를 반환했는데 헤더로 폴백하면 "이 요청은 ID 없음"이라는 getter의 의도를
  무시하게 된다. 폴백이 필요하면 getter 안에서 직접 구현 가능.
- **D4. metadata 병합 우선순위: `input.metadata` > `store.reason` > `store.metadata`** —
  핸들러 고유 metadata(createMany의 `count` 등)는 연산 본질 정보라 최우선.
  `store.reason`은 전용 setter를 거친 의도적 값이므로 setMetadata로 우연히 들어온
  `reason` 키보다 우선.
- **D5. `excludeRoutes` 타입은 `RouteInfo[]` (string 미허용)** — `path` + `method`를
  강제해 "문자열 패턴이 어느 메서드에 적용되나" 모호성을 제거하고, Nest 10/11 간
  string 패턴 문법 차이(path-to-regexp 1.x vs 8.x)가 사용자 입력으로 새어
  들어오는 표면을 줄인다.
- **D6. 와일드카드는 `@nestjs/core/package.json` 런타임 버전 판별, 실패 시 `'*'`** —
  `'{*splat}'`은 Express 4 path-to-regexp에서 유효하지 않아 Nest 10을 깨므로 단일
  리터럴로 통일 불가. 판별 실패 폴백은 양쪽에서 "동작"하는 `'*'`(Nest 11에선
  deprecation 경고만 발생)로 안전 측에 둔다.
- **D7. 수동 `AuditService.log()`도 동일 병합 적용** — 로드맵 #9가 correlation ID를
  "모든 항목"에 요구한다. 단일 구현(Shared Decision 8)은
  `mergeContextMetadata` 함수 하나로 지키고, 호출 지점은
  `buildAuditInsertParams`(자동 경로 — 7개 핸들러 공통 단일 지점)와
  `AuditService.log`(수동 경로) 정확히 두 곳으로 제한한다.
- **D8. storeless `setMetadata`/`setReason`은 침묵 no-op** — `AuditContext`는 정적
  유틸이라 옵션/로거에 접근할 수 없고, 쓰기 시점의 B14 경고가 동일 상황을 더 정확한
  위치(실제 감사 유실 지점)에서 잡는다. 이중 경고는 노이즈.
- **D9. `runAs`는 새 store 생성 (부모 store의 metadata/reason 미상속)** —
  `AsyncLocalStorage.run` 의미론과 일치하고, 워커/cron의 주 용도에서 부모 컨텍스트는
  존재하지 않는다. 중첩 호출에서 상속이 필요하면
  `run({ ...AuditContext.getStore(), actor }, fn)`로 명시 가능 (쿡북에 기재).
- **D10. `registerGlobalInterceptor: false`여도 `AuditInterceptor`는 프로바이더로
  등록·export 유지** — 수동 `@UseInterceptors` 바인딩이 DI로 동작해야 하므로.
  forRootAsync는 `APP_INTERCEPTOR` useFactory 내부 분기(패스스루 반환)로 동등 동작을
  보장한다 (async 옵션은 provider 배열 구성 시점에 읽을 수 없음).

## Out of Scope

- **마이크로서비스/큐 전송 계층의 자동 컨텍스트 추출** — 0.2.0은 `runAs` + 쿡북
  레시피까지. 전송별 자동 어댑터(Kafka/RMQ/gRPC)는 수요 검증 후 0.3.0+.
- **쓰기 단위(reason-per-write) 사유 지정** — 요청 단위 blast radius만 제공 (B15).
  더 좁은 범위가 필요하면 중첩 `AuditContext.run`으로 우회 가능함을 문서화.
- **W3C traceparent / OpenTelemetry 자동 연동** — `correlationIdGetter`로 사용자
  구현 가능; 1급 연동은 보류.
- **metadata deep-merge / 중첩 경로 병합** — shallow merge만 (B8).
- **컨텍스트 metadata에 대한 레다크션** — 스펙 03(테넌트 격리·레다크션) 소관.
  `mergeContextMetadata`는 레다크션 적용 **이전** 단계에서 실행된다 — 처리 순서는
  스펙 03 §5/B24로 확정: 테넌트 게이트 → 병합 → 레다크션. 병합된 correlationId /
  reason / setMetadata 분도 레다크션 대상에 포함된다.
- **배치 연산(#10) 충실도** — createMany/updateMany 항목의 형태 변경 없음. 이 스펙은
  기존 count-only metadata에 컨텍스트 분이 병합되는 것(B13)까지만 보장한다.
- **Fastify 어댑터 공식 지원** — 미들웨어/헤더 접근은 Express 가정 유지
  (peer deps에 `@types/express`). Fastify는 미검증 상태로 명시.
