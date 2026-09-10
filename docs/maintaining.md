# Maintaining and releasing audit-log

Applies to the current checkout. Start with the [README](../README.md);
see [CHANGELOG](../CHANGELOG.md) for released and unreleased differences.

## Published ecosystem release gate

The consumer-owned PostgreSQL gate in `fixtures/published-ecosystem` verifies the
[exact published tuple listed in the README](../README.md#tested-ecosystem-versions) through public
package APIs. That tuple records the coordinated release gate, not the full peer-support matrix.
The fixture owns an independent manifest and lockfile, uses exact versions only, and prints each registry URL and
SHA-512 integrity before testing transaction commit/rollback, soft-delete, restore, purge, and
cascade evidence. The runner copies the fixture outside the repository and performs a fresh
`npm ci`, so root or sibling dependencies cannot satisfy a missing package. CI first runs the
published tuple, then replaces only audit-log with the current checkout's real `npm pack --json`
tarball and repeats the same tests. A separate explicit tenancy-candidate mode replaces only tenancy
with a caller-supplied `0.16.x` `.tgz`; audit-log and soft-delete remain registry artifacts. All
three modes use strict peer installation and assert each package's installed version, source, and
SHA-512 integrity. Tag publishing cannot start until the audit-log candidate gate passes.

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
installs the tarball into an isolated temporary project with strict peers, then generates Prisma,
applies schema setup, compiles, and runs the HTTP/actor/redaction/rollback smoke test. It uses only a
local database named `audit_test` (default port `5433`), creates a unique schema, and removes its own
schema and temporary project in teardown. It does not start or stop PostgreSQL for you.
