import { existsSync, readFileSync, readdirSync, statSync } from 'fs';
import { dirname, extname, join, relative, resolve, sep } from 'path';

const root = join(__dirname, '..');

function read(path: string): string {
  return readFileSync(join(root, path), 'utf8');
}

const guides = [
  'docs/agent-guide.md',
  'docs/adoption-guide.md',
  'docs/api-reference.md',
  'docs/transactions.md',
  'docs/context-and-tenancy.md',
  'docs/storage-and-retention.md',
  'docs/export-and-streams.md',
  'docs/benchmarks.md',
  'docs/maintaining.md',
];
const currentUsage = ['README.md', 'llms.txt', ...guides, 'examples/quick-start/README.md'];
const packageFiles = (JSON.parse(read('package.json')) as { files: string[] }).files;

function selectedForPackage(path: string): boolean {
  // npm includes the root README and license even when omitted from `files`.
  return ['README.md', 'LICENSE', 'package.json'].includes(path) ||
    packageFiles.some((entry) => path === entry || path.startsWith(`${entry}/`));
}

function exampleFiles(directory = 'examples/quick-start'): string[] {
  return readdirSync(join(root, directory), { withFileTypes: true }).flatMap((entry) => {
    if (['node_modules', 'dist', 'generated', '.git'].includes(entry.name)) return [];
    const path = `${directory}/${entry.name}`;
    return entry.isDirectory() ? exampleFiles(path) : [path];
  });
}

