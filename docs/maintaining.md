# Maintaining and releasing audit-log

Documents development, verification, and publication procedures for version `0.7.1`.
Start with the [README](../README.md); see [CHANGELOG](../CHANGELOG.md) for version changes.
The [0.7.1 release notes](releases/0.7.1.md) describe SQL Server support, validation, and current limits.

## Published ecosystem release gate

The consumer-owned PostgreSQL gate in `fixtures/published-ecosystem` verifies the
[exact published tuple listed in the README](../README.md#tested-ecosystem-versions) through public
package APIs. That tuple records the coordinated release gate, not the full peer-support matrix.
The fixture owns an independent manifest and lockfile, uses exact versions only, and prints each registry URL and
SHA-512 integrity before testing transaction commit/rollback, soft-delete, restore, purge, and
cascade evidence. The runner copies the fixture outside the repository and performs a fresh
`npm ci`, so root or sibling dependencies cannot satisfy a missing package. CI first runs the
published tuple, then installs the current checkout's real `npm pack --json` audit-log tarball with
the compatible soft-delete 0.7.4 companion and repeats the same tests. A separate explicit
tenancy-candidate mode replaces only tenancy with a caller-supplied `0.16.x` `.tgz`;
audit-log and soft-delete remain registry artifacts. All
three modes use strict peer installation and assert each package's installed version, source, and
SHA-512 integrity. Tag publishing cannot start until the audit-log candidate gate passes.

The release workflow also requires the reusable MSSQL preflight workflow. It tests the driver
baseline and packed audit-log candidate on SQL Server 2025 with Prisma 7.10.0 before publication.
Both the PostgreSQL ecosystem gate and MSSQL gate must succeed before the publishing job starts.

Do not make this fixture follow `latest`, a semver range, a workspace, or a sibling checkout. After
one of the three packages is published, update the manifest, lockfile, the README tuple, and registry
integrity evidence together in a dedicated tuple-bump PR. A coordinated unreleased package may be
substituted only as an explicitly supplied packed tarball.

## Development

### Prerequisites

- Node.js 22.13+ within the 22.x line, or Node.js 24.x
- Docker (for E2E tests)

### Setup

```bash
npm ci
npm run build
```

### Candidate documentation example

The consumer Quick Start pins the documented version `@nestarc/audit-log@0.7.1`.
To exercise local changes instead of the registry artifact, build and pack explicitly in the repository:

```sh
npm ci
npm run build
npm pack --pack-destination /tmp
```

Copy `examples/quick-start` into a separate writable directory, then install the emitted artifact there:

```sh
npm install --save-exact /tmp/nestarc-audit-log-0.7.1.tgz --strict-peer-deps
cp .env.example .env
# Set DATABASE_URL to a disposable local PostgreSQL database/schema.
npm run db:setup
npm run smoke:manual
npm run smoke
```

The filename reflects the 0.7.1 manifest; a local tarball is not proof of npm publication.
Record integrity and origin when sharing evidence. Both the packed and
registry consumer gates run the released 0.7.0 policy scenarios in addition to the basic smokes.
The [adoption guide](adoption-guide.md) explains these contracts.
This example uses PostgreSQL. For the manual SQL Server APIs, use the existing client
and module configuration in the [SQL Server guide](sql-server.md).

### Run tests

```bash
# Static quality gates
npm run lint
npm run typecheck

# Unit tests
npm test

# One-command E2E (waits for PostgreSQL and always runs teardown)
npm run test:e2e:full

# Manual lifecycle for keeping PostgreSQL running between commands
npm run test:e2e:setup
npm run test:e2e
npm run test:e2e:teardown

# Packed README consumer (uses an isolated schema in the local audit_test database)
npm run docker:up -- --wait --wait-timeout 60
npm run test:docs:consumer
# After the pinned version is available from npm, verify its registry artifact
npm run test:docs:consumer -- --registry

# Published ecosystem tuple and explicit packed candidates
npm run test:e2e:ecosystem
npm run test:e2e:ecosystem:candidate
npm run test:e2e:ecosystem:tenancy-candidate -- \
  --tenancy-tarball /absolute/path/to/nestarc-tenancy-0.16.0.tgz
npm run docker:down
```

`test:e2e:full` runs teardown after success, test failure, or an interrupt. The individual
setup, test, and teardown commands remain available for debugging;
`test:e2e:setup` intentionally leaves PostgreSQL running until teardown.

The documentation consumer gate packs this checkout, verifies the shipped guide/example files,
extracts the example from that tarball, installs into an isolated temporary project with strict peers,
then generates Prisma,
applies schema setup, compiles, and runs the manual-only and HTTP/role/actor/redaction/rollback smoke tests.
Both modes also compile/run the [0.7.0 adoption assertions](adoption-guide.md#adoption-assertions-070),
including real audit INSERT fault injection in that isolated schema. CI and the pre-publish release
workflow run the packed gate. After publication, the optional `--registry` mode installs the example
manifest's exact version from npm and runs the same assertions; output
records mode, version, resolved artifact and integrity. It uses only a
local database named `audit_test` (default port `5433`), creates a unique schema, and removes its own
schema and temporary project in teardown. It does not start or stop PostgreSQL for you.

The audit-log candidate mode installs exact `@nestarc/soft-delete@0.7.4` in its temporary
consumer to satisfy audit-log 0.7's peer contract. The checked-in published tuple remains
unchanged at soft-delete 0.7.3 and audit-log 0.5.0. Both modes require a valid full peer graph.

## 0.7.1 verification and publication

Version 0.7.1 keeps the existing soft-delete 0.7.4 peer range compatible while adding opt-in manual
SQL Server logging. Keep the checked-in published ecosystem fixture unchanged during release
preparation. A versioned source document or dated changelog entry describes the target package;
it does not establish that the registry artifact exists.

1. Before creating a release tag, finalize the package and lockfile version, dated changelog entry,
   README, usage guides, release notes, Quick Start dependency pin, and documentation-test
   expectations together. The files inside the npm tarball must describe the target version's
   installation and APIs without candidate-only or local-pack-only instructions. Updating the
   repository after publication does not change an existing registry tarball.
2. Verify that exact commit with the full CI matrix, packed documentation consumer, published and
   packed ecosystem suites, and MSSQL preflight. Inspect the actual package for declarations,
   linked guides, examples, and benchmark evidence. Run PostgreSQL regression and SQL Server
   manual logging performance checks; record the commit, runtime, database, workload, sample
   count, latency, throughput, and raw measurements in [benchmarks](benchmarks.md). Correctness
   probes alone do not establish performance.
3. Publish only after explicit authorization. Confirm the intended commit is on `main` and its
   checks are successful, then create the matching `v<package-version>` tag. A tag triggers the
   release workflow, whose PostgreSQL ecosystem and MSSQL gates must pass before the publishing
   job runs. That job verifies the tag/version and main ancestry, reruns its validation, and
   publishes to npm before creating the GitHub Release.
4. After npm publication succeeds, run `npm run test:docs:consumer -- --registry` against the
   example's exact version and verify its registry origin and integrity. Record the publication
   outcome in the release or PR. Update a coordinated published ecosystem tuple in a separate
   PR with its lockfile and integrity evidence. Update and deploy the separate documentation
   site, then verify its public pages against the registry package.

## 0.7.0 publication and external documentation checklist

- [x] Implement N05 packed candidate policy/tenant/exclusion assertions and wire them into CI/release.
- [x] Confirm remote CI, the full peer matrix and ecosystem release gates for the release commit.
- [x] Publish 0.7.0 and verify the actual registry artifact with compilation and smoke assertions.
- [x] Update the Quick Start pin and current usage guides for published 0.7.0, including registry adoption assertions.
- [ ] Update the published ecosystem exact tuple and its lockfile with coordinated registry evidence.
- [ ] Update the separate documentation-site repository, including its version selector and adoption links.
- [ ] Deploy that site and verify its public pages against the published package.

Repository documentation changes alone do not complete the site update or deployment.
