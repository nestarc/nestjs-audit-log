# @nestarc/audit-log — Design Spec

Date: 2026-04-04
Status: Approved

## Goal

NestJS + Prisma + PostgreSQL 환경을 위한 감사 로그 모듈. Prisma extension으로 CUD 변경을 자동 추적하고, 수동 로깅 API로 비즈니스 이벤트를 기록하며, 쿼리 서비스로 로그를 검색한다. `@nestarc/tenancy`와 자연스럽게 연동하여 모든 로그에 tenantId가 자동 포함된다.

## Market Gap

NestJS 생태계에 audit-log 패키지는 여럿 있지만, 모두 한 가지 방식(HTTP interceptor-only, ORM subscriber-only, exporter-only)에 국한된다. 세 계층(HTTP 컨텍스트 + 엔티티 diff + 저장)을 결합하면서 멀티테넌트를 지원하는 패키지는 0개.

핵심 pain points:
1. ORM subscriber에서 "누가 이 변경을 했는지" 알 수 없음 (DI 접근 불가)
2. bulk operation (`updateMany`, `deleteMany`) 추적 불가
3. 민감 필드 마스킹 미지원
4. 쿼리/검색 API 없음 (write-only)
5. 멀티테넌트 격리 미지원

## Design Decisions

| 결정 | 선택 | 이유 |
|------|------|------|
| ORM | Prisma 전용 | tenancy와 동일 전략. 생태계 일관성 |
| 저장소 | 같은 PostgreSQL DB | 추가 인프라 불필요. append-only trigger enforcement로 불변성 |
| 자동 추적 | Prisma `$extends` | tenancy와 동일 패턴. 모든 모델 커버 |
| Actor 전파 | AsyncLocalStorage | tenancy와 동일 패턴. REQUEST scope 회피 |
| tenancy 연동 | optional peer dep + `tenantResolver` | 명시 resolver 우선, `@nestarc/tenancy` fallback, 쿼리는 `tenantId`/`allTenants`로 명시 스코프 |

## Module API

### Registration

```typescript
@Module({
  imports: [
    AuditLogModule.forRoot({
      // 자동 추적 대상 Prisma 모델명 (화이트리스트)
      trackedModels: ['User', 'Invoice', 'Document'],
      // 추적 제외 모델 (선택)
      ignoredModels: ['Session', 'RefreshToken'],
      // 매 요청에서 actor 추출
      actorExtractor: (req: Request) => ({
        id: req.user?.id,
        type: req.user ? 'user' : 'system',
        ip: req.ip,
      }),
      // 민감 필드 — diff에서 "[REDACTED]"로 대체
      sensitiveFields: ['password', 'ssn', 'creditCard'],
    }),
  ],
})
export class AppModule {}
```

`forRootAsync` 도 지원 (ConfigService 주입 등).

### Manual Logging

```typescript
@Injectable()
class PaymentService {
  constructor(private readonly audit: AuditService) {}

  async approveInvoice(invoiceId: string) {
    await this.prisma.invoice.update({ ... });
    await this.audit.log({
      action: 'invoice.approved',
      targetId: invoiceId,
      targetType: 'Invoice',
      metadata: { amount: 5000, currency: 'USD' },
    });
  }
}
```

### Query API

```typescript
const result = await auditService.query({
  tenantId: 'tenant-1',
  actorId: 'user-123',
  action: 'invoice.*',     // 와일드카드 지원
  targetType: 'Invoice',
  source: 'auto',
  result: 'success',
  from: new Date('2026-01-01'),
  to: new Date('2026-04-01'),
  limit: 50,
  includeTotal: false,
});
// → { entries: AuditEntry[], nextCursor: string | null, hasMore: boolean }

if (result.hasMore) {
  await auditService.query({
    tenantId: 'tenant-1',
    cursor: result.nextCursor!,
    limit: 50,
    includeTotal: false,
  });
}
```

기본 정렬은 `(created_at DESC, id DESC)`이며 cursor는 같은 timestamp 경계에서도
중복/누락을 막는다. `includeTotal: false`는 피드형 조회에서 `COUNT(*)`를 생략한다.
교차 테넌트 조회는 `allTenants: true`를 명시한 경우에만 허용하며, `tenantId`와
`allTenants`는 동시에 사용할 수 없다.

### Decorators

```typescript
// 특정 라우트 감사 제외
@NoAudit()
@Get('health')
healthCheck() { ... }

// 비즈니스 액션 명시 (metadata 자동 수집)
@AuditAction('user.role.changed')
@Patch(':id/role')
changeRole() { ... }
```

## Data Model