function prose(markdown: string): string {
  let fence: string | undefined;
  return markdown.split('\n').filter((line) => {
    const marker = line.match(/^\s*(`{3,}|~{3,})/);
    if (marker) {
      if (!fence) fence = marker[1];
      else if (marker[1][0] === fence[0] && marker[1].length >= fence.length) fence = undefined;
      return false;
    }
    return !fence;
  }).join('\n');
}

function linkTargets(markdown: string): string[] {
  const text = prose(markdown);
  const inline = [...text.matchAll(/\[[^\]\n]*\]\(\s*(?:<([^>\n]+)>|([^\s)]+))(?:\s+["'][^"']*["'])?\s*\)/g)]
    .map((match) => match[1] ?? match[2]);
  const references = [...text.matchAll(/^ {0,3}\[[^\]]+\]:\s*<?([^\s>]+)>?/gm)]
    .map((match) => match[1]);
  return [...inline, ...references];
}

function headingAnchors(markdown: string): Set<string> {
  const anchors = new Set<string>();
  const occurrences = new Map<string, number>();
  for (const match of prose(markdown).matchAll(/^ {0,3}#{1,6}\s+(.+?)\s*#*\s*$/gm)) {
    // GitHub heading slugs preserve letters, numbers, hyphens, and underscores.
    const base = match[1].toLowerCase()
      .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
      .replace(/<[^>]+>/g, '')
      .replace(/[^\p{L}\p{N}\p{M}_\- ]/gu, '')
      .replace(/ /g, '-');
    const count = occurrences.get(base) ?? 0;
    anchors.add(count === 0 ? base : `${base}-${count}`);
    occurrences.set(base, count + 1);
  }
  for (const match of prose(markdown).matchAll(/<a\s+[^>]*(?:id|name)=["']([^"']+)["'][^>]*>/gi)) {
    anchors.add(match[1]);
  }
  return anchors;
}

describe('documentation gates', () => {
  it('selects current usage docs and the runnable example for publication', () => {
    const requiredFiles = [
      ...currentUsage,
      'CHANGELOG.md',
      'docs/2026-08-28-experimental-tx-audit-removal-adr.md',
      'examples/quick-start/.env.example',
      'examples/quick-start/package.json',
      'examples/quick-start/tsconfig.json',
      'examples/quick-start/prisma.config.ts',
      'examples/quick-start/prisma/schema.prisma',
      'examples/quick-start/prisma/migrations/migration_lock.toml',
      'examples/quick-start/prisma/migrations/20260910000000_users/migration.sql',
      ...exampleFiles().filter((path) => path.endsWith('.ts')),
    ];
    expect(exampleFiles().some((path) => path.endsWith('/src/smoke.ts'))).toBe(true);
    for (const path of requiredFiles) {
      expect({ path, exists: existsSync(join(root, path)), published: selectedForPackage(path) })
        .toEqual({ path, exists: true, published: true });
    }
  });

  it.each(currentUsage)('%s identifies its source version and links release differences', (path) => {
    const document = read(path);
    expect(document).toMatch(/0\.6\.0/);
    const hasChangelogLink = linkTargets(document).some((target) =>
      resolve(dirname(join(root, path)), target.split('#')[0]) === join(root, 'CHANGELOG.md'));
    expect(hasChangelogLink).toBe(true);
  });

  it('separates the pinned registry adoption path from unreleased candidate APIs', () => {
    const example = JSON.parse(read('examples/quick-start/package.json')) as {
      dependencies: Record<string, string>;
      scripts: Record<string, string>;
    };
    const version = example.dependencies['@nestarc/audit-log'];
    expect(version).toBe('0.6.0');
    const readme = read('README.md');
    expect(readme).toContain(`npm install --save-exact @nestarc/audit-log@${version}`);
    const quickStart = readme.split('## Quick Start')[1].split('## Read and write')[0];
    expect(quickStart).not.toMatch(/npm (?:ci|pack)|npm run build/);
    for (const path of ['README.md', 'docs/adoption-guide.md', 'docs/agent-guide.md',
      'llms.txt', 'examples/quick-start/README.md']) {
      const doc = read(path);
      expect(doc).toMatch(/0\.7\.0 Unreleased/);
      expect(doc).not.toMatch(/npm (?:install|i|add)\s+[^\n]*@nestarc\/audit-log@0\.7\.0/);
    }
    for (const path of ['README.md', 'docs/agent-guide.md', 'llms.txt']) {
      expect(linkTargets(read(path)).some(target => target.endsWith('adoption-guide.md'))).toBe(true);
    }
    expect(example.scripts['smoke:manual']).toContain('dist/manual-smoke.js');
    const manual = read('examples/quick-start/src/manual-smoke.ts');
    expect(manual).not.toMatch(/createAuditedClient|createAuditExtension|withAuditTransaction/);
    const consumer = read('scripts/verify-docs-consumer.cjs');
    expect(consumer).toContain('package/examples/quick-start');
    expect(consumer).toContain("npm(['run', 'smoke:manual']");
    expect(consumer).toContain("npm(['run', 'smoke']");
    expect(consumer).toContain('--registry');
  });

  it('keeps local Markdown links and heading anchors valid in published documentation', () => {
    const documents = [...new Set([
      ...currentUsage,
      'CHANGELOG.md',
      ...packageFiles.filter((path) => path.endsWith('.md')),
      ...exampleFiles().filter((path) => path.endsWith('.md')),
    ])];
    const failures: string[] = [];
    for (const document of documents) {
      for (const target of linkTargets(read(document))) {
        // External references, including historical release links, are not network-tested.
        if (/^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(target)) continue;
        const [pathPart, fragment] = target.split('#', 2);
        const destination = pathPart
          ? resolve(dirname(join(root, document)), decodeURIComponent(pathPart.split('?')[0]))
          : join(root, document);
        const relativePath = relative(root, destination).split(sep).join('/');
        const context = `${document}: ${target}`;
        if (relativePath.startsWith('../') || !existsSync(destination)) {
          failures.push(`${context} (missing local target)`);
          continue;
        }
        if (!selectedForPackage(relativePath)) failures.push(`${context} (target omitted from package files)`);
        if (fragment && statSync(destination).isFile() && ['.md', '.txt'].includes(extname(destination))) {
          if (!headingAnchors(readFileSync(destination, 'utf8')).has(decodeURIComponent(fragment))) {
            failures.push(`${context} (missing heading anchor)`);
          }
        }
      }
    }
    expect(failures).toEqual([]);
  });

  it('routes current transaction guidance to the supported and explicit legacy modes', () => {
    const transactions = read('docs/transactions.md');
    const api = read('docs/api-reference.md');

    expect(transactions).toContain("consistency: 'atomic-required'");
    expect(transactions).toContain("consistency: 'best-effort'");
    expect(transactions).toContain('withAuditTransaction()');
    expect(transactions).toContain('AuditService.log(input, tx)');
    expect(transactions).toMatch(/experimentalTxAudit.*removed in v0\.5\.0/);
    expect(transactions).toMatch(/including `false`, fail\s+fast/);
    expect(api).not.toMatch(/^\| `experimentalTxAudit` \|/m);
    expect(transactions).not.toContain('Preview — choose the automatic tracking consistency explicitly');
  });

  it('records the v0.5.0 experimental transaction routing removal policy', () => {
    const adr = read('docs/2026-08-28-experimental-tx-audit-removal-adr.md');
    const changelog = read('CHANGELOG.md');

    expect(adr).toContain('Status: Accepted');
    expect(adr).toContain('Target release: `0.5.0`');
    expect(adr).toContain("consistency: 'atomic-required'");
    expect(adr).toContain("consistency: 'best-effort'");
    expect(adr).toContain('AuditService.log(input, tx)');
    expect(adr).toContain('runtime tombstone');
    expect(changelog).toContain(
      'Remove the deprecated `AuditExtensionOptions.experimentalTxAudit`',
    );
    expect(changelog).toContain('including `false`, fail fast');
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
    expect(ci).toContain('nest: 12');
    expect(ci).toContain('prisma: 5');
    expect(ci).toContain('prisma: 6');
    expect(ci).toContain('prisma: 7');
    expect(ci).toContain('npm run test:e2e');
  });

  it('checks the full peer graph for published and packed ecosystem packages', () => {
    const fixture = JSON.parse(
      read('fixtures/published-ecosystem/package.json'),
    ) as { scripts: Record<string, string> };
    const peerGraphCheck =
      'npm ls @nestarc/tenancy @nestarc/audit-log @nestarc/soft-delete --all';

    expect(fixture.scripts['verify:published']).toContain(peerGraphCheck);
    expect(fixture.scripts['verify:audit-log-candidate']).toContain(
      peerGraphCheck,
    );
    expect(fixture.scripts['verify:tenancy-candidate']).toContain(
      peerGraphCheck,
    );

    const packageJson = JSON.parse(read('package.json')) as {
      scripts: Record<string, string>;
    };
    expect(packageJson.scripts['test:e2e:ecosystem:candidate']).toContain(
      '--audit-log-candidate',
    );
    expect(
      packageJson.scripts['test:e2e:ecosystem:tenancy-candidate'],
    ).toContain('--tenancy-candidate');
  });

  it('keeps current release metadata consistent and preserves the published ecosystem tuple', () => {
    const packageJson = JSON.parse(read('package.json')) as { version: string };
    const packageLock = JSON.parse(read('package-lock.json')) as {
      version: string;
      packages: Record<string, { version?: string }>;
    };
    const fixture = JSON.parse(
      read('fixtures/published-ecosystem/package.json'),
    ) as { dependencies: Record<string, string> };
    const fixtureLock = JSON.parse(
      read('fixtures/published-ecosystem/package-lock.json'),
    ) as {
      packages: Record<
        string,
        { version?: string; dependencies?: Record<string, string> }
      >;
    };
    const readme = read('README.md');
    const changelog = read('CHANGELOG.md');

    expect(packageJson.version).toBe('0.6.0');
    expect(packageLock.version).toBe(packageJson.version);
    expect(packageLock.packages['']?.version).toBe(packageJson.version);
    expect(changelog).toContain(`## [${packageJson.version}] - 2026-09-10`);
    expect(read('docs/maintaining.md')).toContain(`nestarc-audit-log-${packageJson.version}.tgz`);
    expect(changelog).toContain('## [0.5.0] - 2026-08-28');
    expect(changelog).toContain('rejected thenables');
    expect(fixture.dependencies['@nestarc/tenancy']).toBe('0.15.0');
    expect(fixture.dependencies['@nestarc/audit-log']).toBe('0.5.0');
    expect(fixture.dependencies['@nestarc/soft-delete']).toBe('0.7.3');

    for (const packageName of [
      '@nestarc/tenancy',
      '@nestarc/audit-log',
      '@nestarc/soft-delete',
    ]) {
      const expected = fixture.dependencies[packageName];
      expect(fixtureLock.packages['']?.dependencies?.[packageName]).toBe(
        expected,
      );
      expect(
        fixtureLock.packages[`node_modules/${packageName}`]?.version,
      ).toBe(expected);
      expect(readme).toContain(`| \`${packageName}\` | \`${expected}\` |`);
    }
  });

  it('keeps NestJS 12 support aligned across peers, docs, and CI', () => {
    const packageJson = JSON.parse(read('package.json')) as {
      peerDependencies: Record<string, string>;
      devDependencies: Record<string, string>;
    };
    const readme = read('README.md');
    const ci = read('.github/workflows/ci.yml');

    expect(packageJson.peerDependencies['@nestjs/common']).toBe(
      '^10.0.0 || ^11.0.0 || ^12.0.1',
    );
    expect(packageJson.peerDependencies['@nestjs/core']).toBe(
      '^10.0.0 || ^11.0.0 || ^12.0.1',
    );
    expect(packageJson.devDependencies['@nestjs/core']).toBe('^12.0.1');
    expect(readme).toContain('NestJS 10, 11, or 12.0.1+');
    expect(ci).toContain('Verify NestJS 12 CommonJS runtime');
    expect(ci).toContain('Verify NestJS 12 packed peer install');
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

  it('documents v0.2.0 release notes in CHANGELOG', () => {
    const changelog = read('CHANGELOG.md');
    const v020Start = changelog.indexOf('## [0.2.0]');
    const v020End = changelog.indexOf('## [0.1.0]', v020Start);
    const v020 = changelog.slice(v020Start, v020End);

    expect(v020Start).toBeGreaterThanOrEqual(0);
    expect(v020End).toBeGreaterThan(v020Start);
    expect(v020).toContain('Tracking default changed');
    expect(v020).toContain('AuditService.query(): keyset cursor pagination');
    expect(v020).toContain('append-only default enforcement changed');
    expect(v020).toContain('AuditService.prune');
    expect(v020).toContain('experimentalTxAudit');
    expect(v020).toMatch(
      /they\s+do not establish transaction-atomic automatic auditing/,
    );
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
