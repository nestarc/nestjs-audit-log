# Formal performance revalidation on 2026-10-26

**Historical decision: inconclusive. Current scoped local approval is recorded in the
[controlled follow-up](2026-10-26-performance-resolution.md).** The first formal run failed
two automatic-create latency limits. The single predeclared confirmation passed all 21 gated
checks. The source, build and candidate tarball were identical in both runs. Under the agreed
policy, a passing confirmation does not erase the initial failure. No extra rerun of this
original protocol or threshold change was used to obtain approval. The follow-up replaces only
the automatic-create measurement under a stronger protocol declared before new data.

## Protocol

- Compare published npm 0.7.1 with the unchanged working-tree candidate, using installed tarballs.
- Seven PostgreSQL scenarios: manual small/64 KiB at concurrency 1/4, and automatic create/update/delete at concurrency 1.
- Each block: 100 warmups, 1,000 measured operations; five paired repeats per run.
- Each run: 90 blocks and 90,000 measured operations; 99,000 including warmups and unaudited controls.
- Two completed runs: 180,000 measured operations, 198,000 including warmups.
- Gate each scenario separately on the median of its five paired candidate/baseline ratios:
  mean ≤ 1.10, P95 ≤ 1.15, throughput ≥ 0.90. P99 > 1.25 is warning-only.
- First gate failure triggers exactly one confirmation; disagreement remains inconclusive.
- Environment: Apple M1 Pro, macOS arm64, Node 24.22.1, Prisma/pg adapter 7.9.1,
  Docker PostgreSQL 16.15 on arm64, pool maximum 4. This is a local environment policy.

The [machine-specific budget](../benchmarks/budgets/2026-10-26-local-quality.json) records these
limits. It is not automatically applied to every CI host. The comparison measures business write,
audit write and transaction commit together. It covers the existing manual and automatic write
paths; SQL Server, query performance and newly enabled optional features are outside this
PostgreSQL performance gate.

## Automatic create result

| Metric | Criterion | Initial run | Confirmation |
|---|---|---:|---:|
| Mean latency | At most +10% | +10.55% | -1.25% |
| P95 latency | At most +15% | +23.36% | -2.70% |
| Throughput | At least −10% | -9.54% | +1.27% |
| P99 latency | Warning above +25% | +52.77% | -22.55% |

The initial run passed 19/21 gated checks; confirmation passed 21/21. The other six scenarios
passed in both runs. P99 produced one warning on initial automatic create and none in confirmation.
A confirmation pass describes the median, not every block: its third automatic-create pair still
exceeded the mean, P95 and throughput limits individually.

## All scenario changes

Each cell below shows mean latency / P95 latency / throughput changes relative to 0.7.1.

| Scenario | Initial run | Confirmation |
|---|---|---|
| manual/create/small/1 | -3.51% / -3.46% / +3.64% | -1.80% / +0.73% / +1.84% |
| manual/create/small/4 | -1.76% / -3.67% / +1.67% | -1.74% / -5.30% / +1.65% |
| manual/create/64k/1 | -1.57% / +1.48% / +1.59% | -9.18% / -4.16% / +10.12% |
| manual/create/64k/4 | +0.77% / +7.47% / -0.83% | -3.27% / -2.67% / +3.36% |
| atomic-required/create/small/1 | +10.55% / +23.36% / -9.54% | -1.25% / -2.70% / +1.27% |
| atomic-required/update/small/1 | +1.27% / +3.94% / -1.26% | -7.52% / -2.23% / +8.13% |
| atomic-required/delete/small/1 | +4.68% / +10.06% / -4.46% | -6.61% / -18.00% / +7.07% |

## Correctness and provenance

- PostgreSQL integration tests: 16 suites / 124 tests passed, including atomic rollback cases.
- All 180 benchmark blocks passed their business/audit row, actor/tenant, redaction and other
  correctness assertions. Both benchmark schemas were removed successfully.
- An independent audit recomputed every scenario metric from raw samples; results matched the
  summaries. P95/P99 use nearest-rank percentiles within each block, followed by paired ratio medians.
- Frozen hashes for 59 source/configuration files and 208 build files matched after both runs.
- Base revision: 0f4d56b3d61bdb1a27c63c48d8e49e39fdbc4690. This is an uncommitted working tree;
  the base revision alone does not identify the candidate.
- Candidate integrity: sha512-KdFzm/2XV88KKrzWN41SIPjOR4Dw3K2w8Mi9oHFYGayH/BaxbCW/OjggsMmYFjaRxSRxPH3U+NPd1wO9ID3v/g==
- Baseline integrity: sha512-TePjZu54blkfovAuwMZoisofZ6qD40aEzxHzsgZBbheHJqqdd4GpSS8wPA7tVRQ33Jvq7AROeUqWY9NggTcEew==
- The validation PostgreSQL container and compose network were removed after the confirmation.

The initial package evidence has status failed because the performance comparator returned 1;
package installation and integrity verification succeeded. Raw benchmark correctness status and
performance gate status are recorded separately.

## Evidence and next investigation

Local evidence is retained in [the results directory](../benchmarks/results/formal-quality-2026-10-26/):
budget.json, source-evidence.json, dist-sha256.json, postgres-image.json,
e2e-results.json, decision.json, and each run's raw.json, summary.json,
package-evidence.json and p99-warnings.json. Generated raw evidence is ignored by Git;
the report and budget remain repository files. A SHA-256 manifest records the evidence files.

The current evidence establishes neither a reproducible code regression nor a clean performance
pass. Focus the next investigation on automatic create: predeclare a finite A/A comparison using
the same package in both slots, balance execution ordering, and correlate block timestamps with
Node GC/event-loop and PostgreSQL commit/checkpoint waits on a fixed runner. These measurements
are needed before attributing the discrepancy to runtime noise or candidate cost.

The [subsequent cause investigation](2026-10-26-performance-cause-investigation.md) completed the
original-harness A/A calibration and eight bounded diagnostic phases. It found large individual
differences with identical packages and mainly client-side differences in the instrumented slow
blocks. It did not establish the first formal failure's single cause or reproduce a stable
candidate-specific regression. That investigation preserved this run's **inconclusive** outcome.
The later [controlled resolution](2026-10-26-performance-resolution.md) approves the seven named
local scenarios using the original six passing scenarios and a replacement automatic-create
measurement; it does not rewrite this historical result or certify the original full sequence.
