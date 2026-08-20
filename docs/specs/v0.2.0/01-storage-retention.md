# v0.2.0 Spec — Storage, Retention & Append-only Enforcement

Date: 2026-06-11
Status: Historical v0.2.0 implementation specification — released; not the current package contract
Roadmap items: #1 (보존 정책 + 파티셔닝 + prune API + GIN 인덱스), #11 (tableName 설정 + 트리거 기반 strict append-only — 0.2.0 승격)

## Goal

audit_logs 테이블의 전체 스토리지 수명주기를 라이브러리가 책임진다:

1. `getAuditTableSQL()`을 정적 파일 읽기에서 **옵션 기반 동적 DDL 생성**으로 전환한다
   (`tableName` / `partitioned` / `enforcement` / `ginIndex`).
2. **월별 RANGE 파티셔닝 레이아웃**을 추가하고, `ensurePartitions()` 헬퍼와
   `AuditService.prune({ olderThan })` API로 SOC2가 요구하는 보존 정책을 실행 가능하게 만든다.
3. append-only 강제를 침묵 no-op RULE에서 **`RAISE EXCEPTION` 트리거(fail-loud)** 로
   기본 전환하고, TRUNCATE/REVOKE 방어 가이드를 문서화한다.
4. 하드코딩된 `audit_logs` 리터럴 4곳을 검증된 `tableName` 옵션으로 대체한다.

스케줄러는 라이브러리에 포함하지 않는다(로드맵 Out of Scope). cron/pg_partman 레시피는 문서로 제공한다.

## Background

문제는 코드로 모두 재확인했다.

**(1) append-only RULE이 보존 정책을 불가능하게 만든다.**
`src/sql/audit-log-schema.sql:21-29`의 `DO INSTEAD NOTHING` RULE은 DELETE를 침묵
no-op으로 만든다. 결과적으로 테이블이 무한 증가하고, 자체 벤치마크조차 정리를 위해
RULE을 drop했다가 재생성하는 우회를 쓴다(`benchmarks/audit-overhead.ts:74-82`,
`cleanAuditLogs()`). 설계 문서는 retention/archival을 v0.2.0으로 명시적으로 미뤘다
(`docs/2026-04-04-audit-log-design.md:258-261`). SOC2 감사에서 "아무것도 못 지운다"는
보존 정책으로 인정되지 않는다.

**(2) 침묵 no-op RULE은 컴플라이언스 관점에서 잘못된 실패 모드다.**
현행 RULE은 UPDATE/DELETE 시도를 **에러 없이 0행 처리**한다 — 변조 시도가 일어났다는
신호조차 남지 않는다. 0.1.0 검증 보고서도 직접 probe로 이 동작을 확인했다
(`docs/2026-04-04-v0.1.0-validation-report.md:31`). 0.2.0의 주제(fail-loud)에 따라
`RAISE EXCEPTION` 트리거가 기본이 되어야 한다.

**(3) DDL이 정적 파일이라 어떤 변형도 제공할 수 없다.**
`src/sql/index.ts:4-6`:

```typescript
export function getAuditTableSQL(): string {
  return readFileSync(join(__dirname, 'audit-log-schema.sql'), 'utf-8');
}
```

파티셔닝 변형, GIN 인덱스 옵션(설계 문서 `docs/2026-04-04-audit-log-design.md:249`가
v0.2.0 항목으로 명시), 테이블명 변경 모두 불가능하다.

**(4) `'audit_logs'` 리터럴이 4개 SQL 문에 하드코딩되어 있다.**

| # | 위치 | 문 |
|---|------|----|
| 1 | `src/prisma/audit-extension.ts:75` | `INSERT INTO audit_logs ...` (자동 추적 INSERT) |
| 2 | `src/services/audit.service.ts:35` | `INSERT INTO audit_logs ...` (수동 `log()`) |
| 3 | `src/services/audit.service.ts:104` | `FROM audit_logs ${where}` (`query()` SELECT) |
| 4 | `src/services/audit.service.ts:109` | `SELECT COUNT(*) AS count FROM audit_logs ${where}` |

추가로 스키마 헬퍼(`src/sql/index.ts` 전체)와 RULE/인덱스명이 모두 `audit_logs` 전제다.
테이블 식별자는 바인드 파라미터가 될 수 없으므로, 화이트리스트 정규식 검증 후
`Prisma.raw` 보간만 허용한다.

## Public API Changes

### Shared Decisions (applied)

이 스펙은 v0.2.0 공통 결정 사항을 그대로 적용한다(재논의 없음):

- **공유 옵션 인터페이스** `AuditSharedOptions`를 신설하고
  `AuditExtensionOptions`/`AuditLogModuleOptions`가 이를 extends 한다.
  모듈↔확장 간 **런타임 병합은 없다** — 각 소비자가 자신의 복사본을 읽으며, 문서화된
  사용 패턴은 하나의 공유 상수를 두 호출부에 spread 하는 것이다.
- `AuditErrorContext` / `AuditLogger` 형태는 공통 결정 그대로 사용한다(전체 정의는
  신뢰성 스펙 — 스펙 02 — 이 소유; 본 스펙은 참조만 한다).
- `tableName`: 기본 `'audit_logs'`, `/^[a-zA-Z_][a-zA-Z0-9_]*$/` 검증(스키마 한정자
  `ident.ident` 1회 허용), 검증 **후에만** `Prisma.raw` 보간, 위반 시 팩토리/생성 시점 throw.
- `getAuditTableSQL(options?)`은 동적 생성으로 전환하며 zero-arg 호출은 형태상 하위
  호환(반환 타입 `string` 유지), 단 새 출력은 트리거 강제가 기본.
- 커스텀 Prisma client 주입(`prismaModule`)은 스펙 02(smaller fixes) 소유 —
  본 스펙의 확장 내 **및 `AuditService` 내**(§7) `Prisma.sql`/`Prisma.raw` 사용처는
  스펙 02의 `resolvePrismaNamespace()`(prismaModule → `require('@prisma/client')` 순)로
  해소된 네임스페이스를 사용해야 한다(서비스 측은 스펙 02 B46 — 정적
  `import { Prisma } from '@prisma/client'` 제거).

### 1. 공유 옵션 (신설 — `src/interfaces/audit-shared-options.interface.ts`, 정의 소유: 스펙 02)

아래는 스펙 02의 canonical 정의를 그대로 전재한 것이다(필드별 JSDoc은 스펙 02 원문
참조; 수정 시 스펙 02가 우선한다):

```typescript
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

본 스펙이 소비하는 필드는 `tableName`과 `logger`다. `tenantRequired`/`tenantResolver`/
`onAuditError`의 의미론은 신뢰성·테넌트 스펙이 정의한다.

### 2. `AuditExtensionOptions` — `src/prisma/audit-extension.ts:11-17`

현행:

```typescript
export interface AuditExtensionOptions {
  trackedModels?: string[];
  ignoredModels?: string[];
  sensitiveFields?: string[];
  /** Map of model name to primary key field name. Defaults to 'id'. */
  primaryKey?: Record<string, string>;
}
```

제안:

```typescript
export interface AuditExtensionOptions extends AuditSharedOptions {
  trackedModels?: string[];
  ignoredModels?: string[];
  sensitiveFields?: string[];
  /** Map of model name to primary key field name. Defaults to 'id'. */
  primaryKey?: Record<string, string>;
}
```

(본 스펙 관련 변경만 표기 — 최종 인터페이스에는 스펙 02의
`logFailures`/`ignoreTimestampOnlyUpdates`/`prismaModule`, 스펙 03의
`sensitiveFieldsByModel`, 스펙 06의 `experimentalTxAudit`이 추가로 합류한다.)

`createAuditExtension(options)` (`src/prisma/audit-extension.ts:119`)은 진입 시
`options.tableName`을 검증하고, 검증된 식별자를 `insertAuditLog`
(`src/prisma/audit-extension.ts:65-92`)의 `INSERT INTO` 대상으로 보간한다.
보간에 쓰는 `Prisma.sql`/`Prisma.raw`는 스펙 02의 `resolvePrismaNamespace()`가
해소한 네임스페이스(`PrismaModuleLike['Prisma']`의 `sql`/`raw`)에서 가져온다.

### 3. `AuditLogModuleOptions` — `src/interfaces/audit-log-options.interface.ts:4-9`

현행:

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
}
```

