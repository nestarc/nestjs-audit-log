import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { compareControlledPerformance, logRatioInterval, expectedSchedule, verifySources, sha256 } =
  require('../scripts/compare-controlled-performance.cjs') as Record<string, (...args: any[]) => any>;

const hash = 'a'.repeat(64);

function fixture(abRatio = 1.02, aaRatio = 1) {
  const protocol: any = {
    schemaVersion: 1, kind: 'controlled-performance-protocol', createdAt: '2026-01-01T00:00:00.000Z',
    primaryMode: 'interleaved', processesPerGroup: 8, iterations: 1000, warmup: 100, repeats: 1, chunkSize: 50,
    artifacts: { baseline: { directory: '/packages/baseline', integrity: 'sha512-YQ==' },
      same: { directory: '/packages/same', integrity: 'sha512-YQ==' },
      candidate: { directory: '/packages/candidate', integrity: 'sha512-Yg==' } },
    environment: { node: 'v24.22.1', platform: 'darwin', architecture: 'arm64', cpu: 'test-cpu',
      prisma: '7.9.1', server: 'test-postgresql', poolMaximum: 4, idleTimeoutMillis: 1000 },
    sources: { harnessSha256: hash, comparatorSha256: hash, sourceEvidenceSha256: hash, distEvidenceSha256: hash,
      sourceEvidencePath: '/evidence/source.json', distEvidencePath: '/evidence/dist.json' },
    calibration: { mean: [.95, 1.05], p95: [.925, 1.075], throughput: [.95, 1.05] },
    limits: { mean: 1.10, p95: 1.15, throughput: .90 },
    statistics: { tCritical: 1.894578605, aaTwoSidedConfidence: .90, abOneSidedConfidence: .95,
      retainExistingMedianChecks: true, p99WarningRatio: 1.25 },
  };
  const runs: any[] = [], reports: any[] = [];
  let cell = 0;
  for (const orientation of ['normal', 'reversed']) for (const loadOrder of ['left-first', 'right-first']) {
    for (const startSlot of ['left', 'right']) {
      const types = [['aa', 'sequential'], ['ab', 'sequential'], ['aa', 'interleaved'], ['ab', 'interleaved']];
      const rotated = [...types.slice(cell % 4), ...types.slice(0, cell % 4)];
      for (const [comparison, mode] of rotated) {
      const id = runs.length;
      const startMs = Date.parse(protocol.createdAt) + (id + 1) * 10000;
      const run = { id: `run-${id}`, comparison, mode, orientation, loadOrder, startSlot,
        reportPath: `/reports/${id}.json`, reportSha256: hash, status: 'passed', processExitCode: 0,
        processStartedAt: new Date(startMs).toISOString() };
      runs.push(run);
      const numeratorSlot = orientation === 'normal' ? 'right' : 'left';
      const targetRole = comparison === 'aa' ? 'same' : 'candidate';
      const role = (slot: string) => slot === numeratorSlot ? targetRole : 'baseline';
      const latency = (slot: string) => slot === numeratorSlot ? 2 * (comparison === 'aa' ? aaRatio : abRatio) : 2;
      const samples: any = { left: [], right: [] };
      const chunks: any[] = [];
      let clock = 100;
      const addChunk = (slot: string, startIndex: number, measured: boolean) => {
        const startedAtMs = clock;
        for (let i = 0; i < 50; i++) {
          const began = clock; clock += latency(slot);
          if (measured) samples[slot].push({ index: startIndex - 100 + i, startedAtMs: began, endedAtMs: clock, latencyMs: latency(slot) });
        }
        clock += .5;
        chunks.push({ order: chunks.length + 1, repeat: 1, slot, measured, startIndex, size: 50,
          startedAtMs, endedAtMs: clock, elapsedMs: clock - startedAtMs, status: 'passed' });
      };
      for (const slot of ['left', 'right']) for (const index of [0, 50]) addChunk(slot, index, false);
      const schedule = expectedSchedule(mode, startSlot, 1000);
      const positions: any = { left: 100, right: 100 };
      for (const slot of schedule) { addChunk(slot, positions[slot], true); positions[slot] += 50; }
      const results = ['left', 'right'].map((slot, slotIndex) => {
        const elapsed = chunks.filter(chunk => chunk.slot === slot && chunk.measured).reduce((sum, chunk) => sum + chunk.elapsedMs, 0);
        return { slot, repeat: 1, samples: samples[slot],
          statistics: { samples: 1000, meanMs: latency(slot), p95Ms: latency(slot), p99Ms: latency(slot),
            measuredElapsedMs: elapsed, operationsPerSecond: 1000000 / elapsed },
          evidence: { checked: true, businessRows: 1100, auditRows: 1100, cumulativeAuditRows: 1100 * (slotIndex + 1) } };
      });
      reports.push({ schemaVersion: 1, kind: 'automatic-create-controlled-diagnostic', diagnosticOnly: true,
        status: 'passed', startedAt: new Date(startMs + 1).toISOString(), finishedAt: new Date(startMs + 9000).toISOString(),
        schema: `audit_control_${id.toString(16).padStart(32, '0')}`, cleanup: { status: 'passed', failures: [] },
        metadata: { mode, loadOrder, startSlot, orderedLoads: loadOrder === 'left-first' ? ['left', 'right'] : ['right', 'left'],
          warmupOrder: ['left', 'right'], clientSetupOrder: ['left', 'right'], schemaInstallerSlot: 'left',
          iterations: 1000, warmup: 100, repeats: 1, principalTransactions: 2200, chunkSize: 50,
          ...protocol.environment, pid: 900 + id, timeOriginMs: startMs - 1, harness: { sha256: hash },
          comparison: comparison === 'aa' ? 'A/A' : 'A/B', cpuProfileEnabled: false, auditDdl: { equal: true, sha256: hash },
          packages: Object.fromEntries(['left', 'right'].map(slot => [slot, { ...protocol.artifacts[role(slot)], version: '0.7.1' }])) },
        pairs: [{ repeat: 1, auditRowsBefore: 0, auditRowsAfter: 2200, warmupOrder: ['left', 'right'], measuredSchedule: schedule, results }], chunks });
      }
      cell++;
    }
  }
  const protocolHash = sha256(JSON.stringify(protocol));
  const index = { schemaVersion: 1, protocolSha256: protocolHash, harnessSha256: hash,
    sourceVerification: { source: 'passed', build: 'passed' }, runs };
  return { protocol, index, reports, protocolHash };
}

