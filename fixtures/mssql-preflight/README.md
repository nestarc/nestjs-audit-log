# SQL Server 2025 and Prisma 7.10.0 preflight

This isolated fixture tests SQL Server and driver assumptions, then verifies the packed `@nestarc/audit-log` candidate's manual logging and schema installation. `probe.mjs` remains the independent driver baseline; `library-probe.mjs` imports the installed package and exercises its public API.

The probes use real Prisma model writes and parameterized raw audit inserts to check:

- Business and audit rows commit together, and both roll back after business errors or audit CHECK failures.
- Unicode JSON round-trips at 3,999, 4,000, 4,001, 8,001 and 65,536 UTF-16 code units, plus SQL NULL.
- Separate table and UPDATE/DELETE trigger batches execute through Prisma. Multi-row modification fails without changing rows; zero-row statements are explicitly allowed.
- Trigger errors, repeated constraint failures and an interactive transaction timeout roll back correctly and allow subsequent transactions through a pool limited to two connections.

Each expected SQL failure is checked for its intended cause as well as the final row state. A network error cannot count as a successful rollback probe.

## Run

Use Node 24 and a disposable SQL Server 2025 test server. The bootstrap account needs permission to create and drop databases; the least-privilege smoke additionally creates and removes SQL logins and database users. The runner always generates a new `audit_preflight_<random>` database, applies only the fixture schema and removes that database in its cleanup path. It does not use a caller-provided database name. Abrupt termination of the runner itself can leave the generated database or smoke logins behind; their names are recorded in the reports.

```sh
cd fixtures/mssql-preflight
npm ci --no-audit --no-fund
export MSSQL_HOST=127.0.0.1
export MSSQL_PORT=1433
export MSSQL_USER=sa
read -rs MSSQL_PASSWORD
export MSSQL_PASSWORD
npm test
```

The connection uses encryption with `trustServerCertificate: true` for this isolated test environment. Hostnames and IPv4 addresses are accepted; credentials containing braces or control characters are rejected because the fixture uses Prisma's URL parser for CLI commands. Passwords and connection URLs are omitted or redacted from reports and child command output.

The runner performs package checks, client generation, a bounded SQL readiness check, server version verification, database creation, `prisma db push`, the probes, and cleanup. No separate SQL installation command is needed after the server is running.

To run the library integration probe, build and pack the repository root, install that tarball into this fixture with `npm install --no-save --package-lock=false <tarball>`, then run:

```sh
MSSQL_PROBE=library-probe.mjs MSSQL_REPORT_PATH=results/library/report.json npm test
```

The library probe verifies module registration, configuration propagation, DDL reapplication, manual commit/rollback, context policies, long values, append-only triggers, and rejection of unsupported APIs. It rejects a symlinked source checkout so the test exercises the distributable package. CI builds and installs this tarball automatically.

After installing the same tarball, run the separate-identity smoke with:

```sh
MSSQL_PROBE=least-privilege-probe.mjs MSSQL_REPORT_PATH=results/least-privilege/report.json npm test
```

Its ten probes connect through two generated SQL logins. The installer receives database `CONNECT` and `CREATE TABLE`, plus `ALTER` on a dedicated schema owned by `dbo`. The runtime receives `CONNECT`, business-table `INSERT`/`SELECT`, and audit-table `INSERT` only. The smoke checks actual login/user identity, absence of elevated role membership, and effective permissions before exercising the packed public API.

The restricted runtime must commit and roll back business/audit pairs together, recover after an audit constraint failure, and perform a standalone audit insert. Audit reads, UPDATE, DELETE, TRUNCATE, ALTER, DROP, trigger disabling, and new audit-table installation must fail with permission errors. Administrator queries independently confirm rows, columns and enabled triggers are unchanged. See the [SQL Server permissions guide](../../docs/sql-server.md#separate-installation-and-runtime-identities).

Passwords are random per invocation and never saved in the reports. The child closes restricted connections and removes only its generated users/logins, checking their SIDs. The runner also checks the two exact login names were absent before starting the child and removes any remaining ones after dropping its database, including after a child failure or timeout. This fallback still requires the runner to reach its cleanup block.

## Reproducibility and evidence

Prisma CLI, client and MSSQL adapter are exactly `7.10.0`; `mssql` is exactly `12.2.0`. The committed lockfile fixes the remaining dependency graph. The report also records the adapter's resolved `tedious` version and generated-client version.

The dedicated [GitHub Actions workflow](../../.github/workflows/mssql-preflight.yml) uses Node `24.11.1`, an x64 Ubuntu 24.04 runner and `mcr.microsoft.com/mssql/server:2025-CU10-ubuntu-24.04`. It checks the pulled image architecture and records its actual digest. The server port is bound only to loopback. A random password is generated for each run and masked in CI logs; credentials are not committed to the repository. The container is removed after the run.

Results are written under `results/` and uploaded by CI even when probes fail:

- `report.json`: individual probe outcomes, timings, row counts, package/server versions and sanitized error codes.
- `runner-report.json`: setup steps and database cleanup outcome.
- `image.json`: image identity, digest and architecture from the actual container.
- `sqlserver.log`: server diagnostic log from CI.
- `library/report.json` and `library/runner-report.json`: packed-library outcomes and isolated database cleanup.
- `least-privilege/report.json` and `least-privilege/runner-report.json`: separate-identity outcomes, effective grants, denied-operation evidence, and user/login/database cleanup.

`MSSQL_REPORT_PATH` can choose a different probe report path; the runner report is written beside it. Keep the image digest with results when reproducing a run because a tag alone is not immutable.

Driver and general library probes use the administrative test account. The additional smoke verifies the specific restricted installer/runtime grants above, not every production identity, authentication method, permission arrangement or SQL Server 2025 build. MSSQL query, automatic tracking and retention APIs remain unsupported and are checked for explicit rejection.