(`tenantRequired`는 `AuditSharedOptions`로 이동 — 의미 동일. 본 스펙 관련 변경만
표기 — 최종 모듈 인터페이스에는 스펙 02의 `prismaModule`(B46 — `AuditService`의
Prisma 네임스페이스 해소), 스펙 03의 `sensitiveFields`/`sensitiveFieldsByModel`,
스펙 04의 `excludeRoutes`/`registerGlobalInterceptor`/`correlationIdHeader`/
`correlationIdGetter`가 추가로 합류한다.)

문서화 사용 패턴 (런타임 병합 없음):

```typescript
const auditShared: AuditSharedOptions = {
  tableName: 'audit.audit_logs',
  tenantRequired: true,
  logger: myLogger,
};

// 확장 측
prisma.$extends(createAuditExtension({ ...auditShared, ignoredModels: ['Session'] }));

// 모듈 측
AuditLogModule.forRoot({ ...auditShared, prisma, actorExtractor });
```

### 4. DDL 헬퍼 — `src/sql/index.ts`

현행 (`src/sql/index.ts:4-6, 13, 50`):

```typescript
export function getAuditTableSQL(): string;
export function getAuditTableStatements(): string[];
export async function applyAuditTableSchema(prisma: any): Promise<void>;
```

제안 (`src/sql/ddl.ts` 신설, `src/sql/index.ts`에서 re-export):

```typescript
export interface AuditTableSQLOptions {
  /** 기본 'audit_logs'. 검증 규칙은 B1 참조 */
  tableName?: string;
  /** true면 PARTITION BY RANGE (created_at) 레이아웃. 기본 false */
  partitioned?: boolean;
  /**
   * append-only 강제 방식. 기본 'trigger' (RAISE EXCEPTION BEFORE UPDATE/DELETE).
   * 'rule'은 0.1.0 호환 레거시 모드 (침묵 DO INSTEAD NOTHING).
   */
  enforcement?: 'trigger' | 'rule';
  /** true면 changes/metadata JSONB에 GIN 인덱스 생성. 기본 false */
  ginIndex?: boolean;
}

export function getAuditTableSQL(options?: AuditTableSQLOptions): string;
export function getAuditTableStatements(options?: AuditTableSQLOptions): string[];
export async function applyAuditTableSchema(
  prisma: any,
  options?: AuditTableSQLOptions,
): Promise<void>;
```

정적 파일 `src/sql/audit-log-schema.sql`과 `readFileSync` 경로는 제거한다(Decisions D8).
`getAuditTableStatements`는 더 이상 텍스트 파싱이 아니라 생성 단계에서 문 배열을
직접 만들고, `getAuditTableSQL`은 `statements.join('\n\n')`이다.

같은 PR에서 `package.json`의 build 스크립트도 함께 변경한다:
`"build": "tsc -p tsconfig.build.json && cp src/sql/*.sql dist/sql/"` →
`"build": "tsc -p tsconfig.build.json"` (cp 단계 제거). 파일만 삭제하면 glob이
아무것도 매칭하지 못해 `cp`가 비-0으로 종료, 모든 빌드(스펙 06 G5 피어 매트릭스의
`npm run build` 포함)가 실패한다.

### 5. `ensurePartitions` (신설 — `src/sql/partitions.ts`)

```typescript
export interface EnsurePartitionsOptions {
  /** 기본 'audit_logs' */
  tableName?: string;
  /** 현재 월 이후로 미리 만들 개월 수. 기본 1 (= 이번 달 + 다음 달) */
  ahead?: number;
}

/**
 * 현재 월부터 ahead 개월까지의 월별 파티션을 멱등 생성한다.
 * @returns 이번 호출에서 새로 생성된 파티션 이름 목록
 */
export async function ensurePartitions(
  prisma: any,
  options?: EnsurePartitionsOptions,
): Promise<string[]>;
```

### 6. `AuditService.prune` (신설 — `src/services/audit.service.ts`)

```typescript
export interface AuditPruneOptions {
  /** 이 시각 이전 데이터를 정리 대상으로 한다 */
  olderThan: Date;
  /** 파티션 레이아웃 전용. 'drop'(기본): DROP TABLE, 'detach': DETACH 후 보존 */
  mode?: 'drop' | 'detach';
  /** true면 실행 없이 대상만 보고. 기본 false */
  dryRun?: boolean;
  /** 권한 있는 별도 PrismaClient (REVOKE 하드닝 적용 시 필수). 기본 module options.prisma */
  client?: any;
  /**
   * Flat 경로 인터랙티브 트랜잭션의 timeout(ms). `$transaction(fn, { timeout })`으로
   * 전달된다. 기본 60_000 — Prisma 기본값 5_000은 대형 테이블의 DELETE에서 거의
   * 항상 초과되어 prune이 P2028로 중단된다(B23).
   */
  timeoutMs?: number;
  /** Flat 경로 인터랙티브 트랜잭션의 maxWait(ms). 기본 10_000 (Prisma 기본 2_000) */
  maxWaitMs?: number;
}

export interface AuditPruneResult {
  layout: 'flat' | 'partitioned';
  /** 실제 수행(또는 dryRun 시 수행 예정) 동작 */
  mode: 'drop' | 'detach' | 'delete';
  /** partitioned: drop/detach 된 파티션 이름. flat: [] */
  prunedPartitions: string[];
  /** flat: 삭제(또는 dryRun 시 삭제 예정) 행 수. partitioned: null */
  deletedRows: number | null;
  dryRun: boolean;
}

// AuditService 메서드 추가 (src/services/audit.service.ts:15 클래스)
async prune(options: AuditPruneOptions): Promise<AuditPruneResult>;
```

### 7. SQL 사이트 변경 (시그니처 영향 없음, 구현 계약)

`src/prisma/audit-extension.ts:74-91` 현행:

```typescript
await client.$executeRaw`
  INSERT INTO audit_logs
    (tenant_id, actor_id, actor_type, actor_ip, action,
     target_type, target_id, source, changes, metadata, result)
  VALUES ( ... bind parameters ... )
`;
```

제안 (검증된 식별자만 `Prisma.raw`, 값은 전부 바인드 파라미터 유지):

```typescript
await client.$executeRaw(Prisma.sql`
  INSERT INTO ${Prisma.raw(table)}
    (tenant_id, actor_id, actor_type, actor_ip, action,
     target_type, target_id, source, changes, metadata, result)
  VALUES ( ... bind parameters ... )
`);
```

`src/services/audit.service.ts:35, 104, 109`도 동일하게 `${Prisma.raw(table)}`로 교체.
`table`은 생성자/팩토리에서 1회 검증·고정된 문자열이다(매 쿼리 재검증 불필요).
서비스 측이 사용하는 `Prisma.sql`/`Prisma.raw` 네임스페이스는 정적
`import { Prisma } from '@prisma/client'`(`src/services/audit.service.ts:2` — 제거됨)가
아니라 스펙 02 B46의 `resolvePrismaNamespace({ prismaModule: options.prismaModule })`로
생성자에서 1회 해소·보관한 것이다(조회 경로의 적용은 스펙 05가 명시).

### 8. 배럴 export — `src/index.ts:36`

현행:

```typescript
export { getAuditTableSQL, getAuditTableStatements, applyAuditTableSchema } from './sql';
```

제안 추가분:

```typescript
export {
  getAuditTableSQL,
  getAuditTableStatements,
  applyAuditTableSchema,
  ensurePartitions,
} from './sql';
export type { AuditTableSQLOptions, EnsurePartitionsOptions } from './sql';
// (아래 공유 타입 4종의 export 추가는 스펙 02 소유 변경 — 최종 상태 참고용 전재)
export type {
  AuditSharedOptions,
  AuditErrorContext,
  AuditErrorPhase,
  AuditLogger,
} from './interfaces/audit-shared-options.interface';
export type {
  AuditPruneOptions,
  AuditPruneResult,
} from './interfaces/retention.interface';
```

