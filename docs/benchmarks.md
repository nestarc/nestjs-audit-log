# Audit logging benchmark

The published Quick Start uses `0.7.0`; the new checks below evaluate the unreleased `0.7.1`
candidate. See [CHANGELOG](../CHANGELOG.md) for version differences. The existing local source
benchmark and recorded 2026-09-10 run remain below with their original commands and version context.

## 0.7.1 candidate performance checks

**Results pending.** The candidate adds two performance suites that use installed public package
entry points and verify the resulting database rows. PostgreSQL compares published audit-log
0.7.0 with the packed 0.7.1 candidate. SQL Server measures the candidate's manual audit overhead
against an otherwise equivalent business transaction without auditing.

| Suite | Workloads | Payloads and concurrency |
|---|---|---|
| PostgreSQL manual | One `User.create()` transaction without audit, with published 0.7.0 manual logging, or with candidate 0.7.1 manual logging | Small metadata and a metadata payload string of at least 65,536 UTF-8 bytes, approximately 64 KiB; concurrency 1 and 4 |
| PostgreSQL automatic | Published 0.7.0 versus candidate 0.7.1, one create, update, or delete per `atomic-required` transaction | The same small business rows; concurrency 1 |
| SQL Server manual | One `ProbeBusiness.create()` transaction without audit versus the same transaction with candidate `AuditService.log(input, tx)` | Complete redacted metadata JSON of 128 or 65,536 UTF-16 code units; concurrency 1 and 4 |

The SQL Server large JSON value occupies 131,072 bytes, or 128 KiB, in `NVARCHAR` storage.
It is not the same payload as PostgreSQL's approximately 64 KiB UTF-8 payload string.
PostgreSQL runs on PostgreSQL 16 with the repository's locked Prisma 7 dependencies; SQL Server
uses SQL Server 2025 CU10 and Prisma CLI, client, and MSSQL adapter 7.10.0. Both CI jobs use
Linux x64 Ubuntu 24.04 and Node 24.11.1, but run on separate hosted machines. These workloads,
payload definitions, drivers, and timing boundaries do not support a direct cross-database
latency or throughput ranking.

### Sampling and correctness

Each block uses 50 warmup transactions followed by 500 measured transactions, across four
repeats. The 500 samples are the block's total across its workers, not a per-worker count.
Both suites use a pool maximum of four connections. PostgreSQL runs the unaudited manual
control first, then alternates the baseline/candidate order `AB, BA, AB, BA` across repeats.
SQL Server uses transaction/manual-audit pair order `AB, BA, BA, AB`.

PostgreSQL per-operation latency includes actor context setup, pool acquisition, the business
write, audit work when enabled, and transaction commit. SQL Server starts its latency timer
inside the actor context and includes transaction acquisition, the business write, audit-call
input construction, policy checks, redaction, serialization, INSERT, and commit. Fixture and
metadata preparation, DDL, verification queries, and cleanup are outside both latency timers.
Throughput uses measured worker-batch wall time, including worker scheduling and actor context,
rather than the sum of individual latencies.

Reports preserve every measured latency and each repeat's mean, P50, P95, P99, and operations
per second. Row checks verify business outcomes, expected audit counts and actions, and
metadata/redaction where applicable. Missing or incorrect audit rows fail a run. PostgreSQL
uses a unique schema and removes it after disconnecting; the SQL Server runner creates and
removes a fresh disposable database. Both report cleanup outcomes. Preserve the package
version and artifact integrity, Git revision, runtime and database versions, workload settings,
raw measurements, and cleanup result with any published figures.

### Run through GitHub Actions

The `Database performance` workflow in `.github/workflows/performance.yml` runs on matching
benchmark or workflow changes in a pull request targeting `main`, and supports manual dispatch
when the workflow is available. A branch push alone does not trigger it. The workflow installs
dependencies, generates the PostgreSQL client, packs the candidate, and runs both suites.
Its SQL Server job reuses MSSQL preflight with `run_benchmark: true`, so driver and packed-library
correctness probes run before measurement. The standalone `MSSQL preflight` workflow also accepts
that boolean input for a manual run.

Download both jobs' artifacts. PostgreSQL writes package provenance to
`benchmarks/results/package-evidence.json` and measurements to
`benchmarks/results/postgresql-manual-regression.json`. SQL Server writes measurements to
`fixtures/mssql-preflight/results/benchmark/report.json`, with the runner's setup and cleanup
report beside it. Its artifact also includes image identity and the correctness probe reports.

### Reproduce PostgreSQL locally

Use Node 24, npm registry access, and Docker with the repository's disposable PostgreSQL test
database. Run from the repository root after other tests have finished:

```sh
npm ci
npm run docker:up -- --wait --wait-timeout 60
DATABASE_URL=postgresql://test:test@localhost:5433/audit_test npx prisma generate
BENCH_WARMUP=50 BENCH_ITERATIONS=500 BENCH_REPEATS=4 \
  DATABASE_URL=postgresql://test:test@localhost:5433/audit_test npm run bench:regression
npm run docker:down
```

Run teardown even after a failure, once no other test is using the database. The wrapper accepts
only the dedicated localhost `test:test` database `audit_test` on port 5432 or 5433. It installs
exact published 0.7.0 and the candidate tarball into separate temporary consumers with strict
peers, verifies registry/tarball integrity, and supplies both installed package paths to the
benchmark. It builds the candidate automatically and removes those consumers afterward. The
benchmark creates its own schema and business table; it does not require `prisma db push`.

### Reproduce SQL Server locally

Use Node 24, npm registry access, and a disposable SQL Server 2025 instance. The supplied test
account must be able to create, configure, and drop a database. The runner always chooses a new
database name; do not adapt this benchmark to an application database. The CI workflow starts
the Linux x64 CU10 container with a new random password and records the image digest. For a local
run, provide the password of your already-running test server without committing it:

```sh
npm ci
npm run build
npm pack --pack-destination /tmp
cd fixtures/mssql-preflight
npm ci --no-audit --no-fund
npm install --no-save --package-lock=false --no-audit --no-fund /tmp/nestarc-audit-log-0.7.1.tgz
export MSSQL_HOST=127.0.0.1 MSSQL_PORT=1433 MSSQL_USER=sa
read -rs MSSQL_PASSWORD
export MSSQL_PASSWORD
MSSQL_PROBE=manual-benchmark.mjs MSSQL_REPORT_PATH=results/benchmark/report.json \
  BENCH_WARMUP=50 BENCH_ITERATIONS=500 BENCH_REPEATS=4 npm test
```

The runner generates the exact 7.10.0 Prisma client, applies its fixture schema, and removes its
disposable database in cleanup. Stop a locally provisioned SQL Server container separately after
the run. Check both the benchmark and runner reports before accepting a result; an interrupted
process can prevent cleanup from finishing.

### Interpret candidate results

There is no universal latency or throughput threshold in these scripts. A successful result
means the workload completed with valid audit evidence and cleanup; it does not establish a
production service level or statistical significance. Compare paired baseline and candidate
observations within each suite, retain all repeats, and investigate changes rather than selecting
the fastest run. Candidate PostgreSQL changes should be assessed against published 0.7.0;
SQL Server deltas describe the added cost of manual auditing in that workload.

The workloads use closed-loop workers at fixed concurrency. They do not measure maximum server
capacity, remote database latency, long transactions, bulk writes, or production read/index
workloads. Audit rows accumulate, caches warm, and hosted-runner scheduling and database growth
can shift timings despite balanced ordering. P99 at 500 samples depends on about five tail
observations. Keep these limits alongside any eventual performance figures.

## Existing local source benchmark

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
