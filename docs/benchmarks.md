# Audit logging benchmark

These instructions apply to the `0.7.0` release checkout; see [CHANGELOG](../CHANGELOG.md) for version differences.
The recorded run below predates 0.7.0 and retains its original version context.

This benchmark measures sequential `User.create()`, `User.update()`, and `User.delete()` latency using the current local package sources. It measures four modes independently:

| Mode | Write path | Appropriate comparison |
| --- | --- | --- |
| `direct` | Base Prisma client, without audit | Baseline for direct writes |
| `transaction` | Base Prisma `$transaction()` callback, without audit | Baseline with the same transaction boundary as atomic auditing |
| `atomic-required` | Audited client, one mutation per `withAuditTransaction()` | Compare against `transaction` |
| `best-effort` | Audited client, direct mutation | Compare against `direct` |

The output reports each operation's mean, median, P95, and P99, plus mean differences for the corresponding baselines. Atomic timings include transaction creation and commit. `best-effort` has different failure guarantees; its latency is not evidence that it is interchangeable with atomic auditing. See [transaction contracts](transactions.md#transaction-model).

## Run it

Use the repository's disposable local PostgreSQL database. The script accepts only the test connection on `localhost` or `127.0.0.1`, port `5433`, database `audit_test`, with the checked-in test credentials. It rejects application database URLs before connecting.

From the repository root, with a supported Node.js version and Docker running:

```sh
npm ci
npm run test:e2e:setup
DATABASE_URL=postgresql://test:test@localhost:5433/audit_test npm run bench
npm run test:e2e:teardown
```

The setup command starts PostgreSQL, pushes the test Prisma schema, and generates the test client. Run the benchmark by itself, after other tests finish. Teardown removes the Docker container and its disposable database; run it even if the benchmark fails. Do not run teardown while another test is using that database.

The default is 30 warmup calls followed by 300 measured calls for each of the 12 operation/mode combinations. To change these counts:

```sh
BENCH_WARMUP=100 BENCH_ITERATIONS=1000 \
  DATABASE_URL=postgresql://test:test@localhost:5433/audit_test \
  npm run bench > /tmp/audit-log-benchmark.txt
```

Keep the complete output with any published result. It includes the package version, Git revision and modified-source status, Node.js and Prisma versions, generated-client mode, PostgreSQL version, host/OS/CPU, timestamp, warmup and measured counts, execution order, and unrounded JSON results. A package version printed from a modified checkout identifies the checkout's manifest; it is not proof that a published release produced those numbers.

## What the measurement includes

- Each call is awaited before the next starts; concurrency is one.
- All modes use the same model and input shape. Updates change both `name` and `email`; `password` is configured as sensitive.
- Input allocation, actor context setup, seed inserts, result checks, and fixture cleanup are outside the timer. The timer covers the awaited mutation and its transaction helper, when applicable.
- Updates and deletes use separately seeded rows. Each scenario warms up before measurement.
- After each scenario, the script verifies the expected automatic event action, source, and total count. Missing audit writes fail the run instead of producing a deceptively fast result.
- Business fixtures use unique IDs and are removed after the scenario. Append-only audit rows remain for inspection until database teardown; the script does not disable audit protections or delete unrelated rows.

## How to interpret results

These are local latency observations, not throughput measurements or a production performance guarantee. The benchmark uses small rows, one model, a local database, and one mutation per transaction. It does not model concurrent writers, a remote database, request handling, bulk changes, multiple writes per transaction, tenant resolution, large JSON diffs, retention, or streaming.

Modes run in a fixed order, and audit rows accumulate during a run. Warm caches, database growth, Docker scheduling, and other processes can affect the differences. Repeat the command against a fresh disposable database and preserve each run; report variability instead of selecting the fastest result. A delta between independently sampled modes is descriptive and does not establish statistical significance. P99 from the default 300 samples is especially sensitive to a few slow calls.

The previous README's `+1.10ms` create-overhead figure has been retired. Its script omitted the now-required consistency mode and did not measure `withAuditTransaction()`, so it is not current evidence for the recommended atomic path.

## Recorded local run — 2026-09-10

The [recorded JSON report](benchmarks/2026-09-10-local.json) contains the complete summary statistics
for one run of the modified checkout before the 0.6.0 version bump (the machine hostname is omitted). Node.js 24.11.1,
Prisma 7.9.1, PostgreSQL 16.15 in local Docker, Apple M1 Pro, concurrency one, 30 warmups and
300 measured calls per operation/mode were used. Audit evidence checks passed in all scenarios.

| Mode | Create mean | Update mean | Delete mean |
|---|---|---|---|
| Direct baseline | 0.61 ms | 0.56 ms | 0.43 ms |
| Transaction baseline | 1.16 ms | 1.13 ms | 1.13 ms |
| Atomic required | 2.30 ms | 3.63 ms | 2.95 ms |
| Best effort | 1.40 ms | 1.88 ms | 1.48 ms |

This is a single local verification run with modified sources, not a published 0.5.0 benchmark.
The Git revision and dirty flag are retained in the report. The small sequential workload and
single-run differences do not establish production throughput or a general overhead promise.