내부 유틸(공개 export 아님): `src/utils/table-name.ts`의
`assertValidAuditTableName(name: string): void`와
`deriveAuditObjectNames(tableName: string)` (트리거/룰/함수/인덱스/파티션 이름 파생).

## Behavior Specification

### tableName 검증과 스레딩

- B1. `tableName`은 `/^[a-zA-Z_][a-zA-Z0-9_]*$/`를 만족하는 식별자이거나, 같은 규칙을
  만족하는 두 부분을 `.`으로 연결한 `schema.table` 형태여야 한다. 위반 시
  `createAuditExtension()`, `AuditService` 생성자, DDL/파티션 헬퍼 진입 시점에
  즉시 `Error`를 throw 한다(메시지에 거부된 값과 허용 규칙 포함).
- B2. 한정자를 제외한 테이블 부분의 길이는 44자 이하여야 한다(위반 시 B1과 동일하게
  throw). 근거: 파생 객체명 최대 오버헤드 19자(`idx_<table>_tenant_created`)가
  PostgreSQL 식별자 한도 63바이트를 넘지 않게 하기 위함.
- B3. 검증을 통과한 `tableName`만 `Prisma.raw`로 SQL에 보간된다. 나머지 모든 값
  (tenant_id, action, olderThan 등)은 바인드 파라미터를 유지한다. `tableName`이
  바인드 파라미터로 전달되는 경로는 존재하지 않는다.
- B4. `tableName` 미지정 시 모든 소비자(확장, 서비스, DDL 헬퍼, ensurePartitions,
  prune)는 `'audit_logs'`를 사용한다 — 0.1.0과 동일 동작.
- B5. 4개 SQL 사이트(`src/prisma/audit-extension.ts:75`,
  `src/services/audit.service.ts:35,104,109`)는 각자 자신의 옵션 복사본
  (`AuditExtensionOptions.tableName` / `AuditLogModuleOptions.tableName`)을 읽는다.
  모듈↔확장 간 값 전달·병합은 없다. 두 값이 다르면 서로 다른 테이블에 쓰고 읽는다 —
  문서에 공유 상수 패턴(§Public API Changes 3)을 명시한다. 스펙 05가 `query()`를
  keyset으로 재작성하고 `getById()`를 추가한 후에도 모든 읽기 SQL은 같은 1회
  검증·고정된 `Prisma.raw(table)` 상수를 사용한다.
- B6. 파생 객체 이름 규칙 (`deriveAuditObjectNames`):
  - 트리거 함수: `<table>_block_mutation` (테이블과 같은 스키마에 생성)
  - 트리거: `<table>_no_update_trg`, `<table>_no_delete_trg`
  - RULE(레거시 모드): `<table>_no_update`, `<table>_no_delete`
  - 월별 파티션: `<table>_y<YYYY>m<MM>` (예: `audit_logs_y2026m06`)
  - 인덱스: `tableName === 'audit_logs'`(기본값)이면 0.1.0 레거시 이름
    (`idx_audit_tenant_created`, `idx_audit_actor`, `idx_audit_target`,
    `idx_audit_action`)을 유지하고, 그 외에는 `idx_<table>_<suffix>` 파생 이름을
    사용한다. 신규 인덱스는 항상 파생 규칙: `idx_audit_created_brin`(기본 테이블) /
    `idx_<table>_created_brin`, GIN은 `idx_audit_changes_gin`·`idx_audit_metadata_gin`
    (기본 테이블) / `idx_<table>_changes_gin`·`idx_<table>_metadata_gin`.

### DDL 생성

- B7. `getAuditTableSQL()` (zero-arg)은 `string`을 반환하고(형태 하위 호환), 출력은
  flat 레이아웃 + **트리거 강제**(enforcement 기본 'trigger') + GIN 없음이다.
  컬럼 정의는 0.1.0(`src/sql/audit-log-schema.sql:4-18`)과 동일하다.
- B8. enforcement `'trigger'` 출력은 (a) 레거시 RULE 2개의 `DROP RULE IF EXISTS`,
  (b) `CREATE OR REPLACE FUNCTION <table>_block_mutation`, (c) `DROP TRIGGER IF
  EXISTS` + `CREATE TRIGGER` (BEFORE UPDATE / BEFORE DELETE, FOR EACH ROW)를
  포함한다. 전체가 멱등이어서 기존 0.1.0 설치 위에 재적용해도 안전하며, 재적용 시
  강제 방식이 RULE → 트리거로 업그레이드된다.
- B9. enforcement `'rule'` 출력은 0.1.0과 동일한 `DO $$ ... CREATE RULE ... EXCEPTION
  WHEN duplicate_object ...` 블록을 생성한다(레거시 호환 전용, 문서에 침묵 no-op
  한계 명시).
- B10. `partitioned: true` 출력은 `PARTITION BY RANGE (created_at)`, `PRIMARY KEY
  (id, created_at)`, `created_at` BRIN 인덱스, 기존 4개 보조 인덱스, 강제 DDL,
  그리고 **생성 시점 기준 현재 월 + 다음 월** 2개의 초기 파티션 DDL을 포함한다.
  DEFAULT 파티션은 생성하지 않는다(Decisions D1).
- B11. `partitioned: true` + `enforcement: 'rule'` 조합은 허용하되, RULE은 부모
  테이블에만 적용되어 파티션 직접 DML을 막지 못하므로 라이브러리 문서와
  생성 SQL 주석에 경고를 포함한다. 트리거 모드는 FOR EACH ROW 트리거가 모든
  파티션(신규 생성 포함)에 복제되므로 파티션 직접 DML도 차단된다.
- B12. `ginIndex: true`는 `changes`, `metadata` 두 컬럼에 `jsonb_path_ops` GIN
  인덱스를 추가한다. 기본 false(쓰기 증폭·인덱스 크기 비용 옵트인).
- B13. `getAuditTableStatements(options?)`는 같은 옵션으로 생성된 문 배열을 반환하고,
  `applyAuditTableSchema(prisma, options?)`는 그 배열을 순서대로
  `$executeRawUnsafe`로 실행한다(현행 `src/sql/index.ts:50-54` 패턴 유지).
  `getAuditTableSQL(options) === getAuditTableStatements(options).join('\n\n')`.
- B13a. `applyAuditTableSchema(prisma, { partitioned: true })`는 첫 DDL 실행 전
  `SELECT relkind FROM pg_class WHERE oid = to_regclass($1)`로 대상 테이블을
  프리체크한다(B17/B19와 동일 패턴). 테이블이 존재하고 `relkind = 'r'`(기존 0.1.0
  flat 테이블)이면 §SQL/DDL 8의 마이그레이션 절차를 안내하는 설명적 `Error`를
  throw하고 **어떤 문도 실행하지 않는다**. 프리체크가 없으면 `CREATE TABLE IF NOT
  EXISTS ... PARTITION BY`가 기존 flat 테이블 위에서 침묵 no-op된 뒤 후속
  `CREATE TABLE ... PARTITION OF`가 42809("is not partitioned")로 중도 실패해 헬퍼가
  half-applied 상태로 남는다. flat 출력(`partitioned` 미지정)의 재적용 멱등성(B8)은
  영향받지 않는다.
- B14. 모든 DDL 헬퍼는 진입 시 B1/B2 검증을 수행한다. 월 경계는 **UTC** 기준이다
  (파티션 범위 리터럴은 `TIMESTAMPTZ '... +00'`). §SQL/DDL 8의 수동 마이그레이션
  레시피도 같은 UTC 그리드를 전제하므로 **UTC 세션을 요구**한다 — 트랜잭션 첫 문이
  `SET LOCAL TIME ZONE 'UTC'`다(`date_trunc`/`format %L`이 세션 TimeZone에
  의존하기 때문 — D2).

### ensurePartitions