const evaluate = (input: ReturnType<typeof fixture>) => compareControlledPerformance(input.protocol, input.index, input.reports, input.protocolHash);

describe('controlled performance evaluator', () => {
  it('uses eight process log ratios, sample variance with seven degrees of freedom, and the declared t bound', () => {
    const logs = [-.07, -.05, -.03, -.01, .01, .03, .05, .07];
    const result = logRatioInterval(logs.map(Math.exp));
    expect(result.n).toBe(8); expect(result.degreesOfFreedom).toBe(7);
    expect(result.sampleVariance).toBeCloseTo(.0024, 12);
    expect(result.standardError).toBeCloseTo(Math.sqrt(.0024 / 8), 12);
    expect(result.upper).toBeCloseTo(Math.exp(1.894578605 * Math.sqrt(.0024 / 8)), 12);
    expect(result.lower).toBeCloseTo(1 / result.upper, 12);
    expect(result.geometricMean).toBeCloseTo(1, 12);
    expect(() => logRatioInterval([1, 1])).toThrow('eight');
    expect(() => logRatioInterval([1, 1, 1, 1, 1, 1, 1, 0])).toThrow('positive');
  });

  it('normalizes reversed A/A and A/B assignments instead of treating right/left as the target ratio', () => {
    const decision = evaluate(fixture(1.04));
    expect(decision.decision).toBe('approved');
    expect(decision.processes).toHaveLength(32);
    for (const process of decision.processes) {
      expect(process.ratios.mean).toBeCloseTo(process.comparison === 'ab' ? 1.04 : 1, 10);
      expect(process.denominator.statistics.meanMs).toBeCloseTo(2);
      expect(process.normalized.numerator).toBe(process.orientation === 'normal' ? 'right' : 'left');
    }
  });

  it('keeps sequential observations diagnostic even when that mode has a regression', () => {
    const input = fixture(1.4);
    const passing = fixture(1.02);
    input.reports = input.reports.map((report, i) => input.index.runs[i].comparison === 'ab' && input.index.runs[i].mode === 'interleaved' ? passing.reports[i] : report);
    const decision = evaluate(input);
    expect(decision.decision).toBe('approved');
    expect(decision.groups.find((group: any) => group.comparison === 'ab' && group.mode === 'sequential').passed).toBe(false);
    expect(decision.groups.find((group: any) => group.comparison === 'ab' && group.mode === 'sequential').warningOnly.p99.warning).toBe(true);
  });

  it('terminates with calibration failure, demonstrated regression, or uncertainty rather than optional retries', () => {
    expect(evaluate(fixture(1.01, 1.08)).decision).toBe('invalid-calibration');
    expect(evaluate(fixture(1.20)).decision).toBe('regression-demonstrated');
    const input = fixture(1.01), slow = fixture(1.6);
    const affected = input.index.runs.findIndex((run: any) => run.comparison === 'ab' && run.mode === 'interleaved');
    input.reports[affected] = slow.reports[affected];
    expect(evaluate(input).decision).toBe('insufficient-evidence');
  });

  it('rejects incomplete or duplicated factorial cells, protocol changes, and incomplete processes', () => {
    const missing = fixture(); missing.index.runs.pop(); expect(() => evaluate(missing)).toThrow('32-process');
    const duplicate = fixture(); Object.assign(duplicate.index.runs[1], { comparison: 'aa', mode: 'sequential' });
    expect(() => evaluate(duplicate)).toThrow('Duplicate factorial');
    const pending = fixture(); pending.index.runs[0].status = 'pending'; expect(() => evaluate(pending)).toThrow('incomplete');
    const changed = fixture(); changed.index.protocolSha256 = 'b'.repeat(64); expect(() => evaluate(changed)).toThrow('exact protocol');
    const statistics = fixture(); statistics.protocol.statistics.tCritical = 1.645; expect(() => evaluate(statistics)).toThrow('Declared statistics');
    const reordered = fixture(); [reordered.index.runs[0], reordered.index.runs[1]] = [reordered.index.runs[1], reordered.index.runs[0]];
    expect(() => evaluate(reordered)).toThrow('balanced rotation');
  });

  it('rejects wrong source, artifacts, environment, profiling and failed correctness', () => {
    const mutations: Array<[string, (input: ReturnType<typeof fixture>) => void]> = [
      ['source', input => { input.reports[0].metadata.harness.sha256 = 'b'.repeat(64); }],
      ['integrity', input => { input.reports[0].metadata.packages.left.integrity = 'sha512-Yw=='; }],
      ['Environment', input => { input.reports[0].metadata.prisma = 'different'; }],
      ['Profiled', input => { input.reports[0].metadata.cpuProfileEnabled = true; }],
      ['Correctness', input => { input.reports[0].pairs[0].results[0].evidence.checked = false; }],
    ];
    for (const [message, mutate] of mutations) { const input = fixture(); mutate(input); expect(() => evaluate(input)).toThrow(message); }
  });

  it('requires independent process/time-origin identities while allowing PID reuse across different starts', () => {
    const input = fixture(); input.reports.forEach(report => { report.metadata.pid = 123; });
    expect(evaluate(input).decision).toBe('approved');
    input.reports[1].metadata.timeOriginMs = input.reports[0].metadata.timeOriginMs;
    expect(() => evaluate(input)).toThrow('Independent process');
  });

  it('validates raw coverage and recomputed statistics instead of trusting stored summaries', () => {
    const missing = fixture(); missing.reports[0].pairs[0].results[0].samples.pop(); expect(() => evaluate(missing)).toThrow('Complete raw');
    const forged = fixture(); forged.reports[0].pairs[0].results[0].statistics.meanMs = 0.01;
    expect(() => evaluate(forged)).toThrow('raw evidence');
    const changed = fixture(); changed.reports[0].chunks[4].startIndex += 50; expect(() => evaluate(changed)).toThrow('coverage');
  });

  it('verifies frozen source/build files as well as the evidence file hashes', () => {
    const root = mkdtempSync(join(tmpdir(), 'controlled-source-'));
    try {
      const write = (file: string, data: string) => { const target = join(root, file); mkdirSync(join(target, '..'), { recursive: true }); writeFileSync(target, data); return target; };
      write('benchmarks/automatic-create-controlled.cjs', 'harness'); write('scripts/compare-controlled-performance.cjs', 'comparator');
      write('src/source.ts', 'source'); write('dist/index.js', 'build');
      const source = JSON.stringify({ sha256: { 'src/source.ts': sha256('source') } });
      const build = JSON.stringify({ 'dist/index.js': sha256('build') });
      const protocol = { sources: { harnessSha256: sha256('harness'), comparatorSha256: sha256('comparator'),
        sourceEvidencePath: write('source-evidence.json', source), sourceEvidenceSha256: sha256(source),
        distEvidencePath: write('dist-evidence.json', build), distEvidenceSha256: sha256(build) } };
      expect(verifySources(protocol, root).source.files).toBe(1);
      write('dist/index.js', 'changed');
      expect(() => verifySources(protocol, root)).toThrow('Frozen build file changed');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
