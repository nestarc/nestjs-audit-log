# Controlled performance decision on 2026-10-26

**Approved for the seven individually defined local PostgreSQL performance scenarios.**
The performance hold on this frozen candidate is lifted for that scope. The other six scenarios
passed both original formal runs; the new, predeclared controlled comparison supersedes the
automatic-create measurement. Mean, P95 and throughput limits remain unchanged.

The original full-sequence failure remains in the
[historical formal report](2026-10-26-formal-performance-validation.md). This decision does not
claim that its exact transient event has been reconstructed, that the old full execution history
is equivalent, or that production and SQL Server performance have been certified.

## What was corrected

The earlier investigation ended with uncertainty without a finite way to resolve the approval.
That was insufficient. The original benchmark placed two packages in long sequential blocks
inside one changing Node/database execution history. It alternated measurement order but kept
package loading fixed, and its controls were not adjacent to automatic create. Earlier diagnostic
interleaving also changed warmup, verification and observation timing, limiting attribution.

The new [controlled harness](../benchmarks/automatic-create-controlled.cjs) holds the following
constant between sequential and interleaved modes:

- Both slots complete the same left/right warmup before measurement.
- Every measured chunk contains 50 operations and identical CPU/ELU/pool bookkeeping.
- Both business datasets remain present until all measured work completes.
- There are no correctness queries, deletions, server-statistics calls or report writes between
  measured chunks.
- Only the measured slot permutation changes between the two modes.

Package assignment, module loading and first measured slot are crossed independently.
Each replication starts a new Node process and a new database schema. The comparator checks
actual source hashes, artifact identities, complete raw samples, chunk order, environment,
correctness, cleanup and process independence.

These changes address measurement attribution and precision. No library runtime change was
needed or made. The source/build and candidate tarball remain identical to the formal runs.

## Protocol declared before the measurements

The protocol was saved before any of the 32 matrix processes began. It selects **interleaved**
execution as the primary measurement in advance; sequential results are diagnostic. No choice
was made after inspecting which mode passed.

- Eight cells: package orientation × load order × first measured slot, each with two values.
- Four groups: A/A sequential, A/A interleaved, A/B sequential and A/B interleaved.
- Exactly 32 independent processes, executed serially in a balanced rotated group order.
- Each process: 100 warmups and 1,000 measured operations per slot; one pair per process.
- A/A uses two separate installations of exactly the same published 0.7.1 tarball.
- A/B uses published 0.7.1 and the unchanged formal candidate; orientation is normalized before
  calculating ratios.
- No optional extra repetitions, replacement observations or threshold adjustments.

The acceptance target is each named scenario's operation cost. The original sequence of 12 manual
blocks before automatic create was incidental benchmark scheduling, not an independently required
mixed-workload contract. The protocol explicitly replaces only the automatic-create measurement.

For each metric, eight fresh-process log ratios provide the inference sample. Chunks and individual
operations are not counted as independent replicates. The model-based interval is:

`exp(mean(log ratios) ± 1.894578605 × sampleSD(log ratios) / sqrt(8))`.

This is a two-sided 90% interval, whose individual endpoints are one-sided 95% bounds. It assumes
approximately normal, independent process log ratios and estimates their geometric mean. It is
not a confidence interval for the original median statistic; the original median criteria are
also checked separately.

A/A calibration requires the whole interval inside [0.95, 1.05] for mean and throughput, and
[0.925, 1.075] for P95. A/B requires mean's upper bound ≤1.10, P95's upper bound ≤1.15 and
throughput's lower bound ≥0.90. P99 remains warning-only.

## Result

All primary calibration and candidate checks passed. The independent reviewer recomputed all
12 group/metric intervals from the normalized process statistics and obtained the same results.

| Primary A/A calibration | Observed 90% interval | Required interval |
|---|---:|---:|
| Mean latency ratio | 0.98051–1.02052 | 0.95–1.05 |
| P95 latency ratio | 0.95189–1.04304 | 0.925–1.075 |
| Throughput ratio | 0.97985–1.01984 | 0.95–1.05 |

| Primary A/B metric | Median change | Geometric mean change | One-sided 95% bound | Requirement |
|---|---:|---:|---:|---:|
| Mean latency | +0.69% | +0.34% | upper +2.83% | ≤ +10% |
| P95 latency | -2.31% | +0.25% | upper +4.93% | ≤ +15% |
| Throughput | -0.69% | -0.33% | lower -2.75% | ≥ -10% |

The other six scenarios retained their 18/18 checks in **each** original formal run: manual
small/64 KiB at concurrency 1/4, and automatic update/delete. The controlled automatic-create
decision completes the named seven-scenario local acceptance set.