- B15. `ensurePartitions(prisma, { ahead = 1 })`는 UTC 기준 현재 월부터 `현재 월 +
  ahead` 월까지(총 `ahead + 1`개)의 파티션을 검사하고, 없는 것만 `CREATE TABLE ...
  PARTITION OF ... FOR VALUES FROM ... TO ...`로 생성한다. 반환값은 **새로 생성된**
  파티션 이름 배열이다(전부 존재하면 `[]`).
- B16. 존재 검사는 `SELECT to_regclass($1)`로 수행한다(파티션 이름은 테이블과 같은
  스키마로 한정). 멱등: 동시 실행 경합으로 `duplicate_table`(42P07)이 발생하면
  무시하고 해당 파티션을 "생성 안 함"으로 처리한다.
- B17. 대상 테이블이 존재하지 않거나 `relkind <> 'p'`(파티션 테이블 아님)이면 즉시
  throw 한다. `ahead < 0` 또는 정수가 아니면 throw 한다.
- B18. 권장 운용(문서): 앱 부트스트랩에서 1회 + 일일 cron. 파티션이 없는 월에 도달하면
  자동 감사 INSERT가 실패하며, 이는 `tryAuditLog`의 catch
  (`src/prisma/audit-extension.ts:111-116`, 신뢰성 스펙 적용 후 `onAuditError`
  phase `'insert'`)로 관측된다 — 비즈니스 쿼리는 영향받지 않는다.

### prune

- B19. `prune()`은 먼저 `SELECT relkind FROM pg_class WHERE oid = to_regclass($1)`로
  레이아웃을 판별한다: `'p'` → partitioned 경로, `'r'` → flat 경로, 그 외/NULL →
  throw (테이블 없음).
- B20. **Partitioned 경로**: `pg_inherits` + `pg_get_expr(relpartbound)`로 모든
  파티션의 범위를 읽고, **상한(TO 경계)이 `olderThan` 이하인 파티션만** 대상으로
  한다. `mode: 'drop'`(기본)은 `DROP TABLE`, `mode: 'detach'`는 `ALTER TABLE ...
  DETACH PARTITION`을 파티션별로 실행한다. 부분 파티션 삭제는 하지 않는다 —
  정리 입도는 월 단위이며, `olderThan`이 속한 파티션은 절대 건드리지 않는다.
- B20a. partitioned 경로에서 개별 파티션의 DROP/DETACH가 실패하면: 직전까지 성공한
  파티션은 유지되고(파티션별 자율 커밋) 즉시 throw한다. throw되는 `Error` 메시지는
  실패한 파티션 이름·원인과 함께 **이번 호출에서 이미 성공(드롭/디태치)한 파티션
  이름 목록**을 반드시 포함한다 — 운영자가 부분 진행 상태를 파악하고 재시도할 수
  있어야 한다(테스트 가능한 계약 — E6c).
- B21. detach 된 파티션은 독립 일반 테이블로 남는다(이름 유지). 아카이브(pg_dump 등)
  후 운영자가 직접 DROP 하는 워크플로를 문서화한다. DML 차단 트리거 잔존 여부는
  PostgreSQL 버전에 따라 다를 수 있으므로 아카이브 절차에 확인 단계를 포함한다.
- B22. **Flat 경로**: 강제 방식을 런타임 감지한다 — `pg_trigger`에서
  `<table>_no_delete_trg`, `pg_rewrite`에서 `<table>_no_delete`를 조회.
  - 트리거 감지 시: 단일 트랜잭션에서 `ALTER TABLE ... DISABLE TRIGGER
    <table>_no_delete_trg` → `DELETE FROM <table> WHERE created_at < $1` →
    `ENABLE TRIGGER` 실행.
  - RULE 감지 시(0.1.0 레거시): 단일 트랜잭션에서 `DROP RULE` → `DELETE` →
    `CREATE RULE` 실행 — `benchmarks/audit-overhead.ts:74-82`의 수동 댄스를
    공식 API로 흡수.
  - 둘 다 없으면: 강제 부재를 `logger.warn`으로 알리고 plain `DELETE`만 실행.
- B23. Flat 경로의 DDL+DML은 **하나의 인터랙티브 트랜잭션**으로 묶는다. PostgreSQL
  DDL은 트랜잭션이므로 중간 실패 시 전체 롤백되어 강제가 꺼진 채 방치되는 상태가
  불가능하다. 트랜잭션은 `client.$transaction(fn, { timeout: timeoutMs ?? 60_000,
  maxWait: maxWaitMs ?? 10_000 })`으로 연다 — Prisma 인터랙티브 트랜잭션의 기본
  timeout 5_000ms는 대형 flat 테이블의 수개월치 DELETE에서 거의 항상 초과되어
  prune이 P2028로 중단되므로, 기본값을 60초로 올리고 `AuditPruneOptions.timeoutMs`/
  `maxWaitMs`(§6)로 조정 가능하게 한다(README Retention 섹션에 명시). 트랜잭션 동안
  `ALTER TABLE`/`DROP RULE`의 ACCESS EXCLUSIVE 락이 테이블 쓰기를 차단함을 문서에
  명시한다(대형 flat 테이블이면 파티셔닝 마이그레이션 권장).
- B24. `dryRun: true`: partitioned 경로는 대상 파티션 이름만 반환하고 DDL을 실행하지
  않는다. flat 경로는 `SELECT COUNT(*) ... WHERE created_at < $1` 결과를
  `deletedRows`로 반환하고 DELETE를 실행하지 않는다.
- B25. `options.client`가 주어지면 모든 prune SQL은 해당 클라이언트로 실행된다
  (REVOKE 하드닝 환경에서 앱 커넥션은 DELETE/DDL 권한이 없으므로). 미지정 시
  `this.options.prisma`. 필요 권한(테이블 소유자 또는 superuser)을 문서화한다.
- B26. `prune()`/`ensurePartitions()`의 실패는 **throw로 전파**한다.
  `onAuditError`는 사용하지 않는다 — 두 API는 명시적 관리 호출이며,
  `AuditErrorContext.phase` 열거형에도 해당 phase가 없다(공통 결정 2 준수).
- B27. partitioned 경로에서 `mode`를 생략하면 `'drop'`이다. flat 경로에서 `mode`가
  지정돼도 무시하고 `'delete'`로 보고한다(throw 하지 않음 — 레이아웃 전환기에
  동일 호출 코드를 유지할 수 있게).

### Append-only 강제 (런타임 의미론)

- B28. 트리거 모드에서 `UPDATE`/`DELETE`는 행 단위로
  `P0001` 예외(`@nestarc/audit-log: <OP> blocked on append-only table <name>`)를
  발생시킨다. 0행 매치 문은 예외 없이 성공한다(FOR EACH ROW이므로).
- B29. RULE 모드(레거시)는 0.1.0과 동일하게 침묵 0행 no-op이다. 문서에 "변조 시도가
  관측 불가능"한 한계와 트리거 모드 권장을 명시한다.
- B30. `TRUNCATE`는 RULE/행 트리거 어느 쪽도 차단하지 못한다. 방어는 권한 분리
  (REVOKE 레시피, §SQL/DDL 6)뿐이며, 소유자/superuser는 항상 우회 가능함을 문서에
  명시한다 — DB 레벨 불변성의 정직한 경계 서술(설계 문서 `:253` 갱신과 연동).

## SQL / DDL

### 1. Flat 레이아웃 — enforcement 'trigger' (신규 기본, `getAuditTableSQL()` 출력)

