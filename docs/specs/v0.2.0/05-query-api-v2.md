# v0.2.0 Spec — Query API v2

Date: 2026-06-11
Status: Draft
Roadmap items: #7 (연계: #4의 `query()` 테넌트 플래그 — spec 03과 한 PR 권장)

## Goal

`AuditService.query()`를 하위 호환을 유지하며 확장한다:

1. `(created_at, id)` 기준 keyset(커서) 페이지네이션 — 무한 증가 테이블에서 offset의 자해적 스케일링 제거.
2. 누락 필터 추가: `actorType`, `source`, `result` (저장은 되지만 현재 필터 불가).
3. `includeTotal` 옵트아웃 — 현재 매 호출마다 무조건 실행되는 `COUNT(*)` 비용 제거 경로 제공.
4. `getById(id)` 단건 조회 (테넌트 스코핑 포함).
5. 와일드카드 변환 시 리터럴 `%`/`_` 미이스케이프 정확성 버그 수정.

정렬 방향 제어는 로드맵 명시대로 범위에서 제외한다(감사 피드는 사실상 항상 최신순).

## Background

현재 `AuditService.query()`(`src/services/audit.service.ts:53-117`)의 문제:

1. **Offset 페이지네이션만 지원** (`src/services/audit.service.ts:95-96, 106`):
   `LIMIT ${limit} OFFSET ${offset}`. audit_logs는 append-only로 무한 증가하므로
   깊은 페이지일수록 스캔 비용이 선형 증가하고, 페이지 조회 사이에 새 행이
   INSERT되면 행이 중복/누락된다(offset 드리프트).
2. **무조건 COUNT(*)** (`src/services/audit.service.ts:98-111`, 특히 108-110행):
   모든 호출이 `SELECT COUNT(*)`를 병렬 실행한다. total이 불필요한 피드형
   소비자도 풀 카운트 비용을 강제 부담한다.
3. **와일드카드 이스케이프 버그** (`src/services/audit.service.ts:70-72`):
   ```typescript
   if (options.action.includes('*')) {
     const pattern = options.action.replace(/\*/g, '%');
     conditions.push(Prisma.sql`action LIKE ${pattern}`);
   }
   ```
   `*`가 포함된 action의 리터럴 `%`/`_`가 이스케이프되지 않아 의도치 않은
   와일드카드가 된다. 예: `discount_*` → `discount_%` — `_`가 임의 1문자에
   매칭되어 `discountX.applied` 같은 무관한 액션이 결과에 섞인다.
4. **필터 누락**: `actor_type`, `source`, `result` 컬럼은 저장되지만
   (`src/sql/audit-log-schema.sql:8, 13, 16`) `AuditQueryOptions`
   (`src/interfaces/audit-entry.interface.ts:17-26`)에 대응 필터가 없다.
   특히 `result`는 #3의 `logFailures` 도입 후 'failure' 행 검색이 필수가 된다.
5. **단건 조회 부재**: 감사 상세 화면("이 로그 한 건 보기")을 위해 소비자가
   `query()`를 우회 사용해야 한다.
6. **비결정적 정렬**: `ORDER BY created_at DESC`만 사용
   (`src/services/audit.service.ts:105`) — 같은 timestamp의 행 간 순서가
   비결정적이라 keyset의 전제(전순서)가 성립하지 않는다.

### Shared Decisions (applied)

이 스펙은 다음 확정된 cross-cutting 결정 위에서 작성되었다(재논의 없음):

- **결정 1**: `AuditLogModuleOptions`는 `AuditSharedOptions`를 extends한다.
  `query()`/`getById()`의 `FROM` 절 테이블명은 `options.tableName ?? 'audit_logs'`를
  사용하며, 검증(`/^[a-zA-Z_][a-zA-Z0-9_]*$/`, 스키마 한정자 1개 허용)과
  `Prisma.raw` 보간 규칙은 tableName 스펙(결정 3)을 따른다. 본 스펙의 SQL
  리스팅은 가독성을 위해 `audit_logs` 리터럴로 표기한다.
- **결정 7**: `query()`는 명시적 `tenantId?: string` 필터와 `allTenants?: boolean`
  플래그를 갖는다. 둘 다 없고 ambient 컨텍스트도 없으면 `tenantRequired: true`일
  때 throw, 아니면 현행 무스코프 동작 유지 + 인스턴스당 1회 런타임 경고(spec 03
  B20/Q6). 테넌트 해석 우선순위 매트릭스의 규범적(normative) 정의는 spec 03이며,
  본 스펙은 이를 참조·재기술한다.
- **결정 9**: keyset 커서는 `(created_at, id)`의 불투명 base64 인코딩.
  `includeTotal?: boolean`은 하위 호환을 위해 기본 true(문서는 피드 용도에
  false 권장). 신규 필터 `actorType`/`source`/`result`. `getById(id)`.
  `*` 변환 전 리터럴 `%`/`_` 이스케이프.

