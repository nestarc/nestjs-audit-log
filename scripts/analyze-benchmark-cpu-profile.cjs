'use strict';

// Offline only. CDP Profiler.Profile: startTime/endTime/timeDeltas are microseconds;
// the first delta is relative to startTime. The clock origin is unspecified.
// https://github.com/ChromeDevTools/devtools-protocol/blob/master/json/js_protocol.json
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const sum = values => values.reduce((total, value) => total + value, 0);
function finite(value, label) { assert.ok(Number.isFinite(value), `${label} must be finite`); return value; }
function intervalIntersection(intervals, label) {
  const lower = Math.max(...intervals.map(interval => interval.lower));
  const upper = Math.min(...intervals.map(interval => interval.upper));
  assert.ok(lower <= upper, `${label}: incompatible clock bounds; no slot attribution is safe`);
  return { lower, upper, midpoint: (lower + upper) / 2, uncertainty: (upper - lower) / 2 };
}
function profileIndex(profile) {
  assert.ok(Number.isSafeInteger(profile.startTime) && Number.isSafeInteger(profile.endTime) && profile.endTime > profile.startTime,
    'Profile start/end must be ordered integer microseconds');
  assert.ok(Array.isArray(profile.nodes) && profile.nodes.length > 0, 'Profile nodes required');
  assert.ok(Array.isArray(profile.samples) && profile.samples.length > 0 && profile.samples.length === profile.timeDeltas?.length,
    'Profile samples and timeDeltas must have identical nonzero lengths');
  const nodes = new Map(), parents = new Map();
  for (const node of profile.nodes) {
    assert.ok(Number.isSafeInteger(node.id) && !nodes.has(node.id) && node.callFrame, 'Unique valid profile node required');
    nodes.set(node.id, node);
  }
  for (const node of profile.nodes) for (const child of node.children ?? []) {
    assert.ok(nodes.has(child) && !parents.has(child), 'Profile tree has missing or multiply parented nodes');
    parents.set(child, node.id);
  }
  const ancestry = new Map();
  for (const id of nodes.keys()) {
    const stack = [], seen = new Set();
    let current = id;
    while (current !== undefined) {
      assert.ok(!seen.has(current), 'Profile tree contains a cycle');
      seen.add(current); stack.push(nodes.get(current)); current = parents.get(current);
    }
    ancestry.set(id, stack);
  }
  let timestamp = profile.startTime;
  const samples = profile.samples.map((nodeId, index) => {
    const delta = profile.timeDeltas[index];
    assert.ok(Number.isSafeInteger(delta) && delta >= 0 && nodes.has(nodeId), 'Invalid sample node/time delta');
    const previousUs = timestamp;
    timestamp += delta;
    assert.ok(Number.isSafeInteger(timestamp) && timestamp <= profile.endTime, 'Sample timestamp exceeds profile end');
    return { nodeId, timestampUs: timestamp, previousUs, deltaUs: delta };
  });
  return { nodes, ancestry, samples };
}
function measuredChunks(report) {
  assert.equal(report.status, 'passed', 'Only completed successful reports can be attributed');
  assert.equal(report.cleanup?.status, 'passed', 'Report cleanup must pass');
  const chunks = report.chunks.filter(chunk => chunk.measured).map(chunk => ({ ...chunk })).sort((a, b) => a.startedAtMs - b.startedAtMs);
  assert.ok(chunks.length > 0, 'Measured chunks required');
  const identities = new Set();
  for (const [index, chunk] of chunks.entries()) {
    assert.ok(['left', 'right'].includes(chunk.slot) && Number.isSafeInteger(chunk.repeat) && chunk.repeat > 0,
      'Every chunk needs a left/right slot and repeat');
    assert.ok(Number.isSafeInteger(chunk.order) && !identities.has(chunk.order), 'Unique chunk order required');
    identities.add(chunk.order);
    finite(chunk.startedAtMs, 'Chunk start'); finite(chunk.endedAtMs, 'Chunk end');
    assert.ok(chunk.endedAtMs > chunk.startedAtMs && Number.isSafeInteger(chunk.size) && chunk.size > 0, 'Invalid chunk duration/size');
    assert.ok(index === 0 || chunks[index - 1].endedAtMs <= chunk.startedAtMs, 'Measured chunks overlap');
    assert.equal(chunk.status, 'passed', 'Measured chunk must pass');
  }
  return chunks;
}
function clockMapping(report, profile, index, chunks, maxUncertaintyUs) {
  assert.ok(Array.isArray(report.clockSync) && report.clockSync.length >= 2, 'Start/end hrtime-performance clock brackets required');
  const sync = report.clockSync.map(point => {
    assert.match(point.hrtimeBeforeNs, /^\d+$/, 'hrtimeBeforeNs must be a decimal string');
    assert.match(point.hrtimeAfterNs, /^\d+$/, 'hrtimeAfterNs must be a decimal string');
    const before = BigInt(point.hrtimeBeforeNs), after = BigInt(point.hrtimeAfterNs);
    assert.ok(after >= before, 'Reversed hrtime bracket');
    finite(point.performanceNowMs, 'Clock sync performanceNowMs');
    const us = ns => Number(ns / 1000n) + Number(ns % 1000n) / 1000;
    return { label: point.label, performanceNowMs: point.performanceNowMs,
      lower: us(before) - point.performanceNowMs * 1000 - 1,
      upper: us(after) - point.performanceNowMs * 1000 + 1 };
  }).sort((a, b) => a.performanceNowMs - b.performanceNowMs);
  const hrtime = intervalIntersection(sync, 'hrtime-performance mapping');
  assert.ok(hrtime.uncertainty <= maxUncertaintyUs, 'hrtime-performance calibration too imprecise');
  assert.ok(sync[0].performanceNowMs <= chunks[0].startedAtMs && sync.at(-1).performanceNowMs >= chunks.at(-1).endedAtMs,
    'Clock sync must bracket all measured chunks');
  assert.ok(Array.isArray(report.profileMarkers) && report.profileMarkers.length >= 2,
    'Named start/end profile markers required; hrtime origin alone is not a profiler clock calibration');
  const names = new Set();
  const markers = report.profileMarkers.map(marker => {
    assert.ok(typeof marker.functionName === 'string' && marker.functionName && !names.has(marker.functionName), 'Each marker needs a unique functionName');
    names.add(marker.functionName);
    finite(marker.startedAtMs, 'Marker start'); finite(marker.endedAtMs, 'Marker end');
    assert.ok(marker.endedAtMs > marker.startedAtMs, 'Invalid marker interval');
    assert.ok(chunks.every(chunk => marker.endedAtMs <= chunk.startedAtMs || marker.startedAtMs >= chunk.endedAtMs),
      'Clock markers must be outside measured chunks');
    const hits = index.samples.filter(sample => index.ancestry.get(sample.nodeId).some(node =>
      node.callFrame.functionName === marker.functionName));
    assert.ok(hits.length >= 5, `Insufficient CPU samples for clock marker ${marker.functionName}`);
    const firstUs = hits[0].timestampUs, lastUs = hits.at(-1).timestampUs;
    // Every observed marker sample must fall inside its recorded performance interval.
    // This derives a bound without assuming profiler and hrtime share an epoch.
    return { ...marker, samples: hits.length, firstProfileUs: firstUs, lastProfileUs: lastUs,
      lower: lastUs - marker.endedAtMs * 1000 - 1,
      upper: firstUs - marker.startedAtMs * 1000 + 1 };
  }).sort((a, b) => a.startedAtMs - b.startedAtMs);
  assert.ok(markers[0].endedAtMs <= chunks[0].startedAtMs && markers.at(-1).startedAtMs >= chunks.at(-1).endedAtMs,
    'Profile markers must bracket the entire measured workload');
  const mapping = intervalIntersection(markers, 'Profiler-performance mapping');
  assert.ok(mapping.uncertainty <= maxUncertaintyUs, 'Profiler clock uncertainty exceeds permitted bound');
  const profileStartMs = (profile.startTime - mapping.midpoint) / 1000;
  const profileEndMs = (profile.endTime - mapping.midpoint) / 1000;
  const uncertaintyMs = mapping.uncertainty / 1000;
  assert.ok(profileStartMs <= sync[0].performanceNowMs + uncertaintyMs &&
    profileEndMs >= sync.at(-1).performanceNowMs - uncertaintyMs, 'Profile clock range does not cover recorded run bounds');
  assert.ok(chunks.every(chunk => chunk.startedAtMs >= profileStartMs + uncertaintyMs && chunk.endedAtMs <= profileEndMs - uncertaintyMs),
    'Profile does not unambiguously cover every measured chunk');
  return { method: 'intersection of independently sampled named-marker bounds; bracketed hrtime checked separately',
    profileMinusPerformanceOffsetUs: mapping.midpoint, uncertaintyUs: mapping.uncertainty,
    offsetBoundsUs: { lower: mapping.lower, upper: mapping.upper },
    hrtimeMinusPerformanceOffsetUs: hrtime.midpoint, hrtimeUncertaintyUs: hrtime.uncertainty,
    profileMinusHrtimeOffsetUs: mapping.midpoint - hrtime.midpoint,
    profileRangeInPerformanceMs: { start: profileStartMs, end: profileEndMs },
    measuredRangeMs: { start: chunks[0].startedAtMs, end: chunks.at(-1).endedAtMs },
    markerOffsetMidpointSpreadUs: Math.max(...markers.map(m => (m.lower + m.upper) / 2)) - Math.min(...markers.map(m => (m.lower + m.upper) / 2)),
    markers, clockSync: sync };
}
function normalizedUrl(url = '') {
  const normalized = url.replaceAll('\\', '/');
  const modules = normalized.lastIndexOf('/node_modules/');
  if (modules >= 0) return normalized.slice(modules + 1);
  for (const directory of ['/benchmarks/', '/scripts/', '/src/', '/test/']) {
    const at = normalized.lastIndexOf(directory);
    if (at >= 0) return normalized.slice(at + 1);
  }
  return normalized;
}
function category(frame) {
  const name = frame.functionName, url = normalizedUrl(frame.url);
  if (name === '(idle)') return 'idle';
  if (/garbage collector/i.test(name)) return 'garbage-collection';
  if (name === '(program)' || name === '(root)' || (!url && !name)) return 'unattributed-native';
  if (/node:inspector|internal\/inspector|cpuProfile.*Marker|benchmarkCpuProfile.*Marker/i.test(url + ' ' + name)) return 'profiler';
  if (/node_modules\/@nestarc\/audit-log\//.test(url)) return 'audit-library';
  if (/node_modules\/(?:@prisma|prisma)\/|(?:^|\/)generated\/prisma\//.test(url)) return 'prisma-runtime';
  if (/node_modules\/(?:pg|pg-pool|pg-protocol|pg-types|pg-cloudflare|pg-connection-string)\//.test(url)) return 'postgres-driver';
  if (/^node:|^internal\//.test(url)) return 'node-internal';
  if (/^(?:benchmarks|scripts)\//.test(url)) return 'benchmark-harness';
  return url ? 'other-javascript' : 'unattributed-native';
}
function frameInfo(node) {
  const frame = node.callFrame, url = normalizedUrl(frame.url);
  return { key: JSON.stringify([frame.functionName, url, frame.lineNumber, frame.columnNumber]),
    functionName: frame.functionName || '(anonymous)', url, line: frame.lineNumber >= 0 ? frame.lineNumber + 1 : null,
    column: frame.columnNumber >= 0 ? frame.columnNumber + 1 : null, category: category(frame) };
}
function counter() { return { samples: 0, sampledIntervalMs: 0 }; }
function add(map, key, weightMs) {
  if (!map.has(key)) map.set(key, counter());
  const value = map.get(key); value.samples++; value.sampledIntervalMs += weightMs;
}
function bucket(chunks) {
  return { chunks: chunks.length, operations: sum(chunks.map(c => c.size)), elapsedMs: sum(chunks.map(c => c.endedAtMs - c.startedAtMs)),
    processCpuMicroseconds: sum(chunks.map(c => (c.cpuMicroseconds?.user ?? 0) + (c.cpuMicroseconds?.system ?? 0))),
    ...counter(), categories: new Map(), inclusiveCategories: new Map(), exclusive: new Map(), inclusive: new Map() };
}
function record(target, frames, weightMs) {
  target.samples++; target.sampledIntervalMs += weightMs;
  add(target.categories, frames[0].category, weightMs);
  add(target.exclusive, frames[0].key, weightMs);
  const seenFrames = new Set(), seenCategories = new Set();
  for (const frame of frames) {
    if (!seenFrames.has(frame.key)) { add(target.inclusive, frame.key, weightMs); seenFrames.add(frame.key); }
    if (!seenCategories.has(frame.category)) { add(target.inclusiveCategories, frame.category, weightMs); seenCategories.add(frame.category); }
  }
}
function serializeBucket(value, frameMap, top) {
  const metrics = entry => ({ ...entry, samplesPerOperation: entry.samples / value.operations,
    sampledIntervalMsPerOperation: entry.sampledIntervalMs / value.operations });
  const topFrames = map => [...map].sort((a, b) => b[1].samples - a[1].samples || b[1].sampledIntervalMs - a[1].sampledIntervalMs)
    .slice(0, top).map(([key, entry]) => ({ ...frameMap.get(key), ...metrics(entry), key: undefined }));
  return { chunks: value.chunks, operations: value.operations, elapsedMs: value.elapsedMs,
    processCpuMicrosecondsPerOperation: value.processCpuMicroseconds / value.operations,
    ...metrics({ samples: value.samples, sampledIntervalMs: value.sampledIntervalMs }),
    nonIdleSamples: value.samples - (value.categories.get('idle')?.samples ?? 0),
    exclusiveCategories: Object.fromEntries([...value.categories].map(([key, entry]) => [key, metrics(entry)])),
    inclusiveCategories: Object.fromEntries([...value.inclusiveCategories].map(([key, entry]) => [key, metrics(entry)])),
    topExclusiveFunctions: topFrames(value.exclusive), topInclusiveFunctions: topFrames(value.inclusive) };
}
function analyzeCpuProfile(report, profile, options = {}) {
  const top = options.top ?? 25, maxClockUncertaintyMs = options.maxClockUncertaintyMs ?? 3;
  assert.ok(Number.isSafeInteger(top) && top >= 1 && top <= 100, 'top must be 1..100');
  assert.ok(Number.isFinite(maxClockUncertaintyMs) && maxClockUncertaintyMs > 0 && maxClockUncertaintyMs <= 10,
    'Clock uncertainty limit must be >0 and <=10ms');
  const index = profileIndex(profile), chunks = measuredChunks(report);
  const mapping = clockMapping(report, profile, index, chunks, maxClockUncertaintyMs * 1000);
  const guardMs = mapping.uncertaintyUs / 1000;
  assert.ok(chunks.every(c => c.endedAtMs - c.startedAtMs > guardMs * 2), 'Clock uncertainty consumes entire measured chunk');
  const frameMap = new Map(), stacks = new Map();
  for (const [id, ancestors] of index.ancestry) {
    const frames = ancestors.filter(node => node.callFrame.functionName !== '(root)').map(frameInfo);
    for (const frame of frames) if (!frameMap.has(frame.key)) frameMap.set(frame.key, frame);
    stacks.set(id, frames);
  }
  const overall = bucket(chunks), slots = new Map(), repeats = new Map(), chunkBuckets = new Map();
  for (const side of ['left', 'right']) {
    const selected = chunks.filter(chunk => chunk.slot === side);
    assert.ok(selected.length, 'Both slots need measured chunks'); slots.set(side, bucket(selected));
  }
  for (const chunk of chunks) {
    const key = `${chunk.repeat}/${chunk.slot}`;
    if (!repeats.has(key)) repeats.set(key, bucket(chunks.filter(c => `${c.repeat}/${c.slot}` === key)));
    chunkBuckets.set(chunk.order, bucket([chunk]));
  }
  const excluded = { outsideMeasuredChunks: 0, uncertainBoundarySamples: 0, rootOnlySamples: 0 };
  const deltaSorted = profile.timeDeltas.filter(delta => delta > 0).sort((a, b) => a - b);
  const medianDeltaUs = deltaSorted[Math.floor(deltaSorted.length / 2)];
  let cursor = 0, longGapSamples = 0;
  for (const sample of index.samples) {
    const atMs = (sample.timestampUs - mapping.profileMinusPerformanceOffsetUs) / 1000;
    while (cursor < chunks.length && chunks[cursor].endedAtMs < atMs) cursor++;
    const chunk = chunks[cursor];
    if (!chunk || atMs < chunk.startedAtMs || atMs > chunk.endedAtMs) { excluded.outsideMeasuredChunks++; continue; }
    if (atMs <= chunk.startedAtMs + guardMs || atMs >= chunk.endedAtMs - guardMs) { excluded.uncertainBoundarySamples++; continue; }
    const frames = stacks.get(sample.nodeId);
    if (!frames.length) { excluded.rootOnlySamples++; continue; }
    const previousMs = (sample.previousUs - mapping.profileMinusPerformanceOffsetUs) / 1000;
    const weightMs = atMs - Math.max(previousMs, chunk.startedAtMs + guardMs);
    if (sample.deltaUs > medianDeltaUs * 10) longGapSamples++;
    for (const target of [overall, slots.get(chunk.slot), repeats.get(`${chunk.repeat}/${chunk.slot}`), chunkBuckets.get(chunk.order)]) record(target, frames, weightMs);
  }
  assert.ok(overall.samples > 0 && [...slots.values()].every(value => value.samples > 0), 'No usable profiled samples for both slots');
  const result = { schemaVersion: 1, kind: 'benchmark-cpu-profile-analysis', status: 'attributed', diagnosticOnly: true,
    metadata: report.metadata, clock: mapping,
    coverage: { profileSamples: profile.samples.length, attributedSamples: overall.samples, excluded,
      medianProfileSampleDeltaUs: medianDeltaUs, attributedSamplesWithDeltaOver10xMedian: longGapSamples,
      boundaryGuardMs: guardMs, profileMinSampleUs: index.samples[0].timestampUs, profileMaxSampleUs: index.samples.at(-1).timestampUs },
    overall: serializeBucket(overall, frameMap, top),
    slots: Object.fromEntries([...slots].map(([key, value]) => [key, serializeBucket(value, frameMap, top)])),
    repeats: Object.fromEntries([...repeats].map(([key, value]) => [key, serializeBucket(value, frameMap, top)])),
    chunks: chunks.map(chunk => ({ order: chunk.order, repeat: chunk.repeat, slot: chunk.slot, startedAtMs: chunk.startedAtMs,
      endedAtMs: chunk.endedAtMs, ...serializeBucket(chunkBuckets.get(chunk.order), frameMap, Math.min(top, 10)) })),
    interpretation: [
      'Sampling identifies observed stacks, not instruction counts or a causal explanation by itself. Compare matched profiled A/A and A/B processes.',
      'sampledIntervalMs attributes the preceding inter-sample wall interval to the sampled frame, clipped at safe chunk boundaries. It is an approximation, not measured CPU time.',
      'processCpuMicrosecondsPerOperation covers the Node process; the profile covers one sampled isolate/thread. Idle/native gaps and background threads prevent exact accounting.',
      'Exclusive categories partition sampled leaves. Inclusive categories/functions overlap and must not be added; recursion is counted once per sample.',
      'URL category matching and path normalization group installed copies; minified names/native frames/async stack boundaries limit attribution.',
      'Clock mapping uses sampled named-marker ancestors, validates start/end bounds and excludes samples near uncertain chunk borders; hrtime epoch equality is never presumed.',
      'Profiles add overhead and are diagnosis only, not release acceptance evidence.',
    ], sources: ['https://github.com/ChromeDevTools/devtools-protocol/blob/master/json/js_protocol.json'] };
  result.slotCategoryDifferences = Object.fromEntries([...new Set([...Object.keys(result.slots.left.exclusiveCategories), ...Object.keys(result.slots.right.exclusiveCategories)])]
    .map(key => [key, { rightMinusLeftSamplesPerOperation: (result.slots.right.exclusiveCategories[key]?.samplesPerOperation ?? 0) - (result.slots.left.exclusiveCategories[key]?.samplesPerOperation ?? 0),
      rightMinusLeftSampledIntervalMsPerOperation: (result.slots.right.exclusiveCategories[key]?.sampledIntervalMsPerOperation ?? 0) - (result.slots.left.exclusiveCategories[key]?.sampledIntervalMsPerOperation ?? 0) }]));
  return result;
}
function main(argv) {
  const [reportPath, profilePath, ...args] = argv;
  assert.ok(reportPath && profilePath, 'Usage: node scripts/analyze-benchmark-cpu-profile.cjs REPORT PROFILE --output OUTPUT [--top 25] [--max-clock-uncertainty-ms 3]');
  const flags = {};
  for (let i = 0; i < args.length; i += 2) {
    assert.ok(['--output', '--top', '--max-clock-uncertainty-ms'].includes(args[i]) && !flags[args[i]] && args[i + 1], 'Invalid/duplicate CLI option');
    flags[args[i]] = args[i + 1];
  }
  assert.ok(flags['--output'], 'Explicit --output required');
  const destination = path.resolve(flags['--output']);
  assert.ok(![reportPath, profilePath].some(file => path.resolve(file) === destination), 'Output must not overwrite inputs');
  assert.ok(!fs.existsSync(destination), 'Output must be new; retained evidence is never overwritten');
  const reportBytes = fs.readFileSync(reportPath), profileBytes = fs.readFileSync(profilePath);
  const result = analyzeCpuProfile(JSON.parse(reportBytes), JSON.parse(profileBytes), {
    top: flags['--top'] ? Number(flags['--top']) : undefined,
    maxClockUncertaintyMs: flags['--max-clock-uncertainty-ms'] ? Number(flags['--max-clock-uncertainty-ms']) : undefined,
  });
  result.inputs = [reportPath, profilePath].map((file, index) => ({ path: path.resolve(file),
    sha256: crypto.createHash('sha256').update(index === 0 ? reportBytes : profileBytes).digest('hex') }));
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(destination, `${JSON.stringify(result, null, 2)}\n`, { flag: 'wx' });
  console.log(`Attributed ${result.coverage.attributedSamples}/${result.coverage.profileSamples} samples; clock uncertainty ±${(result.clock.uncertaintyUs / 1000).toFixed(3)}ms; ${destination}`);
  for (const side of ['left', 'right']) console.log(`${side}: ${result.slots[side].samples} samples / ${result.slots[side].operations} operations; ${result.slots[side].processCpuMicrosecondsPerOperation.toFixed(3)} process CPU µs/op`);
}
module.exports = { analyzeCpuProfile, profileIndex, clockMapping, category, normalizedUrl };
if (require.main === module) {
  try { main(process.argv.slice(2)); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