Sequential diagnostic results are retained and are less favorable. A/B geometric mean latency
was +5.57% and P95 +7.99%; their upper bounds were +11.23% and +15.94%, and throughput's lower
bound was -10.10%. Those intervals do not establish noninferiority under the stricter new rule.
They also do not demonstrate a regression beyond the limits. They are evidence of execution-method
sensitivity, not a result to hide or silently substitute into the predeclared primary decision.

Individual differences have not vanished. For example, one interleaved A/A P95 ratio was 0.85596.
The calibration and acceptance decisions use the complete independent-process results and their
predeclared uncertainty bounds, not a promise that every individual pair is identical.

## What the CPU evidence establishes

Four separate profiles were selected by a rule declared before the matrix: one configuration
per comparison/mode group with the largest absolute log mean-ratio deviation. These are diagnostic
runs and never enter the gate. Profiling changed their timings.

The [profile analyzer](../scripts/analyze-benchmark-cpu-profile.cjs) aligns sampled named functions
outside measured work with the recorded measurement clock. All four mappings passed, with
uncertainty of approximately ±0.25–0.66 ms; ambiguous boundary samples are excluded. Node's
[CPU-profiler CLI](https://github.com/nodejs/node/blob/main/doc/api/cli.md#--cpu-prof) produces the
profiles; the [Profiler format](https://chromedevtools.github.io/devtools-protocol/tot/Profiler/#type-Profile)
defines microsecond sample deltas but does not establish a shared clock origin.

In profiled sequential A/A, the slower slot used 1,582.819 versus 1,489.624 microseconds of process
CPU per operation. Exclusive Prisma samples rose from 0.486 to 0.605 per operation, while audit
library samples were 0.040 and 0.037. The recurring largest JavaScript leaf was Prisma's
call-site-capture constructor (`gn` in this installed minified runtime, constructing an Error).
This is a shared dependency path, not a newly added candidate audit function.

All four profiles had a GC concentration in the third measured 50-operation chunk: 8–10 GC
samples and about 1,915–2,531 microseconds of process CPU per operation in that chunk. Depending
on the schedule, it belonged to an A/A slot, the baseline or the candidate. This demonstrates how
shared runtime phases can be assigned to different comparison slots. It does not establish GC
as the sole cause of the original failure.

In the profiled sequential A/B configuration, the candidate had higher latency but **lower**
total process CPU than the baseline. Audit-library exclusive samples differed by only two per
1,000 operations. The evidence does not identify a candidate-added audit CPU bottleneck.
Sampled stack intervals are not exact CPU accounting, and they do not observe all native or
background-thread work.

The supported conclusion is that execution method and shared runtime state materially affect
the measured comparison. The controlled primary measurement meets the unchanged regression
limits. The original event's exact OS/JIT/GC sequence remains unknown, but reconstructing that
event is no longer an unbounded prerequisite for a scoped approval.

## Verification and retained evidence

- All 32 matrix processes passed their business/audit counts, actor/tenant, redaction, unique target
  and cleanup assertions: 64,000 measured operations plus 6,400 warmups.
- All four profile processes and the separate small functional smoke passed correctness and
  cleanup. They are excluded from the acceptance sample.
- The existing 59 source/configuration hashes and 208 build hashes still match.
- Candidate integrity: `sha512-KdFzm/2XV88KKrzWN41SIPjOR4Dw3K2w8Mi9oHFYGayH/BaxbCW/OjggsMmYFjaRxSRxPH3U+NPd1wO9ID3v/g==`.
- Baseline integrity: `sha512-TePjZu54blkfovAuwMZoisofZ6qD40aEzxHzsgZBbheHJqqdd4GpSS8wPA7tVRQ33Jvq7AROeUqWY9NggTcEew==`.
- Comparator: nine focused tests passed. Profile analyzer: seven focused tests passed. Typecheck,
  syntax, targeted lint and whitespace checks passed.
- Independent calculation and causal-language reviews completed. The dedicated PostgreSQL
  container was removed after verifying no workload schemas remained.

Environment remains Apple M1 Pro / macOS arm64, Node 24.22.1, Prisma/adapter 7.9.1 and the original
PostgreSQL 16.15 arm64 image. This round uses default PostgreSQL timing/statement instrumentation,
matching the original formal server rather than the instrumented first investigation.

Local raw evidence is retained in
[`benchmarks/results/cause-resolution-2026-10-26/`](../benchmarks/results/cause-resolution-2026-10-26/):
the predeclared protocol, complete matrix index and raw reports, decision, profile selections and
raw profiles, clock-validated analyses, artifact locks, source verification, environment/cleanup
records and SHA-256 manifest. Generated evidence is ignored by Git; this report, the controlled
harness, comparator, profile analyzer and their tests are repository files.

The raw harness reports remain comparison evidence; the separate
[controlled comparator](../scripts/compare-controlled-performance.cjs) creates the acceptance
decision only under the frozen protocol and rejects profiled runs. No prior diagnostic result
was retroactively relabeled as a passing acceptance run. No package was published or deployed.
