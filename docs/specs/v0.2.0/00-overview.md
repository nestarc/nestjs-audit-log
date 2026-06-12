# v0.2.0 Specs — Overview

Date: 2026-06-12
Status: Reviewed (초안 → 일관성 조정 → 적대적 검토 2종 → 수정 반영 완료)
Source: [../2026-06-11-v0.2.0-roadmap.md](../../2026-06-11-v0.2.0-roadmap.md)

## Purpose

승인된 v0.2.0 로드맵을 구현 가능한 수준으로 상세화한 워크스트림별 스펙 모음.
각 스펙은 정확한 TypeScript 시그니처(현행 → 변경), 번호 매겨진 테스트 가능 동작(B#),
전체 DDL, 에러 처리 매트릭스, 테스트 계획, 마이그레이션 영향을 포함한다.

## Spec Index

| 파일 | 워크스트림 | 로드맵 항목 | Breaking |
|------|-----------|------------|----------|
| [01-storage-retention.md](01-storage-retention.md) | 스토리지·보존·append-only 강제 | #1, #11 | 아니오 |
| [02-extension-reliability.md](02-extension-reliability.md) | 확장 신뢰성·추적 기본값·공유 인터페이스 | #2, #3, #6 + prismaModule, updatedAt 필터, 중첩 쓰기 경계 | **예 (#2)** |
| [03-tenant-isolation.md](03-tenant-isolation.md) | 테넌트 격리·레다크션 | #4 + sensitiveFieldsByModel | 아니오 |
| [04-actor-context.md](04-actor-context.md) | 액터 컨텍스트·요청 메타데이터 | #8, #9 | 아니오 |
| [05-query-api-v2.md](05-query-api-v2.md) | 쿼리 API v2 | #7 | 아니오* |
| [06-transactions-and-release-gates.md](06-transactions-and-release-gates.md) | 트랜잭션 정합성·릴리스 게이트 | #5 + Release Gates G1–G6 | 아니오 |

\* 단일 런타임 동작 변경: `limit: 0`이 빈 결과 대신 throw (fail-loud, CHANGELOG Changed 기재).

## Shared Type Ownership

공유 타입의 canonical 정의는 **스펙 02**가 소유한다. 다른 스펙의 전사본은 스펙 02와
문자 단위로 일치해야 하며(JSDoc 생략 허용, 각 스펙에 명시), 충돌 시 스펙 02가 우선한다.

- `AuditSharedOptions` — `tableName` / `tenantRequired` / `tenantResolver` / `onAuditError` / `logger`.
  `AuditExtensionOptions`와 `AuditLogModuleOptions`가 공통 확장. 런타임 병합 없음 —
  권장 사용 패턴은 하나의 공유 상수를 양쪽 호출부에 스프레드.
- `AuditErrorContext` — phase: `'pre-read' | 'insert' | 'post-read' | 'tenant-resolution' | 'context'`
- `AuditLogger` — console·NestJS LoggerService 양쪽 호환 최소 인터페이스
- `PrismaModuleLike` — 커스텀 generator output 지원용 Prisma 네임스페이스 주입 형태

## Implementation Order

의존 관계상 권장 구현 순서:

1. **스펙 02** — 공유 인터페이스와 `onAuditError`/`reportAuditError`가 모든 후속 작업의 기반.
   추적 기본값 변경(Breaking)과 pre-read 격리도 여기. *(pre-read 격리 + onAuditError는
   0.1.x 패치로 선행 분리 가능 — 로드맵 #3 권고)*
2. **스펙 03** — `tenant-resolution` phase가 02의 훅에 의존. `buildAuditInsertParams`
   시그니처 변경은 04와 병합 충돌 주의.
3. **스펙 04** — 메타데이터 병합이 02/03의 `buildAuditInsertParams` 최종 형태에 의존
   (병합 → 레다크션 순서: 03 B23).
4. **스펙 01** — DDL은 독립적이나 `tableName` 런타임 스레딩이 02의 옵션 플러밍을 전제.
   트리거 강제 모드가 신규 DDL 기본값.
5. **스펙 05** — 커서 설계가 01의 파티션 레이아웃 인덱스를, 테넌트 의미론이 03의
   Q1–Q6 매트릭스를 전제.
6. **스펙 06** — Tier 1 문서 수정은 즉시 가능. Tier 2 회귀 테스트와 게이트 테스트는
   해당 기능 구현과 함께. CI 피어 매트릭스(G6)는 조기 적용 권장.

## Release Gates

| 게이트 | 내용 | 검증 파일 (스펙 06) |
|--------|------|---------------------|
| G1 | 외부 트랜잭션 롤백 회귀 | `transactions.e2e-spec.ts` |
| G2 | 실제 HTTP 미들웨어+인터셉터 경로 | `http-path.e2e-spec.ts` (supertest) |
| G3 | upsert/createMany/updateMany E2E | `batch-and-upsert.e2e-spec.ts` |
| G4 | append-only 강제 검증 (rule no-op vs trigger RAISE) | `append-only.e2e-spec.ts` |
| G5 | CI 피어 매트릭스 (Nest 10/11 × Prisma 5/6) | GitHub Actions matrix job |
| G6 | 문서 정합성 (설계 문서 원자성 서술, 검증 보고서 평결) | 스펙 06 Tier 1 + 체크리스트 |

## Key Decisions (스펙 단계에서 확정)

로드맵이 "결정 필요"로 남긴 항목들의 확정 내역. 상세 근거는 각 스펙의 Decisions 절 참조.

1. **설정 이중화**: 모듈/확장 간 런타임 병합 없음. `AuditSharedOptions` 공유 상수
   스프레드 패턴으로 해결 (스펙 02).
2. **tenantRequired 자동 경로**: tenant 미해석 시 NULL 행 기록이 아니라 **감사 INSERT
   스킵** + `onAuditError` 보고. 비즈니스 연산은 항상 진행 (스펙 03).
3. **교차 테넌트 쿼리**: 명시적 `allTenants: true` 플래그로만 도달 가능. 명시
   `tenantId`와 동시 지정 시 TypeError (스펙 03 Q1–Q6).
4. **DDL 기본값**: 신규 생성 DDL은 트리거(RAISE EXCEPTION) 강제가 기본, RULE은
   레거시 호환 모드 (스펙 01).
5. **트랜잭션 정합성**: Prisma 확장에 공식 tx-client 접근이 없음을 확인. Tier 1(문서
   정정)·Tier 2(회귀 베이스라인)는 필수, Tier 3(`experimentalTxAudit`)은 실험적
   옵트인 (스펙 06).
6. **중첩 쓰기 경계**: 풀 지원은 0.3.0. 0.2.0은 경계 문서화 + 추적 모델 대상 중첩
   쓰기 감지 시 1회 경고 (스펙 02 B45).
7. **커스텀 Prisma output**: `prismaModule` 옵션을 확장·모듈 양쪽에 제공,
   `AuditService`의 정적 import 제거 (스펙 02 B46).
8. **`includeTotal`**: 하위 호환을 위해 기본 true, 문서는 피드 용도에 false 권장
   (스펙 05).

## Out of Scope (0.2.0)

- 배치 연산 레코드별 diff (로드맵 #10 — 0.3.0)
- 중첩 관계 쓰기의 풀 감사 지원 (0.3.0)
- 중첩 경로(nested-path) 레다크션 매칭 (0.3.0)
- 다중 데이터베이스, 인-라이브러리 스케줄러, UI/SIEM/해시 체인 (로드맵 Out of Scope)

## Provenance

- 2026-06-11: 6개 스펙 병렬 초안 작성 (커밋 4968339)
- 2026-06-12: 일관성 조정 17건 수정 → 적대적 검토(실현 가능성/완전성) 14건 지적 →
  전건 반영 + 미해결 소유권 3건 확정 (D-A/D-B/D-C) → 공유 타입 동일성 최종 확인
