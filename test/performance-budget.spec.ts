import { linkSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const { comparePerformance, validateBudget } = require('../scripts/compare-performance.cjs') as {
  comparePerformance(report: any, budget?: any): any;
  validateBudget(budget: any): any;
};

const scenario = 'manual/create/small/1';

function report(ratio = 1) {
  const blocks = [1, 2, 3, 4].flatMap(repeat => ['baseline', 'candidate'].map(variant => {
    const latency = variant === 'baseline' ? 2 : 2 * ratio;
    return {
      repeat, variant, workload: 'manual', operation: 'create', payload: 'small', concurrency: 1,
      warmup: 10, iterations: 100, samples: 100,
      metadataUtf8Bytes: 200, metadataUtf16CodeUnits: 100,
      latenciesMs: Array<number>(100).fill(latency), batchElapsedMs: latency * 100,
      // The evaluator must use samples, not trust precomputed summary numbers.
      meanMs: 999, p95Ms: 999, p99Ms: 999,
      evidence: { checked: true },
    };
  }));
  return {
    schemaVersion: 1, kind: 'postgresql-public-package-regression', status: 'passed',
    cleanup: { status: 'passed' },
    metadata: { repeats: 4, packages: { baseline: { version: '0.7.1' } } },
    results: blocks,
  };
}

function budget() {
  return {
    schemaVersion: 1, baselineVersion: '0.7.1', calibration: 'Synthetic unit-test calibration only',
    minRepeats: 4, minIterations: 100,
    scenarios: { [scenario]: { maxMeanRatio: 1.2, maxP95Ratio: 1.3, maxP99Ratio: 1.4, minThroughputRatio: 0.8 } },
  };
}

describe('performance budget evaluation', () => {
  it('is advisory without a budget even when timings regress', () => {
    const result = comparePerformance(report(2));
    expect(result.status).toBe('advisory');
    expect(result.budgetedScenarios).toBe(0);
    expect(result.scenarios[0].ratios.p99Ratio).toEqual({ median: 2, min: 2, max: 2 });
    expect(result.scenarios[0].ratios.throughputRatio.median).toBe(0.5);
  });

  it('evaluates only an explicitly calibrated budget against raw paired samples', () => {
    const passing = comparePerformance(report(1.1), budget());
    expect(passing.status).toBe('passed');
    expect(passing.checks).toHaveLength(4);
    expect(passing.scenarios[0].ratios.meanRatio.median).toBeCloseTo(1.1);
    const failing = comparePerformance(report(1.5), budget());
    expect(failing.status).toBe('failed');
    expect(failing.checks.every((check: any) => check.status === 'failed')).toBe(true);
  });

  it('reports insufficient evidence for missing, undersampled or under-repeated scenarios', () => {
    for (const configured of [
      { ...budget(), minRepeats: 5 },
      { ...budget(), minIterations: 500 },
      { ...budget(), scenarios: { 'manual/create/64k/4': { maxP95Ratio: 1.2 } } },
    ]) {
      const result = comparePerformance(report(), configured);
      expect(result.status).toBe('failed');
      expect(result.checks[0].status).toBe('insufficient-evidence');
    }
  });

  it('does not evaluate a failed correctness or cleanup run', () => {
    expect(() => comparePerformance({ ...report(), status: 'failed' }, budget())).toThrow('correctness');
    expect(() => comparePerformance({ ...report(), cleanup: { status: 'failed' } })).toThrow('cleanup');
  });

  it('rejects duplicate or missing paired blocks and mismatched workloads', () => {
    const duplicate = report();
    duplicate.results.push(duplicate.results[0]);
    expect(() => comparePerformance(duplicate)).toThrow('Duplicate');
    const missing = report();
    missing.results.pop();
    expect(() => comparePerformance(missing)).toThrow('Missing paired');
    const differentPayload = report();
    differentPayload.results[1].metadataUtf8Bytes += 1;
    expect(() => comparePerformance(differentPayload)).toThrow('Mismatched metadataUtf8Bytes');
  });

  it('rejects incomplete or nonfinite raw evidence', () => {
    const missing = report();
    missing.results[0].latenciesMs.pop();
    expect(() => comparePerformance(missing)).toThrow('Raw samples');
    const nonfinite = report();
    nonfinite.results[0].latenciesMs[0] = Number.NaN;
    expect(() => comparePerformance(nonfinite)).toThrow('Invalid raw latency');
    const unchecked = report();
    unchecked.results[0].evidence.checked = false;
    expect(() => comparePerformance(unchecked)).toThrow('correctness evidence');
  });

  it('rejects ambiguous or accidentally misconfigured budgets', () => {
    for (const configured of [
      { ...budget(), calibration: '' },
      { ...budget(), baselineVersion: 'latest' },
      { ...budget(), minRepeats: 1 },
      { ...budget(), minIterations: 0 },
      { ...budget(), scenarios: {} },
      { ...budget(), scenarios: { [scenario]: { maxP95Ration: 1.2 } } },
      { ...budget(), scenarios: { [scenario]: { maxP95Ratio: Number.NaN } } },
    ]) expect(() => validateBudget(configured)).toThrow();
    expect(() => comparePerformance(report(), { ...budget(), baselineVersion: '0.7.0' })).toThrow('baselineVersion');
  });

  it('preserves the range of paired ratios instead of hiding a slow repeat', () => {
    const measured = report();
    measured.results[7].latenciesMs.fill(20);
    measured.results[7].batchElapsedMs = 2000;
    const result = comparePerformance(measured);
    expect(result.scenarios[0].ratios.p95Ratio).toEqual({ median: 1, min: 1, max: 10 });
    expect(result.scenarios[0].pairs).toHaveLength(4);
  });

  it('writes a failed budget summary without overwriting the source report', () => {
    const directory = mkdtempSync(join(tmpdir(), 'audit-performance-test-'));
    try {
      const input = join(directory, 'report.json');
      const config = join(directory, 'budget.json');
      const output = join(directory, 'summary.json');
      const raw = JSON.stringify(report(2));
      writeFileSync(input, raw);
      writeFileSync(config, JSON.stringify(budget()));
      const script = resolve(__dirname, '../scripts/compare-performance.cjs');
      const result = spawnSync(process.execPath, [script, input, '--budget', config, '--output', output], { encoding: 'utf8' });
      expect(result.status).toBe(1);
      expect(JSON.parse(readFileSync(output, 'utf8')).status).toBe('failed');
      expect(readFileSync(input, 'utf8')).toBe(raw);
      const overwrite = spawnSync(process.execPath, [script, input, '--output', input], { encoding: 'utf8' });
      expect(overwrite.status).toBe(1);
      expect(overwrite.stderr).toContain('must not overwrite');
      expect(readFileSync(input, 'utf8')).toBe(raw);
      const alias = join(directory, 'report-alias.json');
      linkSync(input, alias);
      const overwriteAlias = spawnSync(process.execPath, [script, input, '--output', alias], { encoding: 'utf8' });
      expect(overwriteAlias.status).toBe(1);
      expect(overwriteAlias.stderr).toContain('must not overwrite');
      expect(readFileSync(input, 'utf8')).toBe(raw);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