```sql
-- @nestarc/audit-log v0.2.0 — flat layout, trigger enforcement
CREATE TABLE IF NOT EXISTS audit_logs (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     TEXT,
  actor_id      TEXT,
  actor_type    TEXT NOT NULL DEFAULT 'user',
  actor_ip      TEXT,
  action        TEXT NOT NULL,
  target_type   TEXT,
  target_id     TEXT,
  source        TEXT NOT NULL DEFAULT 'auto',
  changes       JSONB,
  metadata      JSONB,
  result        TEXT NOT NULL DEFAULT 'success',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Legacy rule cleanup (upgrades 0.1.0 installs in place)
DROP RULE IF EXISTS audit_logs_no_update ON audit_logs;
DROP RULE IF EXISTS audit_logs_no_delete ON audit_logs;

-- Append-only enforcement: fail-loud trigger (SOC2)
CREATE OR REPLACE FUNCTION audit_logs_block_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '@nestarc/audit-log: % blocked on append-only table %',
    TG_OP, TG_TABLE_NAME
    USING ERRCODE = 'P0001',
          HINT = 'Use AuditService.prune() for retention maintenance.';
END;
$$;

DROP TRIGGER IF EXISTS audit_logs_no_update_trg ON audit_logs;
CREATE TRIGGER audit_logs_no_update_trg
  BEFORE UPDATE ON audit_logs
  FOR EACH ROW EXECUTE FUNCTION audit_logs_block_mutation();

DROP TRIGGER IF EXISTS audit_logs_no_delete_trg ON audit_logs;
CREATE TRIGGER audit_logs_no_delete_trg
  BEFORE DELETE ON audit_logs
  FOR EACH ROW EXECUTE FUNCTION audit_logs_block_mutation();

-- Query performance indexes (0.1.0 호환 이름 유지 — B6)
CREATE INDEX IF NOT EXISTS idx_audit_tenant_created ON audit_logs (tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_actor ON audit_logs (actor_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_target ON audit_logs (target_type, target_id);
CREATE INDEX IF NOT EXISTS idx_audit_action ON audit_logs (action);
```

### 2. enforcement 'rule' (레거시 모드) — 트리거 블록 대신 생성

```sql
DO $$ BEGIN
  CREATE RULE audit_logs_no_update AS ON UPDATE TO audit_logs DO INSTEAD NOTHING;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE RULE audit_logs_no_delete AS ON DELETE TO audit_logs DO INSTEAD NOTHING;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
```

### 3. Partitioned 레이아웃 — `getAuditTableSQL({ partitioned: true })`

PostgreSQL 13+ 필요(파티션 부모의 BEFORE ROW 트리거 + 내장 `gen_random_uuid()`).
2026-06-11에 생성한 출력 예시:

```sql
-- @nestarc/audit-log v0.2.0 — partitioned layout (PostgreSQL 13+)
CREATE TABLE IF NOT EXISTS audit_logs (
  id            UUID NOT NULL DEFAULT gen_random_uuid(),
  tenant_id     TEXT,
  actor_id      TEXT,
  actor_type    TEXT NOT NULL DEFAULT 'user',
  actor_ip      TEXT,
  action        TEXT NOT NULL,
  target_type   TEXT,
  target_id     TEXT,
  source        TEXT NOT NULL DEFAULT 'auto',
  changes       JSONB,
  metadata      JSONB,
  result        TEXT NOT NULL DEFAULT 'success',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT audit_logs_pkey PRIMARY KEY (id, created_at)
) PARTITION BY RANGE (created_at);

-- (enforcement DDL — §1과 동일. FOR EACH ROW 트리거는 모든 파티션에 복제된다)

-- Retention-friendly index
CREATE INDEX IF NOT EXISTS idx_audit_created_brin ON audit_logs USING BRIN (created_at);

-- Query performance indexes (partitioned indexes — 파티션별 자동 생성)
CREATE INDEX IF NOT EXISTS idx_audit_tenant_created ON audit_logs (tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_actor ON audit_logs (actor_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_target ON audit_logs (target_type, target_id);
CREATE INDEX IF NOT EXISTS idx_audit_action ON audit_logs (action);

-- Initial partitions (generation-time: current month + 1, UTC)
CREATE TABLE IF NOT EXISTS audit_logs_y2026m06 PARTITION OF audit_logs
  FOR VALUES FROM ('2026-06-01 00:00:00+00') TO ('2026-07-01 00:00:00+00');
CREATE TABLE IF NOT EXISTS audit_logs_y2026m07 PARTITION OF audit_logs
  FOR VALUES FROM ('2026-07-01 00:00:00+00') TO ('2026-08-01 00:00:00+00');
```

DEFAULT 파티션은 의도적으로 없다(Decisions D1). `ensurePartitions`가 생성하는 월별
파티션 DDL은 위 마지막 블록과 동일한 템플릿이다.

### 4. GIN 인덱스 — `ginIndex: true` 추가분

```sql
CREATE INDEX IF NOT EXISTS idx_audit_changes_gin ON audit_logs USING GIN (changes jsonb_path_ops);
CREATE INDEX IF NOT EXISTS idx_audit_metadata_gin ON audit_logs USING GIN (metadata jsonb_path_ops);
```

`jsonb_path_ops`는 `@>` 격납 질의 전용으로 기본 `jsonb_ops`보다 작고 빠르다.
키 존재(`?`) 질의가 필요한 사용자는 직접 `jsonb_ops` 인덱스를 추가하라고 문서화한다.

### 5. prune — flat 경로 유지보수 SQL (단일 트랜잭션, B22/B23)

트리거 강제 설치:

```sql
BEGIN;
ALTER TABLE audit_logs DISABLE TRIGGER audit_logs_no_delete_trg;
DELETE FROM audit_logs WHERE created_at < $1;  -- bind parameter
ALTER TABLE audit_logs ENABLE TRIGGER audit_logs_no_delete_trg;
COMMIT;
```

RULE 강제 설치(0.1.0 레거시 — `benchmarks/audit-overhead.ts:74-82`의 공식화):

```sql
BEGIN;
DROP RULE audit_logs_no_delete ON audit_logs;
DELETE FROM audit_logs WHERE created_at < $1;
CREATE RULE audit_logs_no_delete AS ON DELETE TO audit_logs DO INSTEAD NOTHING;
COMMIT;
```

### 6. TRUNCATE/REVOKE 하드닝 가이드 (README/docs 수록)

```sql
-- 1) 감사 테이블 소유자를 앱 롤과 분리
CREATE ROLE audit_owner NOLOGIN;
ALTER TABLE audit_logs OWNER TO audit_owner;
ALTER FUNCTION audit_logs_block_mutation() OWNER TO audit_owner;

-- 2) 앱 롤에는 INSERT/SELECT만
REVOKE ALL ON audit_logs FROM app_user;
GRANT INSERT, SELECT ON audit_logs TO app_user;
-- 파티션 레이아웃: 부모에 대한 GRANT는 기존 파티션에 자동 적용되지 않으므로
-- ALTER DEFAULT PRIVILEGES 또는 ensurePartitions 후 GRANT 재실행을 cron에 포함

-- 3) prune/ensurePartitions 는 audit_owner 권한의 별도 커넥션으로 실행
--    (AuditService.prune 의 client 옵션 — B25)
```

문서에 명시: TRUNCATE는 RULE/행 트리거를 우회하므로 위 권한 분리가 유일한 방어이고,
테이블 소유자와 superuser는 모든 강제를 우회할 수 있다(DB 레벨 불변성의 한계).

### 7. pg_partman + pg_cron 레시피 (docs 수록 — 라이브러리 코드 아님)

```sql
CREATE EXTENSION IF NOT EXISTS pg_partman;

-- 기존 partitioned 레이아웃 테이블을 pg_partman 관리 하에 등록
SELECT partman.create_parent(
  p_parent_table := 'public.audit_logs',
  p_control      := 'created_at',
  p_interval     := '1 month'
);

-- 보존 정책: 90일 경과 파티션 자동 drop
UPDATE partman.part_config
SET retention = '90 days', retention_keep_table = false
WHERE parent_table = 'public.audit_logs';

-- pg_cron으로 유지보수 (파티션 선생성 + retention 적용)
CREATE EXTENSION IF NOT EXISTS pg_cron;
SELECT cron.schedule('audit-partman', '15 3 * * *',
  $$CALL partman.run_maintenance_proc()$$);
```

pg_partman을 못 쓰는 환경용 Node cron 레시피(ensurePartitions + prune)도 같은 문서
섹션에 수록한다:

