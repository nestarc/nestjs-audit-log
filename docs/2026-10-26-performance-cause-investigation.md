# Automatic-create performance cause investigation

**Follow-up:** the [controlled resolution](2026-10-26-performance-resolution.md) subsequently
approved the seven named local PostgreSQL scenarios. This document preserves the first
investigation's findings and limitations; its hold was superseded by that predeclared follow-up.

**The original formal failure has no confirmed single root cause yet.** The investigation
established large differences between identical packages and localized observed slowdowns mainly
outside recorded PostgreSQL planning/execution time. It did not find a stable candidate-specific
automatic-create regression. The [formal decision](2026-10-26-formal-performance-validation.md)
was left **inconclusive; release performance approval was on hold** at this stage.

This is a diagnosis of the initial mean +10.55% / P95 +23.36% failure and its passing confirmation.
None of the diagnostic runs replaces those results or changes the acceptance limits.

## Experiment design

The protocol was saved before measurements. First, the original full benchmark compared the
same registry 0.7.1 tarball in two independent installations. Then four diagnostic phases compared
A/A and A/B under sequential and interleaved execution. The predeclared follow-ups added the
64 KiB, concurrency-4 manual workload preceding automatic create, then retained idle connections
when pool removal events overlapped measurement. Each phase ran once; all outcomes are retained.

- A/A: identical registry 0.7.1 in separate module directories and require caches.
- A/B: registry 0.7.1 versus the exact candidate used by both formal runs.
- Original A/A: five paired repeats; all seven original scenarios, 100 warmups and 1,000 measured
  operations per block. Its 21 aggregate checks passed. Individual pairs are not aggregate gates.
- Eight diagnostic phases: six automatic-create pairs each, 100 warmups and 1,000 measured
  operations per slot. Interleaved execution uses balanced 50-operation ABBA/BAAB chunks.
- Prelude phases add two 64 KiB manual blocks at concurrency 4 before each automatic pair.
- Default pool maximum is 4, idle timeout 1 second. The final counterfactual changes only the
  configured timeout to 10 minutes within the sequential/prelude protocol.
- Each phase has a fresh Node process and unique schema; repetitions inside a phase share a
  process, client, pool and accumulated audit rows. Phases ran sequentially without competing
  benchmark or test jobs.

Environment: Apple M1 Pro / macOS arm64, Node 24.22.1, Prisma/adapter 7.9.1, PostgreSQL 16.15
arm64 in a dedicated Docker container on localhost:5433. The PostgreSQL image matches the formal
run. Unlike that run, diagnostics enable pg_stat_statements, planning/IO/WAL timing and checkpoint
logging. This affects absolute timing. The original-harness A/A has no added Node instrumentation,
but uses this instrumented server.

## Observations

Values below are the median of paired right/left ratios, expressed as percentage changes.
Positive latency means the right slot is slower. A/B's right slot is the candidate; A/A's is
another installation of the same release. These are descriptive diagnostic results.

| Comparison | Schedule and precondition | Mean | P95 |
|---|---|---:|---:|
| A/A | Original full benchmark | -3.81% | -5.26% |
| A/A | Isolated sequential | -2.13% | -0.61% |
| A/B | Isolated sequential | +5.56% | +2.04% |
| A/A | Isolated interleaved | +0.02% | +0.02% |
| A/B | Isolated interleaved | -0.78% | +1.04% |
| A/A | Sequential after 64 KiB prelude | +3.32% | +6.75% |
| A/B | Sequential after 64 KiB prelude | +1.00% | +2.50% |
| A/A | Prelude, connections retained | -1.77% | -1.06% |
| A/B | Prelude, connections retained | -5.73% | -4.51% |

The original full A/A benchmark had one pair with mean **+13.39%** and P95 **+19.25%** despite
identical code. The instrumented prelude A/A had another with mean **+13.57%** and P95 **+22.55%**.
This demonstrates individual excursions of the size of the acceptance limits without a version
change. Both A/A aggregate medians remained within the limits: this did **not** reproduce or
invalidate the original formal median failure.

### Where the measured time went

For isolated sequential A/B, the arithmetic average of the six paired differences was
**+0.150056 ms/operation**. This additive statistic differs from the median ratio in the table.

| Component | Right minus left, ms/operation |
|---|---:|
| Driver query duration | +0.067079 |
| Remaining operation duration | +0.082977 |
| Recorded server planning + execution | +0.000774 |
| GC duration overlapping measurement | +0.003271 |

Driver plus remaining duration sum to total latency. Server and GC are overlapping diagnostics,
not additional terms. Driver timing includes transport, decoding and JavaScript scheduling;
subtracting recorded server time does not isolate network time. The remaining duration includes
Prisma/library execution, scheduling, pool acquisition and diagnostic overhead.

The A/A prelude's sixth pair is an especially useful negative control:

| Metric | Left | Right |
|---|---:|---:|
| Mean latency, ms/operation | 2.905882 | 3.300268 |
| Driver queries, ms/operation | 2.273532 | 2.442485 |
| Remaining duration, ms/operation | 0.632350 | 0.857783 |
| Recorded server planning + execution, ms/operation | 0.109521 | 0.101620 |
| GC overlapping the 1,000-operation block, ms | 20.327624 | 18.524626 |
| Node process CPU, microseconds/operation | 922.992 | 1222.168 |

