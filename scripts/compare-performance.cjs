'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const limits = {
  maxMeanRatio: ['meanRatio', 'max'],
  maxP95Ratio: ['p95Ratio', 'max'],
  maxP99Ratio: ['p99Ratio', 'max'],
  minThroughputRatio: ['throughputRatio', 'min'],
};

function object(value, label) {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value), `${label} must be an object`);
}

function validateBudget(budget) {
  object(budget, 'Budget');
  const allowed = ['schemaVersion', 'baselineVersion', 'calibration', 'minRepeats', 'minIterations', 'scenarios'];
  assert.ok(Object.keys(budget).every(key => allowed.includes(key)), 'Unknown budget field');
  assert.equal(budget.schemaVersion, 1, 'Budget schemaVersion must be 1');
  assert.match(budget.baselineVersion, /^\d+\.\d+\.\d+(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?$/,
    'Budget baselineVersion must be an exact version');
  assert.ok(typeof budget.calibration === 'string' && budget.calibration.trim(),
    'Budget calibration must identify the environment and calibration evidence');
  assert.ok(Number.isSafeInteger(budget.minRepeats) && budget.minRepeats >= 2, 'Budget minRepeats must be at least 2');
  assert.ok(Number.isSafeInteger(budget.minIterations) && budget.minIterations >= 100,
    'Budget minIterations must be at least 100');
  object(budget.scenarios, 'Budget scenarios');
  assert.ok(Object.keys(budget.scenarios).length > 0, 'Budget must select at least one scenario');
  for (const [scenario, rules] of Object.entries(budget.scenarios)) {
    assert.match(scenario, /^[^/]+\/[^/]+\/[^/]+\/[1-9]\d*$/, 'Use workload/operation/payload/concurrency scenario keys');
    object(rules, `Budget ${scenario}`);
    assert.ok(Object.keys(rules).length > 0, `Budget ${scenario} must contain a ratio limit`);
    for (const [key, value] of Object.entries(rules)) {
      assert.ok(Object.hasOwn(limits, key), `Unknown ratio limit ${key}`);
      assert.ok(typeof value === 'number' && Number.isFinite(value) && value > 0, `${key} must be a positive finite ratio`);
    }
  }
  return budget;
}

function readBudget(filename) {
  return validateBudget(JSON.parse(fs.readFileSync(filename, 'utf8')));
}

function distribution(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return {
    median: sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2,
    min: sorted[0], max: sorted[sorted.length - 1],
  };
}

function blockStatistics(block) {
  assert.ok(block.evidence?.checked === true, 'Every compared block must have correctness evidence');
  assert.ok(Number.isSafeInteger(block.iterations) && block.iterations > 0, 'Invalid block iterations');
  assert.equal(block.samples, block.iterations, 'Block sample count must match measured iterations');
  assert.ok(Array.isArray(block.latenciesMs) && block.latenciesMs.length === block.samples, 'Raw samples must be retained');
  assert.ok(block.latenciesMs.every(value => typeof value === 'number' && Number.isFinite(value) && value >= 0), 'Invalid raw latency');
  assert.ok(Number.isFinite(block.batchElapsedMs) && block.batchElapsedMs > 0, 'Invalid measured batch duration');
  const sorted = [...block.latenciesMs].sort((a, b) => a - b);
  const stats = {
    meanMs: sorted.reduce((sum, value) => sum + value, 0) / sorted.length,
    p95Ms: sorted[Math.ceil(sorted.length * 0.95) - 1],
    p99Ms: sorted[Math.ceil(sorted.length * 0.99) - 1],
    operationsPerSecond: sorted.length * 1000 / block.batchElapsedMs,
  };
  assert.ok(Object.values(stats).every(value => Number.isFinite(value) && value > 0), 'Compared statistics must be positive and finite');
  return stats;
}

function comparePerformance(report, budget) {
  assert.equal(report.schemaVersion, 1, 'Unsupported report schema');
  assert.equal(report.kind, 'postgresql-public-package-regression', 'Expected a PostgreSQL paired package report');
  assert.equal(report.status, 'passed', 'Benchmark correctness must pass before evaluating performance');
  assert.equal(report.cleanup?.status, 'passed', 'Benchmark cleanup must pass before evaluating performance');
  assert.ok(Array.isArray(report.results), 'Missing measured blocks');
  assert.ok(Number.isSafeInteger(report.metadata?.repeats) && report.metadata.repeats >= 2, 'Missing report repeat count');
  assert.ok(typeof report.metadata?.packages?.baseline?.version === 'string', 'Missing baseline version');
  if (budget) {
    validateBudget(budget);
    assert.equal(budget.baselineVersion, report.metadata.packages.baseline.version,
      'Budget baselineVersion does not match the measured registry baseline');
  }
  const groups = new Map();
  for (const block of report.results) {
    if (block.variant === 'control') continue;
    assert.ok(['baseline', 'candidate'].includes(block.variant), 'Unknown benchmark variant');
    assert.ok(Number.isSafeInteger(block.repeat) && block.repeat >= 1 && block.repeat <= report.metadata.repeats, 'Invalid repeat index');
    assert.ok(Number.isSafeInteger(block.concurrency) && block.concurrency > 0, 'Invalid block concurrency');
    for (const key of ['workload', 'operation', 'payload']) assert.ok(typeof block[key] === 'string' && !block[key].includes('/'), `Invalid ${key}`);
    const scenario = [block.workload, block.operation, block.payload, block.concurrency].join('/');
    if (!groups.has(scenario)) groups.set(scenario, new Map());
    const blocks = groups.get(scenario);
    const key = `${block.repeat}/${block.variant}`;
    assert.ok(!blocks.has(key), `Duplicate measured block: ${scenario}/${key}`);
    blocks.set(key, { block, stats: blockStatistics(block) });
  }
  assert.ok(groups.size > 0, 'Report has no paired scenarios');
  const scenarios = [...groups].map(([scenario, blocks]) => {
    const pairs = [];
    for (let repeat = 1; repeat <= report.metadata.repeats; repeat += 1) {
      const baseline = blocks.get(`${repeat}/baseline`);
      const candidate = blocks.get(`${repeat}/candidate`);
      assert.ok(baseline && candidate, `Missing paired block: ${scenario}/${repeat}`);
      for (const key of ['iterations', 'warmup', 'metadataUtf8Bytes', 'metadataUtf16CodeUnits']) {
        assert.equal(candidate.block[key], baseline.block[key], `Mismatched ${key}: ${scenario}/${repeat}`);
      }
      pairs.push({
        repeat, iterations: candidate.block.iterations,
        meanRatio: candidate.stats.meanMs / baseline.stats.meanMs,
        p95Ratio: candidate.stats.p95Ms / baseline.stats.p95Ms,
        p99Ratio: candidate.stats.p99Ms / baseline.stats.p99Ms,
        throughputRatio: candidate.stats.operationsPerSecond / baseline.stats.operationsPerSecond,
      });
    }
    const ratios = Object.fromEntries(['meanRatio', 'p95Ratio', 'p99Ratio', 'throughputRatio']
      .map(key => [key, distribution(pairs.map(pair => pair[key]))]));
    return { scenario, repeats: pairs.length, minIterations: Math.min(...pairs.map(pair => pair.iterations)), ratios, pairs };
  });
  const checks = [];
  if (budget) for (const [scenario, rules] of Object.entries(budget.scenarios)) {
    const measured = scenarios.find(item => item.scenario === scenario);
    if (!measured || measured.repeats < budget.minRepeats || measured.minIterations < budget.minIterations) {
      checks.push({ scenario, status: 'insufficient-evidence' });
      continue;
    }
    for (const [rule, threshold] of Object.entries(rules)) {
      const [metric, direction] = limits[rule];
      const actual = measured.ratios[metric].median;
      checks.push({ scenario, rule, actual, threshold,
        status: (direction === 'max' ? actual <= threshold : actual >= threshold) ? 'passed' : 'failed' });
    }
  }
  return {
    schemaVersion: 1, correctness: 'passed', cleanup: 'passed',
    status: !budget ? 'advisory' : checks.every(check => check.status === 'passed') ? 'passed' : 'failed',
    metadata: report.metadata,
    budget: budget ?? null,
    budgetedScenarios: budget ? Object.keys(budget.scenarios).length : 0,
    scenarios, checks,
    interpretation: 'Ratios compare candidate with paired baseline blocks. Medians and ranges describe this run, not statistical significance or a production SLA. A budget applies only to its named scenarios and must be calibrated on the execution environment.',
  };
}

function main(argv) {
  const [input, ...args] = argv;
  assert.ok(input && !input.startsWith('--'), 'Usage: node scripts/compare-performance.cjs REPORT [--budget BUDGET] [--output OUTPUT]');
  const flags = {};
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index];
    assert.ok(['--budget', '--output'].includes(key) && !flags[key] && args[index + 1] && !args[index + 1].startsWith('--'), 'Invalid or duplicate argument');
    flags[key] = args[index + 1];
  }
  if (flags['--output']) {
    assert.notEqual(path.resolve(flags['--output']), path.resolve(input), 'Output must not overwrite the raw report');
    if (flags['--budget']) assert.notEqual(path.resolve(flags['--output']), path.resolve(flags['--budget']), 'Output must not overwrite the budget');
    if (fs.existsSync(flags['--output'])) {
      const destination = fs.statSync(flags['--output']);
      for (const source of [input, flags['--budget']].filter(Boolean)) {
        const original = fs.statSync(source);
        assert.ok(destination.dev !== original.dev || destination.ino !== original.ino,
          'Output must not overwrite a source through a symbolic or hard link');
      }
    }
  }
  const summary = comparePerformance(JSON.parse(fs.readFileSync(input, 'utf8')), flags['--budget'] ? readBudget(flags['--budget']) : undefined);
  if (flags['--output']) {
    fs.mkdirSync(path.dirname(path.resolve(flags['--output'])), { recursive: true });
    fs.writeFileSync(flags['--output'], `${JSON.stringify(summary, null, 2)}\n`);
  }
  console.log(`Performance ${summary.status}; correctness passed; ${summary.scenarios.length} scenarios, ${summary.budgetedScenarios} budgeted`);
  for (const item of summary.scenarios) {
    console.log(`${item.scenario}: mean ${item.ratios.meanRatio.median.toFixed(3)}x, P95 ${item.ratios.p95Ratio.median.toFixed(3)}x, P99 ${item.ratios.p99Ratio.median.toFixed(3)}x; ${item.repeats} paired repeats`);
  }
  for (const check of summary.checks.filter(item => item.status !== 'passed')) console.error(JSON.stringify(check));
  if (summary.status === 'failed') process.exitCode = 1;
}

module.exports = { comparePerformance, validateBudget, readBudget };
if (require.main === module) {
  try { main(process.argv.slice(2)); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