```typescript
// 예: @nestjs/schedule
@Cron('0 4 * * *')
async auditMaintenance() {
  await ensurePartitions(this.maintenancePrisma, { ahead: 1 });
  await this.auditService.prune({
    olderThan: new Date(Date.now() - 90 * 24 * 3600 * 1000),
    client: this.maintenancePrisma, // audit_owner 권한 커넥션
  });
}
```

### 8. 0.1.0 flat → partitioned 마이그레이션 절차 (docs 수록)

```sql
BEGIN;

-- 0) UTC 세션 강제 (B14/D2) — 아래 date_trunc와 format %L의 timestamptz 렌더링은
--    세션 TimeZone을 따른다. 비UTC 서버에서 이 문을 생략하면 파티션 경계가 로컬
--    월 경계로 생성되어, 2)의 UTC 그리드 파티션과 겹치거나(서경: "would overlap"
--    에러로 중단) 커버리지 갭이 생겨 4)의 INSERT가 "no partition of relation found
--    for row"로 실패한다. ensurePartitions의 UTC 그리드(B15)와의 정합에도 필수.
SET LOCAL TIME ZONE 'UTC';

-- 1) 기존 테이블/인덱스 이름 비우기 (인덱스 이름은 스키마 전역 유일 — 충돌 방지)
ALTER TABLE audit_logs RENAME TO audit_logs_old;
ALTER INDEX idx_audit_tenant_created RENAME TO idx_audit_tenant_created_old;
ALTER INDEX idx_audit_actor RENAME TO idx_audit_actor_old;
ALTER INDEX idx_audit_target RENAME TO idx_audit_target_old;
ALTER INDEX idx_audit_action RENAME TO idx_audit_action_old;

-- 2) getAuditTableSQL({ partitioned: true }) 출력 실행 (§3)

-- 3) 과거 데이터 범위를 덮는 월별 파티션 생성
DO $$
DECLARE m timestamptz;
BEGIN
  FOR m IN
    SELECT generate_series(
      date_trunc('month', (SELECT min(created_at) FROM audit_logs_old)),
      date_trunc('month', now()),
      interval '1 month')
  LOOP
    EXECUTE format(
      'CREATE TABLE IF NOT EXISTS %I PARTITION OF audit_logs
         FOR VALUES FROM (%L) TO (%L)',
      'audit_logs_y' || to_char(m, 'YYYY') || 'm' || to_char(m, 'MM'),
      m, m + interval '1 month');
  END LOOP;
END $$;

-- 4) 복사 (INSERT는 append-only 강제와 무관)
INSERT INTO audit_logs SELECT * FROM audit_logs_old;

-- 5) 검증 후 구 테이블 제거 (DROP TABLE은 DDL — RULE이 막지 않음)
-- SELECT (SELECT count(*) FROM audit_logs) = (SELECT count(*) FROM audit_logs_old);
DROP TABLE audit_logs_old;

COMMIT;
```

주의사항(문서 명시): 단일 트랜잭션 절차는 복사 동안 ACCESS EXCLUSIVE 락으로 감사
쓰기를 차단한다. 대용량 테이블은 점검 창에서 실행하거나 배치 복사 + 짧은 스왑
트랜잭션으로 변형하라(절차 변형은 docs cookbook 범위). 절차를 변형하더라도 0)의
`SET LOCAL TIME ZONE 'UTC'`(또는 경계를 `to_char(m AT TIME ZONE 'UTC', ...)`로
명시 `+00` 렌더링)는 유지해야 한다 — 파티션 경계가 UTC 그리드(B14/B15)에서
어긋나면 이후 `ensurePartitions`가 overlap 에러를 낸다.

## Error Handling

| 실패 경로 | 동작 | onAuditError phase |
|-----------|------|--------------------|
| `tableName` 정규식/길이 위반 (B1, B2) | `createAuditExtension()` / `AuditService` 생성자 / DDL·파티션 헬퍼 진입 시 `Error` throw — 침묵 fallback 없음 | 사용 안 함 (구성 오류는 즉사) |
| `applyAuditTableSchema({ partitioned: true })`를 기존 flat 테이블 위에 호출 (B13a) | relkind 프리체크가 §SQL/DDL 8 절차를 안내하는 설명적 `Error` throw — DDL 미실행, 스키마 무변경 | 사용 안 함 (관리 API는 throw) |
| 자동 감사 INSERT 실패 (커스텀 테이블 미존재, 월 파티션 누락 포함) | 기존 `tryAuditLog` catch (`src/prisma/audit-extension.ts:111-116`) — 비즈니스 결과 반환은 유지. 신뢰성 스펙 적용 후 `options.onAuditError` 호출, 미제공 시 `logger.warn` 폴백 (이중 출력 없음 — 스펙 02 B17) | `'insert'` (신뢰성 스펙 소유) |
| `AuditService.log()` INSERT 실패 | 0.1.0과 동일하게 호출자에게 throw (수동 API는 명시적 호출 — fail-loud) | 사용 안 함 |
| `ensurePartitions`: 테이블 없음 / 비파티션 테이블 / `ahead` 음수 (B17) | throw | 사용 안 함 (B26) |
| `ensurePartitions`: 동시 실행 42P07 경합 (B16) | 무시 (멱등 처리) | — |
| `prune`: 테이블 없음 / relkind 판별 불가 (B19) | throw | 사용 안 함 (B26) |
| `prune` flat: DELETE 또는 강제 복원 실패 (B23) | 단일 트랜잭션 롤백 → 강제 원상 보존, 에러는 호출자에게 throw | 사용 안 함 |
| `prune` flat: 강제 객체 미발견 (B22) | `logger.warn` 후 plain DELETE 진행 | — |
| `prune` partitioned: 개별 DROP/DETACH 실패 (B20a) | 직전까지 성공분은 유지(파티션별 자율 커밋), 에러 throw 시 `AuditPruneResult` 대신 예외 — 메시지에 성공한 파티션 목록 포함 (계약은 B20a, 검증은 E6c) | 사용 안 함 |
| 트리거 강제 하의 UPDATE/DELETE 시도 (B28) | PostgreSQL `P0001` 예외가 해당 SQL 호출자에게 전파 | — (라이브러리 외부) |
| RULE 강제(레거시) 하의 UPDATE/DELETE (B29) | 침묵 0행 — 문서화된 레거시 한계 | — |

공통 로깅: 본 스펙의 모든 경고는 `options.logger ?? console`로 출력한다(확장은 Nest
DI 밖에서 생성되므로 — 공통 결정 1/5와 동일한 패턴).

## Test Plan

### Unit (mock prisma / 순수 함수)

| 케이스 | 검증 대상 |
|--------|----------|
| U1. `tableName` 검증: 유효(`audit_logs`, `Audit_Logs2`, `audit.audit_logs`, 44자 테이블 부분), 무효(`audit-logs`, `1abc`, `a.b.c`, `a;DROP`, 45자 테이블 부분(44자 초과), 빈 문자열) | B1, B2 |
| U2. `createAuditExtension({ tableName: 'bad name' })` / `AuditService` 생성자 throw | B1 |
| U3. zero-arg `getAuditTableSQL()` 스냅샷: flat + 트리거 + DROP RULE 포함, GIN 없음 | B7, B8 |
| U4. `enforcement: 'rule'` 출력이 0.1.0 RULE 블록과 동일 | B9 |
| U5. `partitioned: true` 출력: `PARTITION BY RANGE`, `PRIMARY KEY (id, created_at)`, BRIN, 초기 파티션 2개(UTC 월 경계), DEFAULT 파티션 부재 | B10, B14 |
| U6. `ginIndex: true` 출력에 GIN 2개, false면 0개 | B12 |
| U7. `getAuditTableStatements(opts).join('\n\n') === getAuditTableSQL(opts)`, 각 문 단독 실행 가능 형태 | B13 |
| U8. 파생 객체명: 기본 테이블 레거시 인덱스명 유지, 커스텀 테이블 `idx_<table>_*` / `<table>_no_update_trg` / `<table>_y2026m06`, 스키마 한정 시 동일 스키마 생성 | B6 |
| U9. 파티션 이름·범위 계산: 월 경계 UTC, `ahead` 산정 (2026-06 + ahead 1 → y2026m06, y2026m07) | B14, B15 |
| U10. `pg_get_expr` 경계 파싱: 상한 ≤ olderThan 판별, olderThan이 속한 파티션 제외 | B20 |
| U11. `prune` mock: flat에서 mode 지정 무시 → `mode: 'delete'` 보고, partitioned 기본 `'drop'` | B27 |
| U12. 확장 INSERT SQL이 `${Prisma.raw(table)}`를 사용하고 값은 전부 placeholder인지 (생성된 SQL 텍스트 검사) | B3, B5 |
| U13. `prune` mock: 테이블 없음(to_regclass NULL) / relkind가 'r'·'p' 외 값 → throw (메시지에 테이블명 포함) | B19 |