```sql
CREATE TABLE audit_logs (
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

-- Append-only trigger enforcement (SOC2, default)
CREATE OR REPLACE FUNCTION audit_logs_block_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '@nestarc/audit-log: % blocked on append-only table %',
    TG_OP, TG_TABLE_NAME
    USING ERRCODE = 'P0001',
          HINT = 'Use AuditService.prune() for retention maintenance.';
END;
$$;

CREATE TRIGGER audit_logs_no_update_trg
  BEFORE UPDATE ON audit_logs
  FOR EACH ROW EXECUTE FUNCTION audit_logs_block_mutation();

CREATE TRIGGER audit_logs_no_delete_trg
  BEFORE DELETE ON audit_logs
  FOR EACH ROW EXECUTE FUNCTION audit_logs_block_mutation();

-- Legacy RULE mode remains available through getAuditTableSQL({ enforcement: 'rule' }).

-- Query performance indexes
CREATE INDEX idx_audit_tenant_created ON audit_logs (tenant_id, created_at DESC);
CREATE INDEX idx_audit_actor ON audit_logs (actor_id, created_at DESC);
CREATE INDEX idx_audit_target ON audit_logs (target_type, target_id);
CREATE INDEX idx_audit_action ON audit_logs (action);
```

### Fields

| Field | Type | Source | Description |
|-------|------|--------|-------------|
| `id` | UUID | auto | PK |
| `tenant_id` | TEXT | resolveTenantId | `tenantResolver` 우선, `@nestarc/tenancy` fallback. 자동 경로에서 `tenantRequired` + null이면 audit entry skipped |
| `actor_id` | TEXT | AuditActorMiddleware | actorExtractor에서 추출 |
| `actor_type` | TEXT | AuditActorMiddleware | 'user' \| 'system' \| 'api_key' |
| `actor_ip` | TEXT | AuditActorMiddleware | req.ip |
| `action` | TEXT | extension/service | 'user.created', 'invoice.approved' 등 |
| `target_type` | TEXT | extension/service | Prisma 모델명 또는 커스텀 |
| `target_id` | TEXT | extension/service | 대상 레코드의 ID |
| `source` | TEXT | internal | 'auto' (extension) \| 'manual' (service) |
| `changes` | JSONB | extension | `{ field: { before, after } }` diff. create는 after만, delete는 before만 |
| `metadata` | JSONB | service/decorator | 자유 형식 추가 컨텍스트 |
| `result` | TEXT | extension/service | 'success' \| 'failure' |
| `created_at` | TIMESTAMPTZ | auto | 생성 시각 |

### Changes JSONB Format

```jsonc
// create
{ "name": { "after": "Alice" }, "email": { "after": "alice@example.com" } }

// update
{ "email": { "before": "old@example.com", "after": "new@example.com" } }

// update with sensitive field
{ "password": { "before": "[REDACTED]", "after": "[REDACTED]" } }

// delete
{ "name": { "before": "Alice" }, "email": { "before": "alice@example.com" } }
```

## Architecture

### File Structure

```
src/
├── audit-log.module.ts              # DynamicModule (forRoot/forRootAsync)
├── audit-log.constants.ts           # 인젝션 토큰
├── interfaces/
│   ├── audit-log-options.interface.ts   # AuditLogModuleOptions
│   ├── audit-entry.interface.ts         # AuditEntry, AuditQueryOptions
│   └── actor.interface.ts               # AuditActor, ActorExtractor
├── services/
│   ├── audit.service.ts             # 공개 API: log(), query()
│   └── audit-context.ts             # AsyncLocalStorage — actor 컨텍스트
├── prisma/
│   └── audit-extension.ts           # Prisma $extends — CUD 자동 추적
├── middleware/
│   └── audit-actor.middleware.ts    # 요청에서 actor 추출 → context
├── decorators/
│   ├── no-audit.decorator.ts        # @NoAudit()
│   └── audit-action.decorator.ts    # @AuditAction('action.name')
└── index.ts                         # 배럴 export
```

### Data Flow

```
HTTP Request
  → AuditActorMiddleware (actor 추출 → AsyncLocalStorage)
    → TenantMiddleware (tenant 추출 — @nestarc/tenancy)
      → Controller → Service
        → Prisma Extension (CUD 감지)
          → shouldTrackModel 확인 (기본은 모든 모델 추적, trackedModels allowlist/ignoredModels denylist)
          → resolveTenantId (tenantResolver → @nestarc/tenancy → null)
          → [update/delete] before 상태 findFirst
          → 원본 쿼리 실행
          → diff 계산 + sensitiveFields 마스킹
          → audit_logs INSERT (base client best-effort; caller transaction 밖)
```

### Prisma Extension Behavior

