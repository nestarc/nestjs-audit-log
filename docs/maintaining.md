# Maintaining and releasing audit-log

Documents development, verification, and publication procedures for version `0.8.0`.
Start with the [README](../README.md); see [CHANGELOG](../CHANGELOG.md) for version changes.
The [0.8.0 release notes](releases/0.8.0.md) describe the new APIs, validation, and current limits.

<a id="published-ecosystem-release-gate"></a>

## Optional ecosystem compatibility

The consumer-owned PostgreSQL fixture in `fixtures/published-ecosystem` verifies the
[exact published tuple listed in the README](../README.md#tested-ecosystem-versions) through public
package APIs. That tuple records a coordinated integration result, not the full peer-support matrix.
The fixture owns an independent manifest and lockfile, uses exact versions only, and prints each registry URL and
SHA-512 integrity before testing transaction commit/rollback, soft-delete, restore, purge, and
cascade evidence. The runner copies the fixture outside the repository and performs a fresh
`npm ci`, so root or sibling dependencies cannot satisfy a missing package.

The manual-only workflow `.github/workflows/ecosystem-compatibility.yml` offers `published` and
`audit-log-candidate` modes. Published mode checks the unchanged tenancy 0.15.0 / audit-log 0.5.0 /
soft-delete 0.7.3 tuple. Candidate mode installs the current checkout's real `npm pack --json`
audit-log tarball and requires `soft_delete_version`: a canonical exact stable version (`X.Y.Z`)
published in the npm registry. The CLI likewise requires `--soft-delete-version`; it has no default
companion and does not accept tags, ranges or prereleases. A separate explicit CLI
tenancy-candidate mode replaces only tenancy with a caller-supplied `0.16.x` `.tgz`;
audit-log and soft-delete remain the fixture's registry artifacts. All three modes use strict peer
installation and assert each package's installed version, source and SHA-512 integrity.

Compatibility runs are optional to schedule, but their failures remain failures. Do not suppress
peer/install/assertion failures or bypass them with `--force` or `--legacy-peer-deps`. A tuple may
be described as supported only after its strict compatibility run passes. Soft-delete 0.7.4's
optional audit-log peer range, `^0.4.1 || ^0.5.0 || ^0.6.0 || ^0.7.0`, excludes audit-log 0.8.0;
that combination remains unsupported. It does not block standalone audit-log publication.

Standalone CI and tag publishing do not invoke or depend on this optional workflow. Core runtime,
build, type, unit/E2E, peer-matrix and packed documentation validation remain part of the package's
validation process. The release workflow still requires reusable MSSQL preflight, which tests the driver
baseline and packed audit-log candidate on SQL Server 2025 with Prisma 7.10.0 before publication.
Its SQL Server Quick Start check defaults to the packed candidate, avoiding a dependency on
the target version already existing in npm. Use `MSSQL_EXAMPLE_MODE=registry` only after publication.
The publishing job retains its core checks and depends on the MSSQL gate.

Do not make this fixture follow `latest`, a semver range, a workspace, or a sibling checkout. After
one of the three packages is published, update the manifest, lockfile, the README tuple, and registry
integrity evidence together in a dedicated tuple-bump PR. A coordinated unreleased package may be
substituted only through the audit-log or tenancy candidate mode's packed tarball; the selected
soft-delete companion remains an exact published registry artifact.

## Development

### Prerequisites

- Node.js 22.23.4+ within the 22.x line, or 24.22.1+ within the 24.x line
- Docker (for E2E tests)

CI pins Node 22.23.4 and 24.22.1 for its supported runtime lanes; release, MSSQL, and performance
jobs use 24.22.1. The runtime gate `node scripts/verify-node-security.cjs` checks the version floor,
rejection of the upstream CVE-2026-111497 malformed block-switch input through synchronous,
asynchronous, and fragmented Brotli decoding, and a valid Unicode Brotli round trip.
Workflow configuration describes the checks to execute; record their actual results for the
tested commit in the release or PR.

The version floor follows the [Node.js security release](https://nodejs.org/en/blog/vulnerability/october-2026-security-releases).
Package metadata does not upgrade a host or an already-running process. Update Node in development
and deployment environments, rebuild deployment artifacts or images, and restart workloads on the
patched runtime; changing npm dependencies alone is insufficient.

### Setup

```bash
node scripts/verify-node-security.cjs
npm ci
npm run build
```

### Candidate documentation example

The consumer Quick Start pins the documented version `@nestarc/audit-log@0.8.0`.
To exercise local changes instead of the registry artifact, build and pack explicitly in the repository:

```sh
npm ci
npm run build
npm pack --pack-destination /tmp
```

Copy `examples/quick-start` into a separate writable directory, then install the emitted artifact there:

```sh
npm install --save-exact /tmp/nestarc-audit-log-0.8.0.tgz --strict-peer-deps
cp .env.example .env
# Set DATABASE_URL to a disposable local PostgreSQL database/schema.
npm run db:setup
npm run smoke:manual
npm run smoke
```

The filename reflects the 0.8.0 manifest; a local tarball is not proof of npm publication.
Record integrity and origin when sharing evidence. Both the packed and
registry consumer gates run the 0.7.0 policy scenarios and 0.8.0 product-quality assertions
in addition to the basic smokes.
The [adoption guide](adoption-guide.md) explains these contracts.
This example uses PostgreSQL. For the manual SQL Server APIs, use the existing client
and module configuration in the [SQL Server guide](sql-server.md).

### Run tests

```bash
# Runtime version and Brotli regression checks
node scripts/verify-node-security.cjs

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

# Optional ecosystem compatibility: published tuple and explicitly selected candidates
npm run test:e2e:ecosystem
# Set SOFT_DELETE_VERSION to an exact published companion with a compatible audit-log peer range.
npm run test:e2e:ecosystem:candidate -- --soft-delete-version "$SOFT_DELETE_VERSION"
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
including real audit INSERT fault injection in that isolated schema, and the
[0.8.0 product-quality assertions](product-quality.md). CI and the pre-publish release
workflow run the packed gate. After publication, the optional `--registry` mode installs the example
manifest's exact version from npm and runs the same assertions; output
records mode, version, resolved artifact and integrity. It uses only a
local database named `audit_test` (default port `5433`), creates a unique schema, and removes its own
schema and temporary project in teardown. It does not start or stop PostgreSQL for you.

The checked-in published tuple remains unchanged at tenancy 0.15.0, soft-delete 0.7.3 and audit-log 0.5.0.
Every integration mode requires a valid full peer graph; an optional integration failure does not
turn into a standalone package release prerequisite.

<a id="071-verification-and-publication"></a>

## 0.8.0 verification and publication

Version 0.8.0 adds public APIs and can be released independently of optional soft-delete integration.
Validate a compatible companion separately before claiming support for a combined tuple. Keep the
checked-in published ecosystem fixture unchanged during release preparation. A versioned source
document or dated changelog entry describes the target package;
it does not establish that the registry artifact exists.

1. Before creating a release tag, finalize the package and lockfile version, dated changelog entry,
   README, usage guides, release notes, Quick Start dependency pin, and documentation-test
   expectations together. The files inside the npm tarball must describe the target version's
   installation and APIs without candidate-only or local-pack-only instructions. Updating the
   repository after publication does not change an existing registry tarball.
2. Verify the patched runtime with `node scripts/verify-node-security.cjs`, then verify that exact
   commit with the full standalone CI matrix, packed documentation consumer and MSSQL preflight.
   If claiming an ecosystem tuple, run its optional compatibility suite separately and retain
   the passing artifact/peer evidence. Inspect the actual package for declarations,
   linked guides, examples, and benchmark evidence. Run PostgreSQL regression and SQL Server
   manual logging performance checks; record the commit, runtime, database, workload, sample
   count, latency, throughput, and raw measurements in [benchmarks](benchmarks.md). Correctness
   probes alone do not establish performance.
3. Publish only after explicit authorization. Confirm the intended commit is on `main` and its
   checks are successful, then create the matching `v<package-version>` tag. A tag triggers the
   release workflow, whose MSSQL gate must pass before the publishing job runs. That job verifies
   the tag/version and main ancestry, reruns its core validation, and
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
