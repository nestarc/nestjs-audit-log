import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { safeLoad } = require('js-yaml') as { safeLoad(source: string): Workflow };
const root = join(__dirname, '..');

interface Step {
  name?: string;
  run?: string;
  uses?: string;
  if?: string;
  'continue-on-error'?: boolean;
}

interface Workflow {
  on: Record<string, unknown>;
  permissions?: Record<string, string>;
  jobs: Record<string, {
    needs?: string[];
    uses?: string;
    steps?: Step[];
    'continue-on-error'?: boolean;
  }>;
}

function workflow(name: string): Workflow {
  return safeLoad(readFileSync(join(root, '.github/workflows', name), 'utf8'));
}

const compatibility = workflow('ecosystem-compatibility.yml');
const steps = compatibility.jobs.compatibility.steps!;

function command(name: string): string {
  const run = steps.find(step => step.name === name)?.run;
  if (!run) throw new Error(`Missing workflow command: ${name}`);
  return run;
}

describe('independent release and optional compatibility workflows', () => {
  it('keeps standalone CI and mandatory release verification without the ecosystem dependency', () => {
    const ci = workflow('ci.yml');
    const release = workflow('release.yml');
    expect(Object.keys(ci.jobs).sort()).toEqual(['peer-matrix', 'test']);
    expect(Object.keys(release.jobs).sort()).toEqual(['mssql-release-gate', 'release']);
    expect(release.jobs.release.needs).toEqual(['mssql-release-gate']);
    expect(release.jobs['mssql-release-gate'].uses).toBe('./.github/workflows/mssql-preflight.yml');
    const releaseSteps = release.jobs.release.steps!;
    const publishIndex = releaseSteps.findIndex(step => step.run?.startsWith('npm publish'));
    expect(publishIndex).toBeGreaterThan(0);
    for (const required of ['npm run lint', 'npm run typecheck', 'npm run build',
      'npm run test:cov -- --runInBand', 'npm run test:e2e', 'npm run test:docs:consumer',
      'npm pack --dry-run']) {
      const index = releaseSteps.findIndex(step => step.run === required);
      expect(index).toBeGreaterThanOrEqual(0);
      expect(index).toBeLessThan(publishIndex);
      expect(releaseSteps[index].if).toBeUndefined();
      expect(releaseSteps[index]['continue-on-error']).toBeUndefined();
    }
    expect(release.jobs.release['continue-on-error']).toBeUndefined();
  });

  it('runs compatibility only on explicit dispatch and preserves visible failures', () => {
    expect(Object.keys(compatibility.on)).toEqual(['workflow_dispatch']);
    expect(compatibility.permissions).toEqual({ contents: 'read' });
    expect(compatibility.jobs.compatibility.needs).toBeUndefined();
    expect(compatibility.jobs.compatibility['continue-on-error']).toBeUndefined();
    for (const step of steps) expect(step['continue-on-error']).toBeUndefined();
    expect(steps.find(step => step.uses?.startsWith('actions/upload-artifact@'))?.if).toBe('always()');
  });

  it.each([
    ['published', '', true],
    ['audit-log-candidate', '0.7.4', true],
    ['audit-log-candidate', '', false],
    ['published', '0.7.4', false],
    ['audit-log-candidate', '^0.7.4', false],
    ['tenancy-candidate', '', false],
  ])('validates dispatch inputs mode=%s companion=%s before installation', (mode, version, accepted) => {
    const result = spawnSync('bash', ['-e', '-o', 'pipefail', '-c', command('Validate compatibility inputs')], {
      cwd: root,
      env: { ...process.env, ECOSYSTEM_CHECK_MODE: String(mode), SOFT_DELETE_VERSION: String(version) },
      encoding: 'utf8',
    });
    expect(result.error).toBeUndefined();
    expect(result.status === 0).toBe(accepted);
  });

  it.each([
    ['Test exact published tuple', ['run', 'test:e2e:ecosystem']],
    ['Test packed audit-log candidate with the selected companion',
      ['run', 'test:e2e:ecosystem:candidate', '--', '--soft-delete-version', '0.9.7']],
  ])('passes exact arguments and propagates failure through the evidence pipe: %s', (name, expected) => {
    const directory = mkdtempSync(join(tmpdir(), 'audit-compatibility-workflow-'));
    try {
      const script = `npm() { printf '%s\\n' "$@" > "$RUNNER_TEMP/arguments"; return "$FAKE_NPM_EXIT"; }\n${command(name)}`;
      for (const exitCode of ['0', '42']) {
        const result = spawnSync('bash', ['-e', '-o', 'pipefail', '-c', script], {
          cwd: root,
          env: { ...process.env, RUNNER_TEMP: directory, SOFT_DELETE_VERSION: '0.9.7', FAKE_NPM_EXIT: exitCode },
          encoding: 'utf8',
        });
        expect(result.error).toBeUndefined();
        expect(result.status).toBe(Number(exitCode));
        expect(readFileSync(join(directory, 'arguments'), 'utf8').trim().split('\n')).toEqual(expected);
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
