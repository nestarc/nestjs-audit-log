'use strict';

// Offline evaluator for the predeclared 32-process controlled experiment.
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const T_CRITICAL = 1.894578605;
const METRICS = ['mean', 'p95', 'throughput'];
const CALIBRATION = { mean: [0.95, 1.05], p95: [0.925, 1.075], throughput: [0.95, 1.05] };
const LIMITS = { mean: 1.10, p95: 1.15, throughput: 0.90 };
const ENVIRONMENT_KEYS = ['node', 'platform', 'architecture', 'cpu', 'prisma', 'server', 'poolMaximum', 'idleTimeoutMillis'];
const sha256 = data => createHash('sha256').update(data).digest('hex');
const digest = (value, label) => assert.match(value, /^[a-f0-9]{64}$/, `${label} must be a SHA-256 digest`);
const positive = (value, label) => assert.ok(typeof value === 'number' && Number.isFinite(value) && value > 0, `${label} must be positive and finite`);
const timestamp = (value, label) => { assert.ok(typeof value === 'string' && Number.isFinite(Date.parse(value)), `${label} must be a timestamp`); return Date.parse(value); };

function close(actual, expected, label) {
  assert.ok(Number.isFinite(actual) && Math.abs(actual - expected) <= 1e-7 * Math.max(1, Math.abs(expected)), `${label} disagrees with raw evidence`);
}

function logRatioInterval(ratios) {
  assert.equal(ratios.length, 8, 'Exactly eight independent process ratios are required');
  ratios.forEach(value => positive(value, 'Ratio'));
  const logs = ratios.map(Math.log);
  const logMean = logs.reduce((sum, value) => sum + value, 0) / logs.length;
  const sampleVariance = logs.reduce((sum, value) => sum + (value - logMean) ** 2, 0) / (logs.length - 1);
  const sampleSD = Math.sqrt(sampleVariance);
  const standardError = sampleSD / Math.sqrt(logs.length);
  const margin = T_CRITICAL * standardError;
  const sorted = [...ratios].sort((a, b) => a - b);
  return { n: 8, degreesOfFreedom: 7, tCritical: T_CRITICAL, logRatios: logs, logMean,
    sampleVariance, sampleSD, standardError, logMargin: margin, geometricMean: Math.exp(logMean),
    lower: Math.exp(logMean - margin), upper: Math.exp(logMean + margin),
    median: (sorted[3] + sorted[4]) / 2, min: sorted[0], max: sorted[7], ratios: [...ratios],
    interpretation: 'Model-based two-sided 90% interval; either endpoint is also a one-sided 95% bound. The inferential target is the geometric mean of process ratios, not the median.' };
}

function validateProtocol(protocol) {
  assert.equal(protocol.schemaVersion, 1, 'Unsupported protocol schema');
  assert.equal(protocol.kind, 'controlled-performance-protocol', 'Wrong protocol kind');
  timestamp(protocol.createdAt, 'Protocol creation time');
  for (const [key, expected] of Object.entries({ primaryMode: 'interleaved', processesPerGroup: 8,
    iterations: 1000, warmup: 100, repeats: 1, chunkSize: 50 })) assert.equal(protocol[key], expected, `Protocol ${key} must remain predeclared`);
  assert.deepEqual(protocol.calibration, CALIBRATION, 'Calibration intervals must remain predeclared');
  assert.deepEqual(protocol.limits, LIMITS, 'Acceptance limits must remain predeclared');
  for (const [key, value] of Object.entries({ tCritical: T_CRITICAL, aaTwoSidedConfidence: .90,
    abOneSidedConfidence: .95, retainExistingMedianChecks: true, p99WarningRatio: 1.25 })) {
    assert.equal(protocol.statistics?.[key], value, `Declared statistics ${key} differs from evaluator`);
  }
  for (const role of ['baseline', 'same', 'candidate']) {
    const artifact = protocol.artifacts?.[role];
    assert.ok(artifact && path.isAbsolute(artifact.directory), `Missing absolute ${role} installation`);
    assert.match(artifact.integrity, /^sha512-[A-Za-z0-9+/=]+$/, `Missing ${role} artifact integrity`);
  }
  assert.equal(new Set(Object.values(protocol.artifacts).map(value => value.directory)).size, 3, 'Three independent package installations are required');
  assert.equal(protocol.artifacts.same.integrity, protocol.artifacts.baseline.integrity, 'A/A artifacts must be identical');
  assert.notEqual(protocol.artifacts.candidate.integrity, protocol.artifacts.baseline.integrity, 'A/B must use the frozen distinct candidate');
  for (const key of ENVIRONMENT_KEYS) assert.ok(protocol.environment?.[key] !== undefined, `Missing expected environment ${key}`);
  assert.equal(protocol.environment.poolMaximum, 4);
  assert.equal(protocol.environment.idleTimeoutMillis, 1000);
  for (const key of ['harnessSha256', 'comparatorSha256', 'sourceEvidenceSha256', 'distEvidenceSha256']) digest(protocol.sources?.[key], key);
  for (const key of ['sourceEvidencePath', 'distEvidencePath']) assert.ok(path.isAbsolute(protocol.sources?.[key] ?? ''), `Missing ${key}`);
  return protocol;
}