### E2E (실제 PostgreSQL — `test/e2e` 스택)

| 케이스 | 검증 대상 | Release Gate |
|--------|----------|--------------|
| E1. `applyAuditTableSchema()` 신규 적용 후 UPDATE/DELETE가 P0001로 throw, INSERT/SELECT 정상 | B7, B8, B28 | **Gate 4 (append-only 강제 검증)** |
| E2. 0.1.0 RULE 스키마 위에 신규 DDL 재적용 → RULE 제거·트리거 설치, 데이터 보존, 멱등(2회 적용 무해) | B8 | Gate 4 |
| E3. `enforcement: 'rule'`로 적용 시 UPDATE/DELETE 침묵 0행 (0.1.0 동작 재현) | B9, B29 | Gate 4 |
| E4. partitioned 스키마 적용 → 과거/현재 월 행 INSERT(명시 `created_at`) 라우팅 확인, 파티션 직접 DELETE도 트리거가 차단 | B10, B11, B28 | Gate 4 |
| E5. `ensurePartitions` 신규 생성 → 이름 배열 반환, 재호출 시 `[]`, 비파티션 테이블에 호출 시 throw | B15–B17 | — |
| E6. partitioned `prune({ olderThan })`: 상한 경과 파티션만 DROP, 경계 파티션 보존, `dryRun` 무변경, `mode: 'detach'` 후 독립 테이블 존재 | B20, B21, B24 | — |
| E6b. flat `prune({ dryRun: true })`: `deletedRows`가 COUNT 결과와 일치, 행 수 무변경, 강제 객체(트리거/RULE) 무변경 — DISABLE/DROP 미실행 | B24 | — |
| E6c. partitioned `prune` 실패 주입(2번째 파티션 DROP을 락/권한으로 강제 실패) → 1번째 파티션은 드롭된 채 유지, throw된 에러 메시지에 성공한 파티션 이름 목록 포함 | B20a | — |
| E7. flat `prune`: 트리거 설치본에서 DISABLE/DELETE/ENABLE 후 강제 재활성 확인(직후 DELETE 시도 throw), RULE 설치본에서 drop/recreate 경로 동일 검증 | B22, B23 | Gate 4 |
| E7b. 강제 객체(트리거·RULE) 모두 부재한 flat 테이블에서 `prune` → `logger.warn` 기록 + plain DELETE로 행 삭제됨 | B22 (셋째 분기) | — |
| E8. flat `prune` 실패 주입(존재하지 않는 컬럼 강제 등) → 트랜잭션 롤백으로 행·강제 모두 원상 | B23 | — |
| E9b. `prune({ client })`: 별도 롤/스파이 클라이언트 주입 → 모든 prune SQL이 주입 클라이언트에서 실행, `options.prisma`에는 SQL 0건 | B25 | — |
| E9. 커스텀 `tableName`(스키마 한정 포함) end-to-end: DDL 적용 → 확장 자동 추적 INSERT → `AuditService.log()`/`query()` 모두 같은 테이블 사용 | B3–B6 | — |
| E10. 월 파티션 누락 상태에서 자동 추적 쓰기 → 비즈니스 쿼리 성공 + 감사 실패 경고 관측 (신뢰성 스펙 머지 후 `onAuditError('insert')` 검증으로 강화) | B18 | — |
| E11. §8 마이그레이션 절차 스크립트 실행 → 행 수 일치, 신규 쓰기 파티션 라우팅. **비UTC 세션 TimeZone(예: `SET TIME ZONE 'America/New_York'` 후 실행) 1회 반복** — `SET LOCAL TIME ZONE 'UTC'`가 경계 어긋남(overlap/갭)을 막는지 고정 | Migration, B14 | Gate 6 (문서 정합성 — 절차 검증) |
| E12. `ginIndex: true` 적용 후 `changes @> ...` 질의가 GIN 인덱스 사용 (EXPLAIN 확인은 smoke 수준) | B12 | — |
| E13. 기존 0.1.0 flat 설치 위에 `applyAuditTableSchema({ partitioned: true })` 호출 → §8 절차를 안내하는 설명적 throw, 스키마·데이터 무변경 (half-applied 방지) | B13a | — |

Gate 4의 최종 사인오프 소유는 스펙 06(G4 — `test/e2e/append-only.e2e-spec.ts`)이다.
위 표의 "Gate 4" 표기는 기여(coverage) 표시이며, E1–E4/E7은 스펙 06 G4의 모드별
테이블 검증(`audit_logs_rule_mode`/`audit_logs_trigger_mode`)과 중복되지 않게 같은
파일 또는 연동 수트로 머지 시 정리한다.

벤치마크 갱신: `benchmarks/audit-overhead.ts:74-82`의 `cleanAuditLogs()`를
`AuditService.prune()` flat 경로(또는 동일 SQL)로 교체해 공식 경로를 dogfooding 한다.

## Migration & Docs Impact