The slower identical-code slot used more client CPU while recorded server time and GC overlap
were lower. Its increased latency is spread through the block. This narrows the observed
difference toward client/runtime execution and waiting, without identifying a particular function,
JIT tier, host scheduling event or transport component. Process CPU also includes instrumentation
and Node background work; it is not an isolated measure of audit-library CPU cost.

### Connection lifecycle counterfactual

After the prelude, exactly three idle connections were removed in the first measured automatic
block of each of the 12 A/A and A/B pairs, roughly 306–396 ms after measurement started. No
measured reconnects occurred. The first block was slower in only three of six A/A pairs.

In the slow A/A sixth pair, all three removals overlapped one 5.397 ms operation. A diagnostic
calculation excluding that operation still gives a mean ratio of 1.1350 versus the original
1.1357. This calculation is only an attribution check; no samples were removed from scores.

Retaining connections eliminated measured removals, but the sixth A/A pair still showed mean
**+10.36%** and P95 **+14.22%**. Thus idle removal is not necessary for large individual differences.
The counterfactual does not establish that retaining connections fixes performance, and it does
not justify a production pool configuration change.

## Source and measurement checks

- The 59 source/configuration hashes and 208 build hashes from the formal validation still match.
  No library runtime change was made during this investigation.
- Baseline integrity: `sha512-TePjZu54blkfovAuwMZoisofZ6qD40aEzxHzsgZBbheHJqqdd4GpSS8wPA7tVRQ33Jvq7AROeUqWY9NggTcEew==`.
- Candidate integrity: `sha512-KdFzm/2XV88KKrzWN41SIPjOR4Dw3K2w8Mi9oHFYGayH/BaxbCW/OjggsMmYFjaRxSRxPH3U+NPd1wO9ID3v/g==`.
- Forty of the baseline's 47 JavaScript files are byte-identical in the candidate, including the
  automatic extension, create handler, database helpers and audit context. Changed automatic-path
  code concerns error/missing-context reporting; these successful actor-context workloads do not
  enter it. This does not exclude indirect module initialization or allocation effects.
- Independent installation locks have the same versions and integrities for the 24 dependency
  paths other than the audit package. A/A explicitly checks distinct module/context instances.
- Each measured automatic operation retained the same five query categories: transaction begin,
  business insert, select, audit insert and commit. No extra candidate query was observed.
- The large isolated A/B difference is not explained by the recorded GC overlap, new connections
  or checkpoint activity. Counter snapshots can lag or include observer queries, so this finding
  applies to these diagnostics, not retrospectively to the first formal run.

The new [diagnostic harness](../benchmarks/automatic-create-diagnostic.cjs) records per-operation
driver categories and latency, GC, event-loop, process CPU/memory, pool lifecycle and database
counters. Query text and parameters are not retained. Reports cannot overwrite existing evidence;
all workload promises settle before cleanup. Business/audit counts, actor/tenant, redaction and
schema cleanup are checked. Syntax and recommended JavaScript lint rules passed.

## Attribution limits and next valid experiment

The formal run had per-operation latency samples but no simultaneous GC, CPU, pool or PostgreSQL
wait telemetry. Its exact runtime event cannot be reconstructed from the later experiments.
Calling the original failure a confirmed Docker, GC, connection-pool or code defect would exceed
the evidence.

The current benchmark also has an attribution limitation: long sequential slots share changing
runtime/database state, while its unaudited control is earlier in the manual workload rather than
adjacent to automatic create. Candidate always occupies the second-loaded module. Several repeats
inside one process are not independent process replicates.

Interleaving reduced deviations, but this is not an order-only experiment: warmup placement,
correctness/deletion timing, observation frequency and per-chunk DB snapshots also differ. The
64 KiB prelude reproduces only the immediately preceding workload, not all 12 manual blocks,
earlier update/delete blocks and report serialization of the original benchmark.

Before another acceptance decision, the next protocol should keep warmups, verification, data
lifetime, chunk bookkeeping and observation points identical while changing only execution order;
cross over package load/slot placement across fresh processes; and run on a fixed, otherwise idle
runner. Capture CPU profiles and server waits for a reproduced slow block in separate diagnosis
runs. Predeclare the sample count and decision rule, validate the method with A/A, and retain the
existing mean/P95/throughput limits. A new passing run alone cannot resolve the retained failure.

No speculative runtime optimization, threshold relaxation or additional acceptance rerun was
performed. The useful result is a localized, documented uncertainty and a measurement protocol
that exposes it rather than silently treating the latest passing result as release approval.

## Evidence

Generated local evidence is retained in
[`benchmarks/results/cause-investigation-2026-10-26/`](../benchmarks/results/cause-investigation-2026-10-26/).
It is ignored by Git; this report and the diagnostic harness are repository files.

The directory contains the predeclared protocol, original A/A raw data and comparator output,
eight full diagnostic reports, the earlier small harness smoke, verified tarballs and installation
locks, code verification, controller and offline analyzer, detailed component analysis and a
SHA-256 manifest. The smoke preceded the final telemetry refinements and is not combined with
the full-phase conclusions. Original formal evidence remains in its separate directory.

The dedicated PostgreSQL container and generated diagnostic dependency installations are removed
after evidence collection; package tarballs and lockfiles are retained for reconstruction.