function validateIndex(protocol, index, protocolSha256) {
  assert.equal(index.schemaVersion, 1, 'Unsupported matrix index schema');
  digest(protocolSha256, 'Protocol digest');
  assert.equal(index.protocolSha256, protocolSha256, 'Matrix must bind the exact protocol file');
  assert.equal(index.harnessSha256, protocol.sources.harnessSha256, 'Matrix harness source differs from protocol');
  assert.deepEqual(index.sourceVerification, { source: 'passed', build: 'passed' }, 'Source and build verification must pass');
  assert.ok(Array.isArray(index.runs) && index.runs.length === 32, 'Complete 32-process matrix required');
  const ids = new Set(), paths = new Set(), cells = new Set();
  for (const run of index.runs) {
    assert.ok(typeof run.id === 'string' && run.id.length > 0 && !ids.has(run.id), 'Duplicate or missing process id'); ids.add(run.id);
    assert.ok(path.isAbsolute(run.reportPath) && !paths.has(run.reportPath), 'Duplicate or invalid report path'); paths.add(run.reportPath);
    for (const [key, options] of Object.entries({ comparison: ['aa', 'ab'], mode: ['sequential', 'interleaved'],
      orientation: ['normal', 'reversed'], loadOrder: ['left-first', 'right-first'], startSlot: ['left', 'right'] })) {
      assert.ok(options.includes(run[key]), `Invalid matrix ${key}`);
    }
    const cell = [run.comparison, run.mode, run.orientation, run.loadOrder, run.startSlot].join('/');
    assert.ok(!cells.has(cell), 'Duplicate factorial matrix cell'); cells.add(cell);
    assert.equal(run.status, 'passed', `Process ${run.id} is incomplete or failed`);
    assert.equal(run.processExitCode, 0, `Process ${run.id} did not exit successfully`);
    timestamp(run.processStartedAt, 'Controller process start');
    digest(run.reportSha256, 'Report digest');
  }
  // Bind the same balanced rotation that was declared before observations.
  const types = [['aa', 'sequential'], ['ab', 'sequential'], ['aa', 'interleaved'], ['ab', 'interleaved']];
  let position = 0, cell = 0;
  for (const orientation of ['normal', 'reversed']) for (const loadOrder of ['left-first', 'right-first']) for (const startSlot of ['left', 'right']) {
    const rotated = [...types.slice(cell % 4), ...types.slice(0, cell % 4)];
    for (const [comparison, mode] of rotated) {
      const run = index.runs[position++];
      assert.deepEqual([run.orientation, run.loadOrder, run.startSlot, run.comparison, run.mode],
        [orientation, loadOrder, startSlot, comparison, mode], 'Matrix order differs from the predeclared balanced rotation');
    }
    cell++;
  }
}

function expectedSchedule(mode, first, iterations) {
  const second = first === 'left' ? 'right' : 'left';
  if (mode === 'sequential') return [first, second].flatMap(slot => Array(iterations / 50).fill(slot));
  const result = [];
  for (let cycle = 0; cycle < iterations / 100; cycle++) {
    const [a, b] = cycle % 2 ? [second, first] : [first, second];
    result.push(a, b, b, a);
  }
  return result;
}