## Public API Changes

### `AuditQueryOptions` (src/interfaces/audit-entry.interface.ts:17-26)

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

제안:

```typescript
export interface AuditQueryOptions {
  actorId?: string;
  /** actor_type 정확 일치 필터 (예: 'user' | 'system' | 'api_key'). NEW */
  actorType?: string;
  action?: string;
  targetType?: string;
  targetId?: string;
  /** source 정확 일치 필터. NEW */
  source?: 'auto' | 'manual';
  /** result 정확 일치 필터. NEW */
  result?: 'success' | 'failure';
  from?: Date;
  to?: Date;
  /**
   * 명시적 테넌트 필터. ambient 컨텍스트보다 우선.
   * allTenants와 동시 지정 불가. NEW — 규범적 정의는 spec 03 (#4).
   */
  tenantId?: string;
  /**
   * 의도적 교차 테넌트 조회. tenantId와 동시 지정 불가.
   * NEW — 규범적 정의는 spec 03 (#4).
   */
  allTenants?: boolean;
  /** 페이지 크기. 기본 50. 양의 정수. */
  limit?: number;
  /** 레거시 offset 페이지네이션. cursor와 동시 지정 불가. */
  offset?: number;
  /**
   * keyset 커서. 직전 결과의 nextCursor를 그대로 전달.
   * 불투명 문자열 — 소비자가 파싱/생성하지 않는다. NEW
   */
  cursor?: string;
  /**
   * false면 COUNT(*) 쿼리를 생략하고 결과에 total이 없다.
   * 기본 true (하위 호환). 피드/무한스크롤에는 false 권장. NEW
   */
  includeTotal?: boolean;
}
```

### `AuditQueryResult` (src/interfaces/audit-entry.interface.ts:28-31)

현재:

```typescript
export interface AuditQueryResult {
  entries: AuditEntry[];
  total: number;
}
```

제안:

```typescript
export interface AuditQueryResult {
  entries: AuditEntry[];
  /**
   * 필터 조건 전체(커서 keyset 조건 제외)에 매칭되는 총 행 수.
   * includeTotal: false일 때 속성 자체가 존재하지 않는다.
   */
  total?: number;
  /**
   * 다음 페이지 커서. 다음 페이지가 없으면 null.
   * offset 모드에서도 계산된다 (offset → cursor 마이그레이션 경로).
   */
  nextCursor: string | null;
  /** entries 이후에 매칭 행이 더 존재하는지 여부. */
  hasMore: boolean;
}
```

런타임 하위 호환: `includeTotal` 기본값이 true이므로 기존 호출의 `result.total`은
계속 number다. 타입 수준에서는 `total`이 optional이 되므로 strict 소비자는
`result.total!` 또는 `includeTotal` 미지정 계약 확인이 필요할 수 있다
(Migration 섹션 참조).

### `AuditService.query()` (src/services/audit.service.ts:53)

현재:

```typescript
async query(options: AuditQueryOptions): Promise<AuditQueryResult>
```

제안 (시그니처 동일 — 옵션/결과 인터페이스 확장만):

```typescript
async query(options: AuditQueryOptions): Promise<AuditQueryResult>
```

### `AuditService.getById()` — 신규 (src/services/audit.service.ts에 추가)

```typescript
export interface AuditGetByIdOptions {
  /** 명시적 테넌트 스코프. allTenants와 동시 지정 불가. */
  tenantId?: string;
  /** 의도적 교차 테넌트 단건 조회. tenantId와 동시 지정 불가. */
  allTenants?: boolean;
}

async getById(
  id: string,
  options?: AuditGetByIdOptions,
): Promise<AuditEntry | null>
```

`AuditGetByIdOptions`는 `src/interfaces/audit-entry.interface.ts`에 정의하고
`src/index.ts`에서 type export한다.

### 내부 모듈 (export 안 함)

`src/services/audit-cursor.ts` 신규 — `@internal`:

```typescript
/** @internal */
export function encodeAuditCursor(createdAtMicroIso: string, id: string): string;
/** @internal */
export function decodeAuditCursor(cursor: string): { ts: string; id: string };
/** @internal LIKE 패턴 리터럴 이스케이프 */
export function escapeLikePattern(value: string): string;
```

커서는 공개 계약상 불투명(opaque)이다. 인코딩 형식은 아래에 정의하지만
**형식 자체는 공개 API가 아니며** 마이너 버전에서 바뀔 수 있다(버전 프리픽스로
대비). `src/index.ts`에서 export하지 않는다.

## Behavior Specification

### Ordering & cursor encoding

- **B1.** `query()`의 정렬은 모든 모드(cursor/offset/무페이지네이션)에서
  `ORDER BY created_at DESC, id DESC`다. (현행 `ORDER BY created_at DESC`에
  `id DESC` 타이브레이크 추가 — keyset 전순서 확보. 동일 timestamp 행의 상호
  순서만 결정적으로 바뀌며, breaking으로 취급하지 않는다.)
