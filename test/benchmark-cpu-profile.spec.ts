const { analyzeCpuProfile, category, normalizedUrl } = require('../scripts/analyze-benchmark-cpu-profile.cjs') as {
  analyzeCpuProfile(report: any, profile: any, options?: any): any;
  category(frame: any): string;
  normalizedUrl(url: string): string;
};

function fixture() {
  const offsetUs = 1_000_000_000;
  const frame = (functionName: string, url: string) => ({ functionName, url, lineNumber: 0, columnNumber: 0, scriptId: '1' });
  const nodes = [
    { id: 1, callFrame: frame('(root)', ''), children: [2, 4, 6, 8, 9, 10] },
    { id: 2, callFrame: frame('benchmarkCpuProfileStartMarker', '/repo/benchmarks/automatic-create-controlled.cjs'), children: [3] },
    { id: 3, callFrame: frame('now', 'node:perf_hooks') },
    { id: 4, callFrame: frame('benchmarkCpuProfileEndMarker', '/repo/benchmarks/automatic-create-controlled.cjs'), children: [5] },
    { id: 5, callFrame: frame('now', 'node:perf_hooks') },
    { id: 6, callFrame: frame('create', '/first/node_modules/@nestarc/audit-log/dist/create.js'), children: [7] },
    { id: 7, callFrame: frame('run', 'node:async_hooks') },
    { id: 8, callFrame: frame('create', '/second/node_modules/@nestarc/audit-log/dist/create.js') },
    { id: 9, callFrame: frame('(idle)', '') },
    { id: 10, callFrame: frame('(garbage collector)', '') },
  ];
  const points = [
    ...[12, 16, 20, 24, 28].map(ms => [ms, 3]),
    [100.5, 6], [110, 7], [120, 6], [130, 9], [150, 8], [160, 10], [169.5, 8],
    ...[301, 305, 310, 315, 319].map(ms => [ms, 5]),
  ];
  let previous = offsetUs;
  const timeDeltas = points.map(([ms]) => { const at = offsetUs + ms * 1000; const delta = at - previous; previous = at; return delta; });
  const chunk = (slot: string, order: number, start: number, end: number) => ({ slot, order, repeat: 1, measured: true,
    startedAtMs: start, endedAtMs: end, size: 50, status: 'passed', cpuMicroseconds: { user: 1000, system: 100 } });
  const sync = (ms: number) => ({ label: `${ms}`, performanceNowMs: ms,
    hrtimeBeforeNs: String(5_000_000_000_000 + ms * 1_000_000), hrtimeAfterNs: String(5_000_000_000_100 + ms * 1_000_000) });
  return {
    report: { status: 'passed', cleanup: { status: 'passed' }, metadata: { cpuProfileEnabled: true },
      chunks: [chunk('left', 1, 100, 140), chunk('right', 2, 145, 170)], clockSync: [sync(0), sync(330)],
      profileMarkers: [{ functionName: 'benchmarkCpuProfileStartMarker', startedAtMs: 10, endedAtMs: 30 },
        { functionName: 'benchmarkCpuProfileEndMarker', startedAtMs: 300, endedAtMs: 320 }] },
    profile: { startTime: offsetUs, endTime: offsetUs + 340_000, nodes, samples: points.map(([, id]) => id), timeDeltas },
  };
}