function normalizeSlots(run) {
  return { denominator: run.orientation === 'normal' ? 'left' : 'right',
    numerator: run.orientation === 'normal' ? 'right' : 'left',
    numeratorRole: run.comparison === 'aa' ? 'same' : 'candidate', denominatorRole: 'baseline' };
}

function slotStatistics(report, result, protocol) {
  const { iterations, warmup, chunkSize } = protocol;
  assert.equal(result.repeat, 1, 'Only one pair per independent process is permitted');
  assert.equal(result.evidence?.checked, true, 'Correctness evidence must pass');
  assert.equal(result.evidence.businessRows, iterations + warmup, 'Business row count must match');
  assert.equal(result.evidence.auditRows, iterations + warmup, 'Audit row count must match');
  assert.ok(Array.isArray(result.samples) && result.samples.length === iterations, 'Complete raw samples required');
  const chunks = report.chunks.filter(chunk => chunk.slot === result.slot && chunk.measured);
  assert.equal(chunks.length, iterations / chunkSize, 'Complete measured chunks required');
  const raw = [];
  let lastEnd = -Infinity;
  for (let i = 0; i < result.samples.length; i++) {
    const sample = result.samples[i];
    const chunk = chunks[Math.floor(i / chunkSize)];
    assert.equal(sample.index, i, 'Raw sample indices must be complete and ordered');
    positive(sample.latencyMs, 'Raw operation latency');
    assert.ok(sample.startedAtMs >= chunk.startedAtMs && sample.endedAtMs <= chunk.endedAtMs && sample.startedAtMs >= lastEnd,
      'Raw operation must be ordered and contained in its measured chunk');
    close(sample.latencyMs, sample.endedAtMs - sample.startedAtMs, 'Raw operation duration');
    lastEnd = sample.endedAtMs;
    raw.push(sample.latencyMs);
  }
  const elapsedMs = chunks.reduce((sum, chunk) => sum + chunk.elapsedMs, 0);
  const sorted = [...raw].sort((a, b) => a - b);
  const statistics = { samples: iterations, meanMs: raw.reduce((sum, value) => sum + value, 0) / iterations,
    p95Ms: sorted[Math.ceil(iterations * .95) - 1], p99Ms: sorted[Math.ceil(iterations * .99) - 1],
    measuredElapsedMs: elapsedMs, operationsPerSecond: iterations * 1000 / elapsedMs };
  for (const [key, value] of Object.entries(statistics)) close(result.statistics?.[key], value, `Reported ${key}`);
  return { slot: result.slot, statistics, latenciesMs: raw, measuredChunkDurationsMs: chunks.map(chunk => chunk.elapsedMs),
    evidence: result.evidence };
}