- **B2.** 커서 페이로드는 인코딩 전 평문 기준
  `v1|<created_at>|<id>` 형식이다.
  - `<created_at>`: UTC 마이크로초 정밀도 ISO-8601,
    정규식 `^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$`
    (예: `2026-06-11T03:14:15.926535Z`)
  - `<id>`: UUID,
    정규식 `^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`
    (소문자 정규화 후 비교)
  - 인코딩: `Buffer.from(payload, 'utf8').toString('base64url')` (패딩 없는
    base64url). 디코딩: `Buffer.from(cursor, 'base64url').toString('utf8')`.
- **B3.** 커서의 timestamp는 JS `Date`(밀리초 정밀도)가 아니라 SELECT에 추가되는
  내부 프로젝션 컬럼에서 얻는다:
  `to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "cursorTs"`.
  PostgreSQL TIMESTAMPTZ는 마이크로초 정밀도이므로 `Date` 경유 시 같은 밀리초
  내 행이 누락/중복된다 — 이를 원천 차단한다. `cursorTs` 속성은 반환 전 각 entry
  객체에서 **제거**한다(`AuditEntry` 공개 형태 불변).
- **B4.** `cursor` 지정 시 keyset 조건이 WHERE에 AND로 추가된다:
  `created_at <= ${ts}::timestamptz AND (created_at, id) < (${ts}::timestamptz, ${id}::uuid)`.
  앞의 중복 한정 조건(`created_at <= ts`)은 의미상 잉여지만 BRIN 인덱스 스캔과
  파티션 프루닝이 row-value 비교 없이도 확실히 동작하게 하는 sargable 가드다.
- **B5.** 페이지 조회는 내부적으로 `LIMIT limit + 1`로 실행한다.
  `hasMore = (조회 행 수 === limit + 1)`, 반환 entries는 앞 `limit`개.
- **B6.** `nextCursor`는 `hasMore`가 true면 반환된 마지막 entry의
  `(cursorTs, id)`를 B2 형식으로 인코딩한 값, false면 `null`.
  `entries`가 비면 `null`. offset 모드에서도 동일하게 계산한다(점진적 cursor
  마이그레이션 경로).
- **B7.** 커서 디코딩 검증: base64url 디코드 → `|` 분리 결과가 정확히 3개 →
  첫 파트가 `v1` → ts/id가 B2 정규식 매치. 하나라도 실패하면 **SQL 실행 전**
  throw (Error Handling E2). 디코딩된 값은 항상 바인드 파라미터로만 SQL에
  전달된다(문자열 보간 금지) — 정규식 검증 + 바인드의 이중 방어.
- **B8.** `cursor`와 `offset`이 동시에 지정되면(둘 다 `!== undefined`) **SQL 실행
  전** throw (Error Handling E1). `offset: 0`도 명시 지정이면 throw 대상이다.
- **B9.** `cursor` 미지정 시 레거시 동작 보존: `LIMIT ${limit} OFFSET ${offset}`
  (기본 offset 0), B1의 정렬 + B5/B6의 hasMore/nextCursor 계산만 추가된다.
- **B10.** keyset 조건은 모든 필터(actorId, actorType, action, targetType,
  targetId, source, result, from, to, 테넌트 스코프)와 AND로 결합된다. 특히
  `from`/`to`와 결합 시: `created_at >= from AND created_at <= to AND <keyset>`.
- **B11.** 커서는 필터를 인코딩하지 않는다. 페이지 간 필터 변경은 에러가 아니며
  "커서 경계보다 오래된 행 중 새 필터 매칭"이라는 잘 정의된 결과를 반환한다.
  안정적 페이지네이션을 원하면 필터를 고정하라고 문서화한다.

### includeTotal

- **B12.** `includeTotal`이 미지정이거나 true면 현행대로 `COUNT(*)`를 병렬
  실행하고 `total`을 반환한다. COUNT의 WHERE는 **keyset 조건(B4)을 제외한**
  모든 조건(필터 + 테넌트 스코프 + from/to)이다 — 페이지를 넘겨도 total이
  변하지 않는 페이지네이션 UI 친화적 의미론.
- **B13.** `includeTotal: false`면 COUNT 쿼리를 **실행하지 않고**(쿼리 1회만
  발행) 반환 객체에 `total` 속성이 존재하지 않는다
  (`'total' in result === false`).

### New filters

- **B14.** `actorType` 지정 시 `actor_type = ${actorType}` 조건 추가.
- **B15.** `source` 지정 시 `source = ${source}` 조건 추가.
- **B16.** `result` 지정 시 `result = ${result}` 조건 추가.
- **B17.** 신규 필터의 적용 판정은 기존 필터와 동일한 truthiness 검사를 따른다
  (`if (options.actorType)` 등). 빈 문자열은 필터 미적용 — 기존
  `src/services/audit.service.ts:66-88` 패턴과의 일관성 유지(Decisions D8).

