import { readFileSync } from 'fs';
import { join } from 'path';

const root = join(__dirname, '..');

function read(path: string): string {
  return readFileSync(join(root, path), 'utf8');
}

describe('documentation gates', () => {
  it('documents atomic-required and explicit legacy best-effort contracts', () => {
    const readme = read('README.md');

    expect(readme).toContain("consistency: 'atomic-required'");
    expect(readme).toContain('withAuditTransaction()');
    expect(readme).toContain('rejects tracked writes outside');
    expect(readme).toContain('orphan success rows');
    expect(readme).toContain('AuditService.log(input, tx)');
    expect(readme).toContain('experimentalTxAudit');
    expect(readme).toContain('databaseMapping');
    expect(readme).toContain('lock the target row and refresh the preimage');
    expect(readme).toContain(
      'Preview — choose the automatic tracking consistency explicitly',
    );
  });

  it('records the v0.5.0 experimental transaction routing removal policy', () => {
    const adr = read('docs/2026-08-28-experimental-tx-audit-removal-adr.md');
    const changelog = read('CHANGELOG.md');

    expect(adr).toContain('Status: Accepted');
    expect(adr).toContain('Target release: `0.5.0`');
    expect(adr).toContain("consistency: 'atomic-required'");
    expect(adr).toContain("consistency: 'best-effort'");
    expect(adr).toContain('AuditService.log(input, tx)');
    expect(adr).toContain('_createItxClient()');
    expect(adr).toContain('__internalParams');
    expect(adr).toContain('runtime tombstone');
    expect(changelog).toContain(
      'Remove the deprecated `AuditExtensionOptions.experimentalTxAudit`',
    );
  });

  it('marks pre-release v0.2 planning documents as historical', () => {
    const roadmap = read('docs/2026-06-11-v0.2.0-roadmap.md');
    const overview = read('docs/specs/v0.2.0/00-overview.md');
    const specs = [
      '01-storage-retention.md',
      '02-extension-reliability.md',
      '03-tenant-isolation.md',
      '04-actor-context.md',
      '05-query-api-v2.md',
      '06-transactions-and-release-gates.md',
    ].map((name) => read(`docs/specs/v0.2.0/${name}`));

    expect(roadmap).toContain('Status: Historical roadmap');
    expect(roadmap).not.toContain('Status: Proposed');
    expect(overview).toContain('Status: Historical implementation specification');
    for (const spec of specs) {
      expect(spec).toContain('Status: Historical v0.2.0 implementation specification');
      expect(spec).not.toContain('Status: Draft');
    }
  });

  it('removes obsolete atomicity claims from the design document', () => {
    const design = read('docs/2026-04-04-audit-log-design.md');

    expect(design).not.toContain('audit_logs INSERT (같은 트랜잭션)');
    expect(design).not.toContain(
      'audit_logs INSERT는 원본 쿼리와 같은 batch transaction으로 실행 → 원자성 보장',
    );
    expect(design).toContain('2026-06-12');
    expect(design).toContain(
      'automatic audit INSERT는 caller transaction에 참여하지 않는다',
    );
  });

  it('adds a dated disposition appendix to the validation report', () => {
    const report = read('docs/2026-04-04-v0.1.0-validation-report.md');

    expect(report).toContain('## Disposition (2026-06-12)');
    expect(report).toContain('0.1.0 was released on 2026-04-05');
    expect(report).toContain('Finding 1');
    expect(report).toContain('spec 06 Tier 1/2/3');
  });

  it('defines a peer dependency CI matrix for Nest and Prisma combinations', () => {
    const ci = read('.github/workflows/ci.yml');

    expect(ci).toContain('peer-matrix');
    expect(ci).toContain('nest: 10');
    expect(ci).toContain('nest: 11');
    expect(ci).toContain('prisma: 5');
    expect(ci).toContain('prisma: 6');
    expect(ci).toContain('prisma: 7');
    expect(ci).toContain('npm run test:e2e');
  });

  it('keeps the supported Node and Actions runtime policy aligned', () => {
    const packageJson = JSON.parse(read('package.json')) as {
      engines: { node: string };
    };
    const readme = read('README.md');
    const changelog = read('CHANGELOG.md');
    const ci = read('.github/workflows/ci.yml');
    const release = read('.github/workflows/release.yml');

    expect(packageJson.engines.node).toBe('^22.13.0 || ^24.0.0');
    expect(readme).toContain(
      'Node.js 22.13+ within the 22.x line, or Node.js 24.x',
    );
    expect(changelog).toContain('final Node.js 20-compatible release');
    expect(ci).toContain("node-version: ['22.13', '24']");
    expect(ci).not.toContain("node-version: '20.19'");
    expect(`${ci}\n${release}`).not.toMatch(
      /actions\/(?:checkout|setup-node)@v[1-6]\b/,
    );
    expect(`${ci}\n${release}`).toContain('actions/checkout@v7');
    expect(`${ci}\n${release}`).toContain('actions/setup-node@v7');
    expect(release).toContain('softprops/action-gh-release@v3');
  });

  it('documents Prisma 7 generator, adapter, and namespace injection setup', () => {
    const readme = read('README.md');

    expect(readme).toContain('Prisma 7 (primary)');
    expect(readme).toContain('provider = "prisma-client"');
    expect(readme).toContain("from '@prisma/adapter-pg'");
    expect(readme).toContain('prismaModule');
    expect(readme).toContain('prisma.config.ts');
  });

  it('documents v0.2.0 release notes in CHANGELOG', () => {
    const changelog = read('CHANGELOG.md');

    expect(changelog).toContain('## [0.2.0]');
    expect(changelog).toContain('Tracking default changed');
    expect(changelog).toContain('AuditService.query(): keyset cursor pagination');
    expect(changelog).toContain('append-only default enforcement changed');
    expect(changelog).toContain('AuditService.prune');
    expect(changelog).toContain('experimentalTxAudit');
    expect(changelog).toMatch(
      /they\s+do not establish transaction-atomic automatic auditing/,
    );
  });

  it('documents v0.2.0 storage, query, and nested-write behavior in README', () => {
    const readme = read('README.md');

    expect(readme).toContain('Retention & Partitioning');
    expect(readme).toContain('ensurePartitions');
    expect(readme).toContain('AuditService.prune');
    expect(readme).toContain('Query API v2');
    expect(readme).toContain('includeTotal: false');
    expect(readme).toContain('Nested writes');
    expect(readme).toContain('trigger enforcement');
  });

  it('keeps README cursor pagination examples on a fixed filter set', () => {
    const readme = read('README.md');

    expect(readme).toContain(
      `await auditService.query({
    tenantId: 'tenant-1',
    action: 'invoice.*',
    actorType: 'user',
    source: 'auto',
    result: 'success',
    cursor: page.nextCursor!,
    limit: 50,
    includeTotal: false,
  });`,
    );
  });

  it('documents tenantRequired path differences and atomic transaction behavior', () => {
    const readme = read('README.md');

    expect(readme).toContain('audit entry skipped');
    expect(readme).toContain('fails closed in `atomic-required`');
    expect(readme).toContain('tenantId and allTenants are mutually exclusive');
    expect(readme).toContain('No trackedModels/ignoredModels configured');
    expect(readme).toContain('uses no private Prisma API');
    expect(readme).toContain('experimentalTxAudit` is deprecated');
    expect(readme).not.toContain('reserved for future transaction-aware routing');
  });

  it('documents forward tenant-scoped scan and streaming CSV contracts', () => {
    const readme = read('README.md');
    const changelog = read('CHANGELOG.md');

    expect(readme).toContain('### Streaming export and CSV');
    expect(readme).toContain('auditService.scan({');
    expect(readme).toContain('page.highWatermark');
    expect(readme).toContain('auditService.exportCsv({');
    expect(readme).toContain('AUDIT_CSV_COLUMNS_V1');
    expect(readme).toContain('host-application responsibilities');
    expect(changelog).toContain('`AuditService.scan()`');
    expect(changelog).toContain('`AuditService.exportCsv()`');
  });

  it('documents durable at-least-once stream and retention contracts', () => {
    const readme = read('README.md');
    const changelog = read('CHANGELOG.md');

    expect(readme).toContain('### Durable log streams');
    expect(readme).toContain('new AuditStreamRunner');
    expect(readme).toContain('PostgresAuditStreamStore');
    expect(readme).toContain('Idempotency-Key');
    expect(readme).toContain('Retry-After');
    expect(readme).toContain('requiredCheckpoints');
    expect(changelog).toContain('`AuditStreamRunner`');
    expect(changelog).toContain('`HttpAuditStreamSink`');
  });

  it('keeps the design document aligned with v0.2.0 query, storage, and tenancy contracts', () => {
    const design = read('docs/2026-04-04-audit-log-design.md');

    expect(design).toContain('nextCursor');
    expect(design).toContain('includeTotal: false');
    expect(design).toContain('trigger enforcement');
    expect(design).toContain('resolveTenantId');
    expect(design).toContain('tenantResolver');
    expect(design).toContain('audit entry skipped');
    expect(design).not.toContain('offset: 0');
    expect(design).not.toContain('{ entries: AuditEntry[], total: number }');
    expect(design).not.toContain(
      'CREATE RULE audit_logs_no_update AS ON UPDATE TO audit_logs DO INSTEAD NOTHING',
    );
    expect(design).not.toContain('Retention/archival policy (v0.2.0)');
  });
});