function processResult(protocol, run, report) {
  assert.equal(report.schemaVersion, 1, 'Unsupported report schema');
  assert.equal(report.kind, 'automatic-create-controlled-diagnostic', 'Wrong report kind/source');
  assert.equal(report.status, 'passed', 'Process correctness must pass');
  assert.equal(report.cleanup?.status, 'passed', 'Process cleanup must pass');
  assert.deepEqual(report.cleanup.failures, [], 'Cleanup must retain no failures');
  const started = timestamp(report.startedAt, 'Report start'), finished = timestamp(report.finishedAt, 'Report finish');
  assert.ok(started >= timestamp(protocol.createdAt, 'Protocol creation') && finished >= started, 'Measurements must follow the predeclared protocol');
  assert.ok(timestamp(run.processStartedAt, 'Controller start') <= started, 'Controller start must precede report start');
  const metadata = report.metadata;
  assert.ok(metadata && metadata.cpuProfileEnabled === false, 'Profiled or unlabelled runs cannot enter the gate');
  assert.ok(Number.isSafeInteger(metadata.pid) && metadata.pid > 0, 'Missing process PID');
  positive(metadata.timeOriginMs, 'Independent process time origin');
  assert.equal(metadata.harness?.sha256, protocol.sources.harnessSha256, 'Report harness source differs from protocol');
  assert.equal(metadata.comparison, run.comparison === 'aa' ? 'A/A' : 'A/B', 'Comparison metadata mismatch');
  for (const key of ['mode', 'loadOrder', 'startSlot']) assert.equal(metadata[key], run[key], `Report ${key} differs from matrix`);
  for (const key of ['iterations', 'warmup', 'repeats', 'chunkSize']) assert.equal(metadata[key], protocol[key], `Report ${key} differs from protocol`);
  for (const key of ENVIRONMENT_KEYS) assert.equal(metadata[key], protocol.environment[key], `Environment mismatch: ${key}`);
  assert.equal(metadata.principalTransactions, 2 * (protocol.iterations + protocol.warmup));
  assert.deepEqual(metadata.orderedLoads, run.loadOrder === 'left-first' ? ['left', 'right'] : ['right', 'left']);
  assert.deepEqual(metadata.warmupOrder, ['left', 'right']);
  assert.deepEqual(metadata.clientSetupOrder, ['left', 'right']);
  assert.equal(metadata.schemaInstallerSlot, 'left');
  assert.equal(metadata.auditDdl?.equal, true, 'Both installed packages must produce identical DDL');
  digest(metadata.auditDdl.sha256, 'Per-process DDL digest');
  const normalized = normalizeSlots(run);
  for (const [slot, role] of [[normalized.denominator, 'baseline'], [normalized.numerator, normalized.numeratorRole]]) {
    const actual = metadata.packages?.[slot], expected = protocol.artifacts[role];
    assert.equal(actual?.directory, expected.directory, `Wrong ${role} package directory/orientation`);
    assert.equal(actual.integrity, expected.integrity, `Wrong ${role} artifact integrity`);
    assert.equal(actual.version, '0.7.1', 'Unexpected installed package version');
  }
  assert.ok(Array.isArray(report.pairs) && report.pairs.length === 1, 'Exactly one pair per process required');
  const pair = report.pairs[0];
  assert.equal(pair.repeat, 1); assert.equal(pair.auditRowsBefore, 0);
  assert.equal(pair.auditRowsAfter, 2 * (protocol.iterations + protocol.warmup));
  assert.deepEqual(pair.warmupOrder, ['left', 'right']);
  const schedule = expectedSchedule(run.mode, run.startSlot, protocol.iterations);
  assert.deepEqual(pair.measuredSchedule, schedule, 'Wrong measured permutation');
  const warmupSchedule = ['left', 'right'].flatMap(slot => Array(protocol.warmup / protocol.chunkSize).fill(slot));
  assert.ok(Array.isArray(report.chunks) && report.chunks.length === warmupSchedule.length + schedule.length, 'Missing or extra chunks');
  const positions = { warmup: { left: 0, right: 0 }, measured: { left: protocol.warmup, right: protocol.warmup } };
  let previousEnd = -Infinity;
  for (let i = 0; i < report.chunks.length; i++) {
    const chunk = report.chunks[i], measured = i >= warmupSchedule.length;
    assert.equal(chunk.order, i + 1); assert.equal(chunk.repeat, 1); assert.equal(chunk.status, 'passed');
    assert.equal(chunk.measured, measured, 'Warmup/measurement placement differs');
    assert.equal(chunk.slot, measured ? schedule[i - warmupSchedule.length] : warmupSchedule[i], 'Chunk permutation differs');
    assert.equal(chunk.size, protocol.chunkSize, 'All modes must use identical 50-operation bookkeeping');
    const next = positions[measured ? 'measured' : 'warmup'];
    assert.equal(chunk.startIndex, next[chunk.slot], 'Chunk sample coverage differs'); next[chunk.slot] += chunk.size;
    positive(chunk.elapsedMs, 'Chunk duration');
    assert.ok(chunk.startedAtMs >= previousEnd, 'Measured chunks must not overlap');
    close(chunk.elapsedMs, chunk.endedAtMs - chunk.startedAtMs, 'Chunk elapsed time'); previousEnd = chunk.endedAtMs;
  }
  assert.ok(Array.isArray(pair.results) && pair.results.length === 2 && new Set(pair.results.map(value => value.slot)).size === 2,
    'Both unique slot results required');
  const slots = Object.fromEntries(pair.results.map(result => {
    assert.ok(['left', 'right'].includes(result.slot), 'Unknown result slot');
    return [result.slot, slotStatistics(report, result, protocol)];
  }));
  const numerator = slots[normalized.numerator], denominator = slots[normalized.denominator];
  const ratios = { mean: numerator.statistics.meanMs / denominator.statistics.meanMs,
    p95: numerator.statistics.p95Ms / denominator.statistics.p95Ms,
    p99: numerator.statistics.p99Ms / denominator.statistics.p99Ms,
    throughput: numerator.statistics.operationsPerSecond / denominator.statistics.operationsPerSecond };
  assert.match(report.schema, /^audit_control_[a-f0-9]{32}$/, 'Missing independent schema identity');
  return { ...run, startedAt: report.startedAt, finishedAt: report.finishedAt,
    process: { pid: metadata.pid, timeOriginMs: metadata.timeOriginMs, schema: report.schema },
    normalized, ratios, numerator, denominator };
}

