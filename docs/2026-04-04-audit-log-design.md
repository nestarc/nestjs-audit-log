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
| 저장소 | 같은 PostgreSQL DB | 추가 인프라 불필요. append-only rule로 불변성 |
| 자동 추적 | Prisma `$extends` | tenancy와 동일 패턴. 모든 모델 커버 |
| Actor 전파 | AsyncLocalStorage | tenancy와 동일 패턴. REQUEST scope 회피 |
| tenancy 연동 | optional peer dep | 미설치 시 tenantId=null. graceful degradation |

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
  actorId: 'user-123',
  action: 'invoice.*',     // 와일드카드 지원
  targetType: 'Invoice',
  from: new Date('2026-01-01'),
  to: new Date('2026-04-01'),
  limit: 50,
  offset: 0,
});
// → { entries: AuditEntry[], total: number }
```

tenantId는 자동 주입 — 테넌트 간 로그 격리.

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

-- Append-only enforcement (SOC2)
CREATE RULE audit_logs_no_update AS ON UPDATE TO audit_logs DO INSTEAD NOTHING;
CREATE RULE audit_logs_no_delete AS ON DELETE TO audit_logs DO INSTEAD NOTHING;

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
| `tenant_id` | TEXT | TenancyService | `@nestarc/tenancy` 자동 주입. 미설치 시 null |
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
          → trackedModels 확인 (미포함이면 skip)
          → [update/delete] before 상태 findFirst
          → 원본 쿼리 실행
          → diff 계산 + sensitiveFields 마스킹
          → audit_logs INSERT (같은 트랜잭션)
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

### @nestarc/tenancy Integration

```typescript
// audit-context.ts 또는 audit.service.ts 내부
private getTenantId(): string | null {
  try {
    // optional peer — dynamic require
    const { TenancyContext } = require('@nestarc/tenancy');
    return new TenancyContext().getTenantId();
  } catch {
    return null; // @nestarc/tenancy 미설치
  }
}
```

tenancy가 설치되어 있으면 tenantId 자동 주입. 미설치 시 null. 별도 설정 불필요.

## Performance Considerations

- `trackedModels` 화이트리스트로 추적 대상 제한 → 미추적 모델 오버헤드 0
- before 조회는 update/delete에서만 발생 → create/read 오버헤드 0
- audit_logs INSERT는 원본 쿼리와 같은 batch transaction으로 실행 → 원자성 보장
- JSONB 인덱스는 v0.2.0에서 GIN 인덱스 추가 고려

## Security

- **Append-only**: PostgreSQL RULE로 UPDATE/DELETE 차단. DB 레벨 불변성.
- **필드 마스킹**: `sensitiveFields`에 지정된 필드는 diff에서 `[REDACTED]`로 대체.
- **테넌트 격리**: tenancy RLS 적용 시 audit_logs도 테넌트 간 격리 가능.
- **SQL injection**: Prisma `$executeRaw` tagged template 사용 (tenancy와 동일 패턴).

## Out of Scope (v0.1.0)

- Retention/archival policy (v0.2.0)
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