describe('offline benchmark CPU profile attribution', () => {
  it('calibrates markers through ancestors without presuming the hrtime epoch', () => {
    const { report, profile } = fixture();
    const result = analyzeCpuProfile(report, profile);
    expect(result.clock.profileMinusPerformanceOffsetUs).toBe(1_000_000_000);
    expect(result.clock.profileMinusHrtimeOffsetUs).toBeCloseTo(-4_000_000_000.05, 3);
    expect(result.clock.uncertaintyUs).toBe(1001);
    expect(result.clock.markers.map((marker: any) => marker.samples)).toEqual([5, 5]);
    expect(result.coverage.attributedSamples).toBe(5);
    expect(result.coverage.excluded.uncertainBoundarySamples).toBe(2);
    expect(result.slots.left.samples).toBe(3);
    expect(result.slots.right.samples).toBe(2);
  });

  it('separates exclusive and inclusive ownership and normalizes installed copies', () => {
    const { report, profile } = fixture();
    const result = analyzeCpuProfile(report, profile);
    expect(result.slots.left.exclusiveCategories['node-internal'].samples).toBe(1);
    expect(result.slots.left.inclusiveCategories['audit-library'].samples).toBe(2);
    expect(result.slots.left.exclusiveCategories.idle.samples).toBe(1);
    expect(result.slots.right.exclusiveCategories['garbage-collection'].samples).toBe(1);
    const create = result.overall.topExclusiveFunctions.filter((frame: any) => frame.functionName === 'create');
    expect(create).toHaveLength(1);
    expect(create[0].samples).toBe(2);
    expect(create[0].url).toBe('node_modules/@nestarc/audit-log/dist/create.js');
  });

  it('refuses missing, undersampled or imprecise marker calibration', () => {
    for (const change of [
      (report: any) => { delete report.profileMarkers; },
      (report: any) => { report.profileMarkers[0].functionName = 'unobserved'; },
      (report: any) => { report.profileMarkers[0].startedAtMs = 0; report.profileMarkers[0].endedAtMs = 50;
        report.profileMarkers[1].startedAtMs = 280; report.profileMarkers[1].endedAtMs = 340; },
    ]) {
      const { report, profile } = fixture(); change(report);
      expect(() => analyzeCpuProfile(report, profile)).toThrow();
    }
  });

  it('rejects inconsistent clocks and an insufficient profile range', () => {
    const drifted = fixture();
    drifted.report.profileMarkers[1].startedAtMs += 20;
    drifted.report.profileMarkers[1].endedAtMs += 20;
    expect(() => analyzeCpuProfile(drifted.report, drifted.profile)).toThrow(/incompatible clock bounds/);
    const hrtimeDrift = fixture();
    hrtimeDrift.report.clockSync[1].hrtimeBeforeNs = String(BigInt(hrtimeDrift.report.clockSync[1].hrtimeBeforeNs) + 10_000_000n);
    hrtimeDrift.report.clockSync[1].hrtimeAfterNs = String(BigInt(hrtimeDrift.report.clockSync[1].hrtimeAfterNs) + 10_000_000n);
    expect(() => analyzeCpuProfile(hrtimeDrift.report, hrtimeDrift.profile)).toThrow(/incompatible clock bounds/);
    const truncated = fixture(); truncated.profile.endTime -= 15_000;
    expect(() => analyzeCpuProfile(truncated.report, truncated.profile)).toThrow(/range does not cover/);
  });

  it('rejects overlap, incomplete runs and calibration during measured work', () => {
    const overlapped = fixture(); overlapped.report.chunks[1].startedAtMs = 139;
    expect(() => analyzeCpuProfile(overlapped.report, overlapped.profile)).toThrow(/overlap/);
    const incomplete = fixture(); incomplete.report.status = 'running';
    expect(() => analyzeCpuProfile(incomplete.report, incomplete.profile)).toThrow(/completed/);
    const markerOverlap = fixture(); markerOverlap.report.profileMarkers[0].endedAtMs = 110;
    expect(() => analyzeCpuProfile(markerOverlap.report, markerOverlap.profile)).toThrow(/outside measured/);
  });

  it('rejects malformed time deltas and node trees', () => {
    const missing = fixture(); missing.profile.timeDeltas.pop();
    expect(() => analyzeCpuProfile(missing.report, missing.profile)).toThrow(/identical/);
    const unknown = fixture(); unknown.profile.samples[6] = 999;
    expect(() => analyzeCpuProfile(unknown.report, unknown.profile)).toThrow(/Invalid sample/);
    const cycle = fixture(); cycle.profile.nodes[2].children = [1];
    expect(() => analyzeCpuProfile(cycle.report, cycle.profile)).toThrow(/cycle/);
  });

  it('classifies user/runtime/driver/harness frames without conflating them', () => {
    const classify = (url: string) => category({ functionName: 'execute', url });
    expect(classify('/root/node_modules/@prisma/client/runtime/client.js')).toBe('prisma-runtime');
    expect(classify('/root/node_modules/@prisma/adapter-pg/dist/index.js')).toBe('prisma-runtime');
    expect(classify('/root/node_modules/pg/lib/client.js')).toBe('postgres-driver');
    expect(classify('/root/benchmarks/automatic-create-controlled.cjs')).toBe('benchmark-harness');
    expect(classify('node:internal/process/task_queues')).toBe('node-internal');
    expect(normalizedUrl('file:///root/node_modules/@nestarc/audit-log/dist/index.js'))
      .toBe('node_modules/@nestarc/audit-log/dist/index.js');
  });
});