function summarizeGroup(processes, comparison, mode) {
  const selected = processes.filter(run => run.comparison === comparison && run.mode === mode);
  const metrics = Object.fromEntries(METRICS.map(metric => [metric, logRatioInterval(selected.map(run => run.ratios[metric]))]));
  const checks = METRICS.map(metric => {
    const interval = metrics[metric];
    if (comparison === 'aa') {
      const [lower, upper] = CALIBRATION[metric];
      return { metric, rule: 'two-sided-90%-equivalence', lower, upper,
        passed: interval.lower >= lower && interval.upper <= upper };
    }
    const limit = LIMITS[metric], minimum = metric === 'throughput';
    return { metric, rule: 'one-sided-95%-noninferiority-and-median', limit,
      intervalPassed: minimum ? interval.lower >= limit : interval.upper <= limit,
      medianPassed: minimum ? interval.median >= limit : interval.median <= limit,
      passed: minimum ? interval.lower >= limit && interval.median >= limit : interval.upper <= limit && interval.median <= limit,
      regressionDemonstrated: minimum ? interval.upper < limit : interval.lower > limit };
  });
  const p99 = selected.map(run => run.ratios.p99).sort((a, b) => a - b);
  const p99Median = (p99[3] + p99[4]) / 2;
  return { comparison, mode, primary: mode === 'interleaved', processCount: selected.length,
    processIds: selected.map(run => run.id), metrics, checks, passed: checks.every(check => check.passed),
    warningOnly: { p99: { median: p99Median, min: p99[0], max: p99[7], threshold: 1.25, warning: p99Median > 1.25 } } };
}

function compareControlledPerformance(protocol, index, reports, protocolSha256) {
  validateProtocol(protocol); validateIndex(protocol, index, protocolSha256);
  assert.equal(reports.length, 32, 'Complete reports required');
  const processes = index.runs.map((run, i) => processResult(protocol, run, reports[i]));
  for (const key of ['identity', 'schema']) {
    const values = processes.map(run => key === 'identity' ? `${run.process.pid}/${run.process.timeOriginMs}` : run.process.schema);
    assert.equal(new Set(values).size, 32, 'Independent process/time-origin and schema identities are required');
  }
  for (let i = 1; i < processes.length; i++) assert.ok(Date.parse(processes[i].startedAt) >= Date.parse(processes[i - 1].finishedAt),
    'Matrix processes must execute sequentially without overlap');
  const groups = ['aa', 'ab'].flatMap(comparison => ['sequential', 'interleaved'].map(mode => summarizeGroup(processes, comparison, mode)));
  const calibration = groups.find(group => group.comparison === 'aa' && group.primary);
  const candidate = groups.find(group => group.comparison === 'ab' && group.primary);
  const decision = !calibration.passed ? 'invalid-calibration' : candidate.passed ? 'approved'
    : candidate.checks.some(check => check.regressionDemonstrated) ? 'regression-demonstrated' : 'insufficient-evidence';
  return { schemaVersion: 1, kind: 'controlled-performance-decision', generatedAt: new Date().toISOString(),
    status: decision === 'approved' ? 'passed' : 'failed', decision, correctness: 'passed', cleanup: 'passed',
    protocolSha256, protocol, primaryMode: 'interleaved', independentProcessCount: processes.length,
    calibrationPassed: calibration.passed, candidateNoninferiorityPassed: candidate.passed, groups, processes,
    interpretation: [
      'Only predeclared interleaved A/A calibration and A/B bounds determine this decision; sequential groups are diagnostic.',
      'Intervals model independent fresh-process log-ratios as approximately normal. They describe geometric mean process ratios; raw medians are an additional acceptance check.',
      'Chunks and individual operations are not independent inferential samples. A/A ratios are never subtracted from A/B.',
      'This approves only the controlled isolated automatic-create target. Historical full-sequence observations remain retained; other scenario approvals are outside this evaluator.',
      'This is a terminal fixed-sample decision. No optional extra repetitions or requirement to identify the original runtime event is implied.',
    ] };
}

