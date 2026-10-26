# Audit log product quality implementation

This work extends the 0.7.1 implementation with safer manual transactions, consistent diagnostics,
SQL Server history queries and operational guidance. New functionality remains unreleased until
its candidate package and database checks pass. Existing published recipes remain executable with 0.7.1.

## Scope and acceptance

| Work | Acceptance |
|---|---|
| Manual diagnostics | Every rejected manual stage reports once; original errors and transaction results survive throwing or rejecting observers; timing distinguishes INSERT from commit |
| Managed manual transactions | A bound writer uses the callback transaction, caught audit errors prevent commit, started writes finish before completion, expired writers reject, concurrent scopes remain isolated |
| Strict manual inputs | Opt-in nonblank identifiers and actions, JSON validation with field paths, explicit metadata byte budget without truncation; old defaults preserved |
| SQL Server queries | Tenant and target filtering, ID lookup, full precision keyset cursors, JSON and UTC normalization, full-value filtering with optional additive read indexes |
| Storage inspection | Read-only findings distinguish visible storage problems from insufficient inspection permissions; installer and runtime identities remain separate |
| Adoption | Three documented entry paths, shared factory configuration, standalone published SQL Server example with commit/rollback and authorized history assertions |
| Performance | Runtime changes trigger measurement; baseline and explicit calibrated budgets are configurable; raw measurements and historical provenance retained |

## Delivery boundaries

Automatic SQL Server tracking, scan/export, automatic retention and arbitrary schema conversion
remain future extensions. This change adds operational recipes for capacity, backup, retention
planning and recovery without weakening append-only enforcement. Customer usability timing and
production latency targets require observation in a representative environment.

## Verification

Validation on 2026-10-26 used Node 24.22.1 on macOS arm64. The candidate is the working tree on
`codex/product-quality`, based on `0f4d56b3d61bdb1a27c63c48d8e49e39fdbc4690`. Its manifest remains
0.7.1, but its tarball is distinct from published 0.7.1; the new APIs are explicitly Unreleased.

| Check | Result |
|---|---|
| ESLint, TypeScript declarations/type assertions, build | Passed |
| Unit/regression tests | 37 suites / 732 tests; line coverage 95.83%, branch coverage 89.96% |
| PostgreSQL integration | 16 suites / 124 tests, including 7 managed manual transaction cases |
| SQL Server driver probes | 10/10 passed |
| SQL Server candidate library probes | 22/22 passed, including reads, precise cursor/GUID ordering, strict inputs, caught-failure rollback, indexes and new-pool writes |
| SQL Server separate installer/runtime permissions | 10/10 passed |
| SQL Server published 0.7.1 example | Both direct and tracked CI probe passed: strict installation/integrity, migration, generation, build, commit/rollback, actor/tenant policy, redaction, Unicode and authorized history |
| PostgreSQL packed candidate consumer | Install, migrations, build, manual/automatic/adoption smoke and new API smoke passed |
| PostgreSQL registry 0.7.1 consumer | Existing manual/automatic/adoption paths passed; candidate-only APIs excluded |

The packed consumer compiles real generated Prisma model arguments, selected return types and
transaction callback results against public declarations. It also verifies caught validation
failures roll back earlier business/audit writes, and rejected diagnostic promises do not affect
the transaction or leak identifiers through the operation event.

SQL Server used the dedicated Docker image `mcr.microsoft.com/mssql/server:2025-CU10-ubuntu-24.04`
under linux/amd64 emulation on the arm64 host, with Prisma/adapter 7.10.0. This is real database
functional evidence, not native Linux x64 performance evidence. The existing native CI workflow
remains the release check.

The live run exposed and corrected the new example's migration lock: Prisma 7.10 uses canonical
`mssql` in the lock while the schema provider remains `sqlserver`. It also confirmed that Prisma
7.10 rejects `Snapshot` isolation before invoking a transaction callback. The helper forwards the
requested level without silently downgrading it; the documented support depends on runtime,
adapter and database. Positive ReadCommitted commit and negative Snapshot/no-side-effects probes
both pass.