| Operation | before 조회 | after 조회 | changes |
|-----------|------------|-----------|---------|
| `create` | 불필요 | 쿼리 결과 | after만 |
| `update` | findFirst(where) | 쿼리 결과 | before/after diff |
| `upsert` | findFirst(where) | 쿼리 결과 | create 또는 update로 분기 |
| `delete` | findFirst(where) | 불필요 | before만 |
| `createMany` | 불필요 | 개수만 기록 | count만 (개별 diff 불가) |
| `updateMany` | 불필요 | 개수만 기록 | count만 (개별 diff 불가) |
| `deleteMany` | findMany(where) | 불필요 | 각 레코드 before |

`*Many` 작업의 제약: Prisma가 개별 레코드를 반환하지 않으므로, `createMany`/`updateMany`는 변경 수만 기록. `deleteMany`는 삭제 전 조회가 가능하므로 개별 기록.

### Tenant Resolution

```typescript
function resolveTenantId(options?: {
  tenantResolver?: () => string | null;
}): string | null {
  if (options?.tenantResolver) return options.tenantResolver();
  // optional peer probe, cached process-wide
  // @nestarc/tenancy unavailable -> null
  return new TenancyContext().getTenantId();
}
```

자동 추적 경로에서 `tenantRequired: true`이고 tenant가 없으면 audit row를 쓰지 않고
`onAuditError(..., { phase: 'tenant-resolution' })` 또는 logger로 `audit entry skipped`를
보고한다. 이 경우에도 business mutation still returns. `AuditService.log()`와 ambient
`query()`/`getById()`는 `tenantRequired: true`일 때 tenant가 없으면 throw한다. 관리자 조회는
`allTenants: true`를 명시해야 하며 `tenantId`와 `allTenants`는 상호 배타적이다.

## Performance Considerations

- 기본 설정은 모든 모델을 추적한다. `trackedModels` allowlist 또는 `ignoredModels` denylist로 추적 대상 제한 → 미추적 모델 오버헤드 0
- before 조회는 update/delete에서만 발생 → create/read 오버헤드 0
- automatic audit INSERT는 caller transaction에 참여하지 않는다. 비즈니스 쓰기는 caller `$transaction`에 남지만, 자동 감사 INSERT는 base client best-effort 경로이므로 rollback 시 orphan row가 남을 수 있다.
- Query API v2는 `(tenant_id, created_at DESC)`와 `(actor_id, created_at DESC)` 인덱스, partitioned table의 BRIN 인덱스를 활용한다.
- `AuditService.prune()`는 flat table에서 trigger/RULE을 일시적으로 우회하고, partitioned table에서는 만료된 월 partition만 drop/detach한다.

## Security

- **Append-only**: PostgreSQL trigger enforcement로 UPDATE/DELETE를 예외 처리한다. RULE enforcement는 legacy compatibility mode.
- **필드 마스킹**: `sensitiveFields`에 지정된 필드는 diff에서 `[REDACTED]`로 대체.
- **테넌트 격리**: query/getById는 ambient tenant, explicit `tenantId`, explicit `allTenants` 매트릭스로 스코프를 결정한다.
- **SQL injection**: Prisma `$executeRaw` tagged template 사용 (tenancy와 동일 패턴).

## Out of Scope (v0.2.0)

- SIEM export (Datadog, S3) (v0.3.0)
- CSV/JSON bulk export endpoint
- Webhook on specific actions
- Microservice transport audit (@MessagePattern, @EventPattern)
- Auto PII detection (field name heuristics)
- Embedded UI viewer

## Package Metadata

```json
{
  "name": "@nestarc/audit-log",
  "peerDependencies": {
    "@nestjs/common": "^10.0.0 || ^11.0.0",
    "@nestjs/core": "^10.0.0 || ^11.0.0",
    "@prisma/client": "^5.0.0 || ^6.0.0",
    "@types/express": "^4.17.0 || ^5.0.0",
    "reflect-metadata": "^0.1.13 || ^0.2.0",
    "rxjs": "^7.0.0"
  },
  "peerDependenciesMeta": {
    "@nestarc/tenancy": { "optional": true }
  }
}
```

## Success Criteria

- `npm run build` 통과
- 유닛 테스트: 90%+ 커버리지
- E2E 테스트: 실제 PostgreSQL에서 자동 추적 + 쿼리 검증
- `@nestarc/tenancy` 미설치 상태에서도 정상 동작
- README: Quick Start 5분 이내 완료 가능

## Change History

- 2026-06-12: Corrected transaction model language. Automatic audit INSERT는 caller transaction에 참여하지 않는다; use manual `AuditService.log(input, tx)` when audit rows must roll back atomically with business work.
- 2026-06-12: Aligned Query API, trigger enforcement, tenantRequired path behavior, tracking defaults, and retention notes with v0.2.0 specs.