**Breaking 여부**: 없음(로드맵 #1/#11 모두 Breaking 아니오). 단, 아래 **동작 변화**를
CHANGELOG에 명시한다:

- `getAuditTableSQL()` zero-arg 출력이 RULE → 트리거 강제로 바뀐다. 기존 설치에
  재적용하면 UPDATE/DELETE가 침묵 no-op에서 **예외 발생**으로 바뀐다(의도된
  fail-loud 업그레이드). 0.1.0 동작이 필요하면 `enforcement: 'rule'` 옵트아웃.
- 번들 정적 파일 `dist/sql/audit-log-schema.sql`이 제거된다. 파일을 직접 읽던
  (비문서화) 소비자는 `getAuditTableSQL()` 호출로 전환. 같은 PR에서 build 스크립트의
  `cp src/sql/*.sql dist/sql/` 단계를 제거한다(§Public API Changes 4 — 미제거 시
  glob 매칭 실패로 전체 빌드가 깨진다).

**CHANGELOG (0.2.0) 항목 초안**:

- Added: `tableName` option (`AuditSharedOptions`) — 자동/수동/조회 전 경로 적용
- Added: `getAuditTableSQL(options)` — `partitioned` / `enforcement` / `ginIndex` 변형
- Added: `ensurePartitions(prisma, { tableName, ahead })`
- Added: `AuditService.prune({ olderThan, mode, dryRun, client, timeoutMs, maxWaitMs })` — 양 레이아웃 지원
- Changed: append-only 기본 강제가 침묵 RULE → `RAISE EXCEPTION` 트리거 (재적용 시 업그레이드)
- Removed: 번들 `audit-log-schema.sql` 정적 파일 (동적 생성으로 대체)

**README**:

- 신규 "Retention & Partitioning" 섹션: 파티셔닝 quick start, `ensurePartitions`/`prune`
  사용법, cron + pg_partman 레시피(§SQL/DDL 7), 권한 요구 사항(B25), flat prune의
  Prisma 인터랙티브 트랜잭션 timeout(기본 5초 → 라이브러리 기본 60초,
  `timeoutMs`/`maxWaitMs`로 조정 — B23).
- 신규 "Hardening" 섹션: REVOKE/TRUNCATE 가이드(§SQL/DDL 6), 트리거 vs RULE 비교,
  소유자/superuser 우회 한계.
- Schema Setup 섹션을 `applyAuditTableSchema(prisma, options)` 기준으로 갱신,
  PostgreSQL 13+ (partitioned) 요구 명시.
- 공유 옵션 상수 패턴(모듈/확장 spread) 예시 추가.

**설계 문서 (`docs/2026-04-04-audit-log-design.md`)**:

- `:249` "JSONB 인덱스는 v0.2.0에서 GIN 인덱스 추가 고려" → 본 스펙 `ginIndex` 구현으로 갱신.
- `:253` Security의 "Append-only: PostgreSQL RULE로 UPDATE/DELETE 차단. DB 레벨
  불변성." → 트리거 기본 + RULE 레거시 + TRUNCATE/소유자 우회 한계로 정직하게 수정
  (Release Gate 6의 일부; `:248` 원자성 서술 수정은 #5 스펙 소유).
- `:258-261` Out of Scope에서 retention/archival 제거.

**0.1.0 flat 설치 사용자 마이그레이션 안내 (README + CHANGELOG 링크)** — 두 경로 모두 공식 지원:

1. **flat 유지 + prune**: `applyAuditTableSchema()` 재적용(트리거 업그레이드) 후
   `prune({ olderThan })` cron 운영. 대형 테이블의 락 비용(B23) 명시.
2. **partitioned 전환**: §SQL/DDL 8 복사 절차. 이후 `ensurePartitions` cron 또는
   pg_partman 운영.

## Decisions

- **D1. DEFAULT 파티션을 만들지 않는다.** 누락 월 파티션의 INSERT 실패는
  `tryAuditLog`/`onAuditError('insert')`로 관측되는 fail-loud이며, DEFAULT 파티션은
  이후 월 파티션 생성 시 "default partition constraint violation" 충돌(행 재배치
  필요)을 일으켜 0.2.0 범위를 초과하는 복구 로직을 요구한다. pg_partman 사용자는
  partman의 default 관리 기능을 쓰면 된다.
- **D2. 월 경계는 UTC 고정.** 서버 로컬 타임존 의존은 파티션 이름·범위의 재현성을
  깨뜨린다. 파티션 범위 리터럴에 `+00` 오프셋 명시. §SQL/DDL 8의 수동 마이그레이션
  레시피는 SQL의 `date_trunc`/`format %L`이 세션 TimeZone을 따르므로 **UTC 세션을
  요구**한다(`SET LOCAL TIME ZONE 'UTC'` — B14, E11이 비UTC 세션으로 고정 검증).
- **D3. 기본 테이블의 인덱스 이름은 0.1.0 레거시(`idx_audit_*`)를 유지한다.**
  파생 이름(`idx_audit_logs_*`)으로 통일하면 기존 설치 재적용 시 동일 정의의 중복
  인덱스가 생긴다(쓰기 비용 2배). 커스텀 테이블명은 0.2.0 신규이므로 파생 규칙만
  적용. 마이그레이션 §8에서는 구 인덱스를 명시적으로 rename 한다.
- **D4. 트리거 모드 DDL이 레거시 RULE을 함께 drop 한다.** 한 번의 재적용으로 강제
  업그레이드가 완료되게 하기 위함. RULE이 남아 있으면 쿼리 재작성이 트리거보다 먼저
  적용되어 트리거가 영원히 발화하지 않는다(침묵 no-op 잔존).
- **D5. 강제 트리거는 FOR EACH ROW.** 파티션 부모에 생성하면 기존·신규 파티션에
  자동 복제되어 파티션 직접 DML까지 차단된다. STATEMENT 트리거는 파티션을 직접
  명명한 DML에 발화하지 않아 우회 구멍이 생긴다.
- **D6. prune의 입도는 파티션(월) 단위.** 부분 월 삭제를 위해 행 DELETE를 섞으면
  append-only 강제 해제가 필요해져 파티셔닝의 핵심 이점(강제 무결성과 양립하는
  DDL 기반 정리)이 사라진다. flat 경로만 행 단위 정확 삭제.
- **D7. `prune`/`ensurePartitions`는 throw 한다(onAuditError 미사용).** 두 API는
  운영자가 명시적으로 호출하는 관리 작업이고, `AuditErrorContext.phase` 공통 결정에
  해당 phase가 없다. 침묵 보고는 보존 정책 미집행을 숨기는 fail-silent이 된다.
- **D8. 정적 `audit-log-schema.sql` 파일 제거, 순수 TS 생성으로 전환.** 옵션 조합
  (2 레이아웃 × 2 강제 × GIN × tableName)을 정적 파일로 유지하는 것은 불가능하다.
  `getAuditTableStatements`의 `$$` 파서도 생성 단계 배열 반환으로 대체(파싱 버그
  표면 제거).
- **D9. `ensurePartitions`의 `ahead` 기본 1, 권장 운용은 부트 1회 + 일일 cron.**
  ahead 1이면 cron이 통째로 한 달 죽어도 파티션 누락이 발생하지 않는다.
- **D10. 스케줄러는 포함하지 않는다** (로드맵 명시 — cron/pg_partman 레시피 문서로 대체).
- **D11. `detach`는 plain `DETACH PARTITION`** (non-CONCURRENTLY). CONCURRENTLY는
  PG14+이고 트랜잭션 제약이 있어 0.2.0에서는 단순성을 우선한다. 문서에 PG14+
  사용자를 위한 수동 CONCURRENTLY 안내만 수록.
- **D12. 테이블 부분 길이 ≤ 44자 제한.** 최장 파생 이름(`idx_<table>_tenant_created`,
  +19자)이 PostgreSQL 63바이트 한도에서 잘리면 멱등성(`IF NOT EXISTS` 이름 매칭)이
  깨진다. 잘림 허용 대신 구성 시점 throw.
- **D13. `prune`에 `client` 오버라이드 제공.** REVOKE 하드닝(§SQL/DDL 6)을 적용하면
  앱 커넥션은 DELETE/DDL 권한이 없다 — 하드닝 가이드와 prune API가 서로 모순되지
  않도록 권한 있는 유지보수 커넥션을 주입 가능해야 한다. `log(input, tx?)`의 기존
  클라이언트-주입 패턴(`src/services/audit.service.ts:21-22`)과 일관.
- **D14. partitioned 레이아웃은 PostgreSQL 13+ 요구.** 파티션 부모의 BEFORE ROW
  트리거(강제 복제)와 내장 `gen_random_uuid()`가 13에서 갖춰진다. flat 레이아웃의
  지원 버전은 0.1.0과 동일하게 유지.
- **D15. 로드맵 #1의 "일정 압박 시 축소안"(파티셔닝 stretch goal 강등)은 채택하지
  않는다.** #11과 같은 마이그레이션으로 묶는 조건(로드맵 `:35`)이 본 스펙으로
  성립했고, flat prune 경로만으로는 대형 테이블에서 ACCESS EXCLUSIVE 락 비용(B23)을
  해소할 수 없다.

## Out of Scope

- **인-라이브러리 스케줄러** — cron/pg_partman 레시피 문서로 대체(로드맵 Out of Scope).
- **배치 연산 충실도(#10), 중첩 쓰기 풀 감사** — 0.3.0. 본 스펙은 스토리지 계층만 다룬다.
- **아카이브 export(S3/SIEM), detach 후 자동 덤프** — detach는 테이블을 남기는 것까지;
  이후 워크플로는 문서 안내만.
- **해시 체인 변조 방지, point-in-time 복원** — 수요 검증 후 0.3.0+ (로드맵 Out of Scope).
- **일/주/년 등 비월간 파티션 간격** — 0.2.0은 월 단위 고정. 다른 간격이 필요하면
  pg_partman 레시피 사용.
- **RLS 기반 테넌트 격리 DDL** — tenancy 연동 스펙(#4) 및 차후 범위.
- **부분 월 정리(파티션 내 행 단위 prune)** — D6 참조.
- **자동 마이그레이션 실행기**(flat → partitioned 변환을 코드로 수행) — §SQL/DDL 8의
  문서화된 SQL 절차만 제공. 데이터 이동을 라이브러리가 무인 실행하는 것은 0.2.0
  위험 예산을 초과한다.