The new example probe is included in the SQL Server CI workflow and runs the packaged example
with its published dependency. The final candidate passed the 22 SQL Server library probes again;
the seven PostgreSQL managed-transaction cases were also rerun after the final timing change.
All generated databases, restricted principals, temporary consumers, both test containers and the
SQL Server temporary credentials were removed successfully.

## Performance evidence and limits

Three local runs compared installed registry 0.7.1 with the packed candidate. Each run used 50
warmups, 500 measured operations per block, four paired repeats and seven comparison scenarios;
all 72 correctness/cleanup blocks passed in each run. Reports remain advisory because no calibrated
environment-specific budget was supplied.

The first run's small/manual/concurrency-1 P99 median ratio was 1.615x; a second run of the same
candidate produced 0.950x, so that signal did not reproduce. Other tail measurements varied too.
The final code avoids clock reads and operation-event allocation when no observer requires them.
This removes unnecessary disabled-instrumentation work; it is not evidence that it caused or
resolved the initial P99 signal.

Final candidate/baseline paired ratio medians:

| Scenario | Mean | P95 | P99 |
|---|---:|---:|---:|
| Manual small, concurrency 1 | 0.983x | 1.001x | 0.907x |
| Manual small, concurrency 4 | 0.989x | 0.953x | 1.072x |
| Manual 64 KiB, concurrency 1 | 0.986x | 0.976x | 1.004x |
| Manual 64 KiB, concurrency 4 | 1.017x | 1.023x | 0.940x |
| Automatic create | 0.967x | 0.899x | 0.814x |
| Automatic update | 0.971x | 0.943x | 0.931x |
| Automatic delete | 1.034x | 1.025x | 1.080x |

Local evidence is retained under `benchmarks/results/` as
`postgresql-manual-regression-quality-run-{1,2}.json`,
`postgresql-manual-regression-quality-final.json`, matching
`postgresql-performance-summary-quality-*.json` and `package-evidence-quality-*.json`.
SQL Server evidence is under `fixtures/mssql-preflight/results/product-quality-{driver,library,least,ci-example}/`.
These generated reports are ignored by Git; CI uploads its reproducible reports as artifacts.
Package integrity distinguishes candidates even while their manifest still says 0.7.1.

These shared-host Docker measurements do not establish statistical significance, production
latency, index plan quality at customer scale, or a universal regression threshold. Native CI and
calibrating performance budgets on representative infrastructure remain release validation work.

Status: implementation and local validation complete; not published.

## Formal performance follow up

The [formal revalidation](2026-10-26-formal-performance-validation.md) used 1,000 measured
operations per block and five paired repeats under the agreed mean/P95/throughput limits.
The initial run failed automatic-create mean and P95 limits; its one confirmation passed.
The same candidate artifact was used throughout. Under the predefined disagreement rule,
that formal run's performance decision was **inconclusive and on hold**. Functional validation passed.

The [cause investigation](2026-10-26-performance-cause-investigation.md) added an instrumented
automatic-create diagnostic and completed A/A, A/B, workload-prelude and connection-retention
comparisons against the frozen artifacts. Identical packages showed large individual differences;
the observed slow blocks mainly differed outside recorded server execution. The exact cause of
the first formal failure remained unconfirmed at that stage.

The [controlled resolution](2026-10-26-performance-resolution.md) replaced the automatic-create
measurement under a protocol declared before 32 independent process runs. A/A calibration and
A/B confidence-bound plus median checks passed without changing the mean/P95/throughput limits.
Together with the six scenarios that passed both original formal runs, the seven individually
defined **local PostgreSQL performance scenarios are approved**. Historical full-sequence
sensitivity remains documented; this does not certify production or SQL Server performance.
