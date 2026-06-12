import { readFileSync } from 'fs';
import { join } from 'path';

const root = join(__dirname, '..');

function read(path: string): string {
  return readFileSync(join(root, path), 'utf8');
}

describe('v0.2.0 documentation gates', () => {
  it('documents the automatic transaction orphan-row contract in README', () => {
    const readme = read('README.md');

    expect(readme).toContain(
      'automatic audit inserts do not join the caller transaction',
    );
    expect(readme).toContain('orphan rows on rollback');
    expect(readme).toContain('AuditService.log(input, tx)');
    expect(readme).toContain('experimentalTxAudit');
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
    expect(ci).toContain('npm run test:e2e');
  });

  it('documents v0.2.0 release notes in CHANGELOG', () => {
    const changelog = read('CHANGELOG.md');

    expect(changelog).toContain('## [0.2.0]');
    expect(changelog).toContain('Tracking default changed');
    expect(changelog).toContain('AuditService.query(): keyset cursor pagination');
    expect(changelog).toContain('append-only default enforcement changed');
    expect(changelog).toContain('AuditService.prune');
    expect(changelog).toContain('experimentalTxAudit');
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
});