function verifySources(protocol, root = ROOT) {
  const checks = {};
  for (const [key, file] of [['harnessSha256', 'benchmarks/automatic-create-controlled.cjs'],
    ['comparatorSha256', 'scripts/compare-controlled-performance.cjs']]) {
    const actual = sha256(fs.readFileSync(path.join(root, file)));
    assert.equal(actual, protocol.sources[key], `Current ${file} differs from frozen protocol source`); checks[key] = actual;
  }
  for (const [name, pathKey, hashKey] of [['source', 'sourceEvidencePath', 'sourceEvidenceSha256'],
    ['build', 'distEvidencePath', 'distEvidenceSha256']]) {
    const data = fs.readFileSync(protocol.sources[pathKey]);
    assert.equal(sha256(data), protocol.sources[hashKey], `Frozen ${name} evidence file changed`);
    const evidence = JSON.parse(data), files = name === 'source' ? evidence.sha256 : evidence;
    assert.ok(files && Object.keys(files).length > 0, `Missing frozen ${name} hashes`);
    for (const [file, expected] of Object.entries(files)) {
      digest(expected, `Frozen ${file}`);
      const resolved = path.resolve(root, file);
      assert.ok(resolved.startsWith(root + path.sep), 'Frozen source paths must stay inside the repository');
      assert.equal(sha256(fs.readFileSync(resolved)), expected, `Frozen ${name} file changed: ${file}`);
    }
    checks[name] = { status: 'passed', files: Object.keys(files).length, evidenceSha256: sha256(data) };
  }
  return checks;
}

function main(argv) {
  const flags = {};
  for (let i = 0; i < argv.length; i += 2) {
    assert.ok(['--protocol', '--index', '--output'].includes(argv[i]) && !flags[argv[i]] && argv[i + 1] && !argv[i + 1].startsWith('--'),
      'Usage: --protocol FILE --index FILE --output FILE (no duplicate arguments)');
    flags[argv[i]] = path.resolve(argv[i + 1]);
  }
  assert.equal(Object.keys(flags).length, 3, 'Protocol, index and output are required');
  assert.ok(!fs.existsSync(flags['--output']), 'Output must not overwrite existing evidence');
  assert.notEqual(flags['--output'], flags['--protocol']); assert.notEqual(flags['--output'], flags['--index']);
  const protocolData = fs.readFileSync(flags['--protocol']), indexData = fs.readFileSync(flags['--index']);
  const protocol = validateProtocol(JSON.parse(protocolData)), index = JSON.parse(indexData);
  const protocolHash = sha256(protocolData);
  validateIndex(protocol, index, protocolHash);
  const sourceChecks = verifySources(protocol);
  const reports = index.runs.map(run => {
    assert.notEqual(flags['--output'], path.resolve(run.reportPath), 'Output cannot replace raw report');
    const data = fs.readFileSync(run.reportPath);
    assert.equal(sha256(data), run.reportSha256, `Raw report changed: ${run.id}`);
    return JSON.parse(data);
  });
  const decision = compareControlledPerformance(protocol, index, reports, protocolHash);
  decision.sourceChecks = sourceChecks;
  decision.indexSha256 = sha256(indexData);
  fs.mkdirSync(path.dirname(flags['--output']), { recursive: true });
  fs.writeFileSync(flags['--output'], `${JSON.stringify(decision, null, 2)}\n`, { flag: 'wx' });
  console.log(`Controlled automatic-create: ${decision.decision}; ${decision.independentProcessCount} independent processes; primary interleaved`);
  if (decision.status !== 'passed') process.exitCode = 1;
}

module.exports = { logRatioInterval, normalizeSlots, expectedSchedule, validateProtocol, compareControlledPerformance, verifySources, sha256 };
if (require.main === module) {
  try { main(process.argv.slice(2)); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