### Wildcard escaping

- **B18.** `action`에 `*`가 없으면 현행대로 정확 일치(`action = ${value}`).
  이 경로에서는 리터럴 `%`/`_`가 LIKE를 타지 않으므로 안전(현행 동작 보존).
- **B19.** `action`에 `*`가 하나 이상 있으면 다음 순서로 변환한다:
  1. `\` → `\\` (백슬래시 먼저 — 이후 단계가 만든 이스케이프를 재이스케이프하지
     않도록)
  2. `%` → `\%`
  3. `_` → `\_`
  4. `*` → `%`

  ```typescript
  export function escapeLikePattern(value: string): string {
    return value
      .replace(/\\/g, '\\\\')
      .replace(/%/g, '\\%')
      .replace(/_/g, '\\_');
  }
  // 호출부
  const pattern = escapeLikePattern(options.action).replace(/\*/g, '%');
  conditions.push(Prisma.sql`action LIKE ${pattern} ESCAPE '\\'`);
  ```

  (TS 소스의 `'\\'`는 SQL 텍스트 `ESCAPE '\'`가 된다. PostgreSQL의 LIKE 기본
  이스케이프 문자가 이미 `\`이지만 명시해 의도를 고정한다.)
- **B20.** 변환 예시 (LIKE 패턴은 SQL에 도달하는 최종 문자열):

  | 입력 `action` | 경로 | SQL |
  |---|---|---|
  | `invoice.*` | LIKE | `action LIKE 'invoice.%'` |
  | `discount_50.*` | LIKE | `action LIKE 'discount\_50.%'` |
  | `100%.applied` | 정확 일치 (`*` 없음) | `action = '100%.applied'` |
  | `a*b%c_d` | LIKE | `action LIKE 'a%b\%c\_d'` |
  | `dir\*` | LIKE | `action LIKE 'dir\\%'` |
  | `*` | LIKE | `action LIKE '%'` |

- **B21.** `*`가 포함된 패턴에서 리터럴 `*` 자체를 매칭하는 방법은 제공하지
  않는다(문서화된 한계, Decisions D13).

### getById

- **B22.** `getById(id, options?)`는 매칭 행 1건을 `AuditEntry`로, 없으면
  `null`을 반환한다. `LIMIT 1` 사용.
- **B23.** `id`가 B2의 UUID 정규식(대소문자 무시)에 매치하지 않으면 SQL을
  실행하지 않고 `null`을 반환한다 (PostgreSQL `22P02` invalid uuid 에러 방지 —
  "잘못된 형식의 id"는 "존재하지 않음"과 동치).
- **B24.** 테넌트 스코핑은 spec 03의 매트릭스와 동일한 우선순위를 따른다:

  | 조건 | 적용 스코프 |
  |---|---|
  | `allTenants: true` | 테넌트 조건 없음 (ambient 무시) |
  | `tenantId` 지정 | `tenant_id = ${options.tenantId}` |
  | ambient 테넌트 존재 (`resolveTenantId({ tenantResolver })` — spec 03 §4) | `tenant_id = ${ambient}` |
  | 그 외 + `tenantRequired: true` | throw (Error Handling E4) |
  | 그 외 + `tenantRequired` falsy | 무스코프 조회 + spec 03 B20과 공유하는 인스턴스당 1회 경고 |

- **B25.** `tenantId`와 `allTenants: true` 동시 지정 시 **SQL 실행 전** throw
  (Error Handling E3). `query()`와 `getById()` 동일.
- **B26.** 테넌트 스코프가 적용된 `getById()`는 타 테넌트 행에 대해 `null`을
  반환한다 — 존재 여부조차 노출하지 않는다(존재 오라클 금지).

### Tenant scoping on query() (normative source: spec 03)

- **B27.** `query({ tenantId })`는 ambient 컨텍스트 대신
  `tenant_id = ${tenantId}` 조건을 사용한다.
- **B28.** `query({ allTenants: true })`는 테넌트 조건을 생략한다(ambient 무시).
  `tenantRequired: true`여도 throw하지 않는다 — 명시적 교차 테넌트 의도.
- **B29.** `tenantId`/`allTenants`/ambient 모두 부재 시: `tenantRequired: true`면
  throw (E4), 아니면 현행 무스코프 동작 유지 + spec 03 B20의 인스턴스당 1회
  런타임 경고(+ README 경고 문서화).

### Validation

- **B30.** `limit`은 양의 정수여야 한다(`Number.isInteger(limit) && limit >= 1`).
  위반 시 SQL 실행 전 throw (E5). 기본 50 유지. 상한 캡은 0.2.0에서 도입하지
  않는다(Out of Scope).
- **B31.** `offset`은 0 이상의 정수여야 한다. 위반 시 SQL 실행 전 throw (E5).
  기본 0 유지.
- **B32.** `hasMore`와 `nextCursor`는 모든 `query()` 결과에 항상 존재한다
  (B5/B6) — optional이 아니다.

## SQL / DDL

신규 DDL 없음. 이 스펙은 읽기 경로 SQL만 변경한다. 테이블명은 결정 3에 따라
검증된 `tableName`의 `Prisma.raw` 보간이지만 아래는 기본값 `audit_logs`로 표기.

### query() — cursor 모드 (전체 필터 + 커서 예시)

```sql
SELECT id, tenant_id AS "tenantId", actor_id AS "actorId",
       actor_type AS "actorType", actor_ip AS "actorIp",
       action, target_type AS "targetType", target_id AS "targetId",
       source, changes, metadata, result, created_at AS "createdAt",
       to_char(created_at AT TIME ZONE 'UTC',
               'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "cursorTs"
FROM audit_logs
WHERE tenant_id = $1
  AND actor_type = $2
  AND source = $3
  AND result = $4
  AND created_at <= $5::timestamptz                         -- keyset sargable 가드
  AND (created_at, id) < ($5::timestamptz, $6::uuid)        -- keyset 타이브레이크
ORDER BY created_at DESC, id DESC
LIMIT $7;                                                   -- limit + 1
```

### query() — offset 모드 (레거시, B9)

```sql
SELECT ... , to_char(...) AS "cursorTs"
FROM audit_logs
WHERE <filters>
ORDER BY created_at DESC, id DESC
LIMIT $n OFFSET $m;          -- LIMIT은 limit + 1
```

### query() — COUNT (includeTotal !== false, B12)

```sql
SELECT COUNT(*) AS count
FROM audit_logs
WHERE <filters>;             -- keyset 조건 제외
```

### getById()

```sql
SELECT id, tenant_id AS "tenantId", actor_id AS "actorId",
       actor_type AS "actorType", actor_ip AS "actorIp",
       action, target_type AS "targetType", target_id AS "targetId",
       source, changes, metadata, result, created_at AS "createdAt"
FROM audit_logs
WHERE id = $1::uuid
  AND tenant_id = $2          -- B24 매트릭스에 따라 생략 가능
LIMIT 1;
```

### Index implications

- **Flat 레이아웃** (`src/sql/audit-log-schema.sql:32-35`):
  - 테넌트 스코프 keyset: `idx_audit_tenant_created (tenant_id, created_at DESC)`가
    `tenant_id = ? AND created_at <= ?` + DESC 정렬을 그대로 서빙한다. `id DESC`
    타이브레이크는 인덱스에 없지만, 잔여 필터는 **동일 timestamp 행에서만**
    작동하므로(마이크로초 정밀도 — 충돌 희박) 영향이 무시 가능하다.
  - actorId 필터 keyset: `idx_audit_actor (actor_id, created_at DESC)` 동일 논리.
  - `getById`: PK(id) 인덱스 단건 lookup.
  - `allTenants` 피드(테넌트 조건 없음): `created_at` 단독 선두 인덱스가 없어
    flat 레이아웃에서는 정렬 인덱스를 못 탄다. README 레시피로 선택적 인덱스
    문서화: `CREATE INDEX CONCURRENTLY idx_audit_created ON audit_logs (created_at DESC, id DESC);`
    spec 01의 생성 DDL은 이 인덱스를 기본 포함하지 **않는다**(flat은 0.1.0 인덱스
    4종 유지, partitioned는 BRIN `created_at` 추가가 전부 — spec 01 B6/B10) —
    README 레시피로만 제공한다.
- **Partitioned 레이아웃 (spec 01, 결정 4)**: PK `(id, created_at)`,
  `created_at` BRIN, `PARTITION BY RANGE (created_at)` 월별 파티션.
  - B4의 sargable 가드 `created_at <= ts`가 row-value 비교와 무관하게 파티션
    프루닝과 BRIN 레인지 스캔을 보장한다 — 커서가 가리키는 시점보다 새로운
    파티션은 스캔하지 않는다.
  - 세컨더리 인덱스(`(tenant_id, created_at DESC)` 등)는 파티션별로 생성된다는
    전제(spec 01) 하에 파티션 내 정렬 스캔 + Merge Append로 동작한다.
  - `getById`: PK가 `(id, created_at)`이므로 id 단독 lookup은 **모든 파티션의
    PK 인덱스를 탐침**한다(파티션 수 × index lookup). 여전히 인덱스 경유라
    허용 가능하나 README에 명시 문서화한다.

## Error Handling

읽기 경로(`query()`/`getById()`)의 모든 실패는 **호출자에게 직접 throw**한다.
`onAuditError`는 쓰기 경로 관측용 훅이며(결정 2의 `AuditErrorContext.phase`에
query 단계가 없음) 읽기 경로에서는 **사용하지 않는다**. 삼키는(swallow) 실패
경로는 없다.

| # | 조건 | 동작 | 메시지 (정확한 문자열) |
|---|---|---|---|
| E1 | `cursor`와 `offset` 동시 지정 (B8) | SQL 전 throw `Error` | `[@nestarc/audit-log] cursor and offset are mutually exclusive. Pass only one.` |
| E2 | 커서 디코딩/검증 실패 (B7) | SQL 전 throw `Error` | `[@nestarc/audit-log] invalid cursor.` (페이로드 내용을 메시지에 포함하지 않는다) |
| E3 | `tenantId` + `allTenants: true` 동시 지정 (B25) | SQL 전 throw `TypeError` (spec 03 B15/Q1과 동일 — 타입·문자열 모두) | `[@nestarc/audit-log] tenantId and allTenants are mutually exclusive.` |
| E4 | `tenantRequired: true` + 테넌트 해석 불가 + 명시 옵션 부재 (B24/B29) | SQL 전 throw `Error` | `[@nestarc/audit-log] tenant context required but not available. Pass an explicit tenantId or allTenants option, or ensure tenant context is set (tenantResolver / @nestarc/tenancy).` (현행 `src/services/audit.service.ts:56-59` 메시지를 명시 옵션 안내로 갱신 — spec 03 Q5에 동일 문자열로 전재됨) |
| E5 | `limit`/`offset` 정수·범위 위반 (B30/B31) | SQL 전 throw `Error` | `[@nestarc/audit-log] limit must be a positive integer.` / `[@nestarc/audit-log] offset must be a non-negative integer.` |
| E6 | `getById`에 비-UUID id (B23) | throw 아님 — `null` 반환, SQL 미실행 | — |
| E7 | DB 에러 ($queryRaw 실패) | 그대로 전파 (현행 동작 유지) | — |

## Test Plan

단위 테스트는 `$queryRaw`/`$executeRaw`를 캡처하는 mock Prisma로 SQL 텍스트와
바인드 값을 검증한다. E2E는 실제 PostgreSQL에서 수행한다.

### Unit (test/audit.service.spec.ts, test/audit-cursor.spec.ts 신규)

| 테스트 | 검증 대상 |
|---|---|
| U1. 정렬에 `id DESC` 포함 (cursor/offset 모두) | B1 |
| U2. encode → decode 라운드트립, base64url 무패딩, `v1\|ts\|id` 평문 형식 | B2 |
| U3. decode 거부: base64 아님 / 파트 2개 / `v2` 프리픽스 / ts 밀리초 3자리 / id 비-UUID — 각각 E2 메시지로 throw, `$queryRaw` 미호출 | B7, E2 |
| U4. cursor 지정 시 WHERE에 `created_at <=` 가드 + row-value 비교 둘 다 포함, ts/id가 바인드 파라미터로 전달 | B4 |
| U5. `cursor` + `offset` → E1 throw, `$queryRaw` 미호출 (`offset: 0` 명시 포함) | B8, E1 |
| U6. limit+1 fetch: limit=2, mock 3행 반환 → entries 2개, hasMore true, nextCursor = 3번째 아닌 **2번째** 행의 (cursorTs, id) 인코딩 | B5, B6 |
| U7. mock 2행(=limit) 반환 → hasMore false, nextCursor null; 0행 → entries [], nextCursor null | B5, B6 |
| U8. 반환 entries에 `cursorTs` 속성 부재 | B3 |
| U9. offset 모드에서도 nextCursor/hasMore 계산 | B6, B9 |
| U10. cursor + from/to/actorId/actorType/source/result 조합 시 모든 조건 AND 결합 | B10 |
| U11. `includeTotal: false` → `$queryRaw` 1회만 호출, `'total' in result === false` | B13 |
| U12. `includeTotal` 미지정 → COUNT 실행, total number; COUNT WHERE에 keyset 조건 부재 | B12 |
| U13. actorType/source/result 각각 단독 지정 시 대응 SQL 조건 생성, 미지정 시 부재 | B14-B16 |
| U14. B20 표의 6개 입력 각각에 대해 정확한 LIKE 패턴/정확 일치 분기 검증 (`ESCAPE '\'` 포함) | B18-B20 |
| U15. `escapeLikePattern` 단독: `\` → `\\` 선행 순서 (입력 `\%` → `\\\%`) | B19 |
| U16. getById: UUID 검증 실패 → null, SQL 미실행; 유효 UUID → `WHERE id = ?` + LIMIT 1 | B22, B23, E6 |
| U17. getById 테넌트 매트릭스 5행 각각 (allTenants / tenantId / ambient / required+없음 throw / 미required+없음 무스코프) | B24, E4 |
| U18. `tenantId` + `allTenants` → E3 throw (query, getById 각각) | B25, E3 |
| U19. query 테넌트 플래그: tenantId 우선, allTenants 시 조건 생략, required+부재 throw 메시지 | B27-B29, E4 |
| U20. limit 0 / -1 / 1.5 / NaN → E5; offset -1 / 1.5 → E5 | B30, B31, E5 |

### E2E (실제 PostgreSQL — test/e2e)

| 테스트 | 검증 대상 | Release Gate |
|---|---|---|
| E2E1. 150행 시드 → limit 50으로 cursor 3페이지 순회: 중복/누락 0, 합 150, 3페이지째 nextCursor null | B1-B6 | Gate 5: CI 피어 매트릭스에서 실행 — row-value 비교·`to_char(US)`·`ESCAPE` SQL이 Prisma 5/6 × Nest 10/11 전부에서 통과해야 함 |
| E2E2. 동일 timestamp 강제 시드(`created_at` 명시 INSERT, 마이크로초까지 동일) 10행 → 페이지 경계가 timestamp 한가운데 걸려도 중복/누락 0 (id 타이브레이크) | B1, B4 | — |
| E2E3. 페이지 순회 중간에 새 행 INSERT(최신) → 이후 페이지 결과 불변 (offset 드리프트 부재 증명) | B4 | — |
| E2E4. `includeTotal: false`에서 pg_stat 또는 쿼리 로깅으로 COUNT 미실행 확인 + total 부재 | B12, B13 | — |
| E2E5. 와일드카드: `discount_50.*`, `100%.applied`, `a*b%c_d` 시드 데이터로 B20 매칭 결과 검증 (버그 재현 케이스: `discount_*`가 `discountX.…`에 매칭되지 **않음**) | B18-B21 | — |
| E2E6. getById: 자기 테넌트 행 조회 성공, 타 테넌트 행 null, allTenants로 동일 행 조회 성공 | B22-B26 | spec 03의 테넌트 격리 게이트와 공유 |
| E2E7. actorType/source/result 필터를 manual log(`AuditService.log`) + 자동 추적 혼합 시드로 검증 (source: 'manual' vs 'auto' 분리) | B14-B16 | Gate 2(HTTP E2E)와 같은 수트에서 실행 권장 |
| E2E8. 파티션 레이아웃(spec 01 DDL) 위에서 E2E1 반복 + `EXPLAIN`으로 커서 시점 이후 파티션 프루닝 확인 | B4, Index implications | spec 01 출시 게이트와 연동 |

## Migration & Docs Impact

### CHANGELOG (0.2.0)

```
### Added
- AuditService.query(): keyset cursor pagination (`cursor`, `nextCursor`, `hasMore`).
- AuditService.query(): new filters `actorType`, `source`, `result`.
- AuditService.query(): `includeTotal: false` to skip the COUNT query.
- AuditService.getById(id, options?) single-entry lookup with tenant scoping.

### Fixed
- query(): literal `%` and `_` in wildcard action patterns are now escaped
  (previously acted as unintended wildcards).

### Changed
- query() ordering is now deterministic: `ORDER BY created_at DESC, id DESC`
  (previously ties between identical timestamps were unordered).
- AuditQueryResult.total is now optional at the type level (present unless
  `includeTotal: false`). Runtime behavior of existing calls is unchanged.
- Passing both `cursor` and `offset` to query() throws.
```

### README

- Query API 섹션 재작성: cursor 페이지네이션을 기본 예시로, offset은 레거시로
  표기. `includeTotal: false` 권장 문구(피드/무한스크롤).
- `nextCursor` 사용 예시 (do/while 루프), "커서는 불투명 — 파싱/저장 형식에
  의존하지 말 것" 경고.
- `allTenants` 피드용 선택적 인덱스 레시피(`(created_at DESC, id DESC)`),
  파티션 레이아웃에서 `getById`가 전 파티션 인덱스 탐침임을 명시.
- 무스코프 동작(B29, tenantRequired 미설정 + 컨텍스트 부재) 경고 문서화.

### Design doc (docs/2026-04-04-audit-log-design.md)

- 80-91행 Query API 예시를 v2 형태(cursor, includeTotal, 신규 필터)로 갱신.
- 와일드카드 설명(83행 `// 와일드카드 지원`)에 이스케이프 규칙 각주 추가.

### Breaking-change notes

런타임 breaking 없음. 타입 수준 주의 2건을 CHANGELOG에 명시:

1. `AuditQueryResult.total`이 `number` → `number | undefined` (strict TS에서
   non-null 단언 또는 `includeTotal` 계약 확인 필요).
2. `cursor` + `offset` 동시 전달이 throw — 기존에 불가능했던 조합이므로 실질
   영향 없음.

## Decisions

- **D1. 커서 형식 `v1|<micro-ISO>|<uuid>` + base64url, 내부 전용**: 버전
  프리픽스로 0.3.0+ 형식 진화(예: 필터 해시 추가) 대비. encode/decode 헬퍼는
  export하지 않는다 — 커서를 공개 계약으로 만들면 형식이 영구 동결되기 때문.
- **D2. `cursor` vs `offset` → throw (침묵 우선순위 아님)**: 0.2.0 주제인
  fail-loud와 일치. 침묵으로 한쪽을 무시하면 페이지네이션 버그가 데이터 누락으로
  나타나 디버깅이 가장 비싸다.
- **D3. COUNT는 keyset 조건 제외**: total이 "필터 매칭 전체 건수"로 페이지 간
  안정 — 페이지네이션 UI(`n / total`)의 유일하게 유용한 의미론. 커서 이후 잔여
  건수가 필요한 사례는 확인되지 않았다.
- **D4. `id DESC` 타이브레이크를 모든 모드에 적용**: keyset 전순서의 필요조건.
  offset 모드만 구식 정렬로 남기면 두 모드의 결과가 달라져 마이그레이션 검증이
  불가능해진다. 동일 timestamp 행 간 순서 변화는 기존에도 보장이 없던 영역이라
  breaking으로 취급하지 않는다.
- **D5. limit+1 fetch로 hasMore 판정**: 추가 COUNT나 EXISTS 없이 1행 비용으로
  정확한 hasMore 제공. "마지막 페이지가 정확히 limit행"일 때의 빈 추가 페이지
  문제 제거.
- **D6. 마이크로초 정밀도를 `to_char` 프로젝션으로 확보**: JS `Date`는 밀리초
  절단으로 같은 밀리초 내 행의 keyset 경계가 틀어진다(누락/중복). 반환 entry의
  `createdAt: Date`는 소비자 호환을 위해 유지하고, 커서용 정밀 값만 내부 컬럼으로
  분리 후 제거한다.
- **D7. keyset에 sargable 가드(`created_at <= ts`) 중복 추가**: row-value 비교
  단독으로는 파티션 프루닝/BRIN 활용이 플래너 버전에 따라 불확실하다. 잉여
  조건은 결과를 바꾸지 않으면서 실행 계획을 보장한다.
- **D8. 신규 필터도 기존 truthiness 검사 유지**: 기존 6개 필터가 truthy 검사
  (`src/services/audit.service.ts:66-88`)인 상태에서 신규만 `!== undefined`로
  하면 빈 문자열 처리 의미론이 갈라진다. `''` 정확 일치 필터의 실수요가 없으므로
  일관성을 우선. 0.3.0에서 전체 `!== undefined` 전환 재검토 가능.
- **D9. `getById`에 `tenantId`/`allTenants` 옵션 제공 (로드맵 문언 초과)**:
  단건 조회만 교차 테넌트 수단이 없으면 관리자 화면이 `query({ targetId })`로
  우회하게 된다 — spec 03 매트릭스를 동일 적용하는 쪽이 표면적 일관성 비용이
  더 낮다. 매트릭스 자체는 spec 03이 규범.
- **D10. `getById` 비-UUID 입력 → null (throw 아님)**: 잘못된 형식의 id는
  "존재할 수 없는 id"이므로 not-found 의미론이 자연스럽고, PostgreSQL 22P02
  에러 누수를 막는다. E1-E5(호출 계약 위반)와 달리 데이터 질의의 정상 결과로
  본다.
- **D11. `total?: number` (오버로드 시그니처 대신)**: 조건부 타입/오버로드는
  `AuditQueryResult`를 제네릭으로 오염시키고 소비자 타입 표기를 복잡하게 한다.
  기본값 true로 런타임 호환이 보존되므로 optional 단일 타입이 비용 대비 최선.
- **D12. 정렬 방향 제어 미제공**: 로드맵 명시 제외 항목. 커서 형식이 방향을
  인코딩하지 않으므로 0.3.0에서 추가 시 `v2` 커서로 자연 확장 가능.
- **D13. `*` 포함 패턴에서 리터럴 `*` 매칭 불가**: `*`용 이스케이프 문법(예:
  `\*`) 도입은 기존 사용자 패턴의 의미를 바꿀 수 있어 보류. action 네이밍
  관례(`model.verb`)에 `*`가 등장할 실수요가 없다.

## Out of Scope

- 정렬 방향 제어(`orderBy`/`direction`) — 로드맵 명시 제외.
- 커서에 필터 해시 포함(필터 변경 감지) — 0.3.0에서 `v2` 커서로 재평가.
- `limit` 상한 캡 — 기존 무제한 동작 보존. 도입 시 breaking이므로 별도 결정 필요.
- `changes`/`metadata` JSONB 내용 검색 — GIN 인덱스 옵션은 spec 01(#1) 소관,
  쿼리 표면은 0.3.0+.
- 배치 연산 충실도(#10)·중첩 쓰기 감사 — 0.3.0. 본 스펙은 쿼리 표면만 다루며
  해당 행의 형태(count-only metadata)는 그대로 조회된다.
- 커서 encode/decode 헬퍼의 public export.
- 집계 API(그룹별 카운트, 액터별 통계 등).
