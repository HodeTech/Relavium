# ADR-0121: Pre-1.0 releases publish the smoke-verified package-test tarball

- **Status**: Proposed
- **Date**: 2026-11-05
- **Related**: [ADR-0051](0051-cli-distribution-thin-bundle-private-engine.md), [ADR-0067](0067-node-supported-floor-22-reaffirm-better-sqlite3.md), [ADR-0111](0111-cli-meta-operations-use-a-lazy-packaged-runtime.md) (partially superseded for pre-1.0 versions), [D59, D70](../roadmap/current.md#wave-gating-decisions), [MVP-10, MVP-A23](../roadmap/phases/phase-2.6-conversational-authoring.md#cli-mvp-additions--2026-11-04), [release runbook](../runbooks/release-a-surface.md)

## Context

### Today's release path

[ADR-0111](0111-cli-meta-operations-use-a-lazy-packaged-runtime.md) made release
debugging material a custody matter:

- External TypeScript maps are emitted only in a fresh candidate build.
- They are encrypted to a production GnuPG recipient and archived.
- They are bound to the exact tarball by a release binding receipt.
- They are published through a trusted-tag custody graph.

It states that "missing custody cannot downgrade to test mode" and that a
package-test artifact is never promoted.

Building that graph is Wave 3 Step 9c (XL) and 9d (L). The production recipient
is Wave 4b. Until they land, Step 9a.1's interim guard refuses every artifact in
the `publish` job, and has done so on `main` since PR #96. Nothing newer than
`0.1.1` can ship.

### The MVP ruling

On 2026-10-26 the maintainer put the CLI MVP first. On 2026-11-04 the
maintainer ruled D59, release path B:

- Pre-1.0 releases publish the smoke-verified package-test tarball from a
  trusted `v*` tag on `main` with a green `ci` at that commit.
- They carry no archived encrypted maps.
- Custody becomes mandatory again at 1.0 or when 9c/9d land, whichever comes
  first.
- The guard stays in force until this ADR is Accepted and its guard change
  passes a security sitting.

D70 adds that there is no npm pre-release before v0.2.0.

### What already holds for every artifact

The release workflow already:

- builds once and packs once;
- smokes **that same tarball** on Ubuntu, macOS, Windows and the Node 22.0.0
  floor;
- asserts that the ref is reachable from `main`;
- publishes only on a pushed tag, never on a dispatch;
- names a `release` deployment environment for `publish`.

The npm token is still a repository-level secret. MVP-A23 requires this ADR to
choose between npm trusted publishing and an environment-scoped token.

## Decision

**For versions below 1.0.0, the `publish` job may publish the package-test
tarball the smoke matrix proved, under the admission rules below. The custody
graph is not required for those versions, and only for those versions.
Publication authenticates through npm trusted publishing. The repository-level
token is deleted.**

### 1. Admission

The guard is replaced by an **admission check** that keeps the guard's shape:

- The entry point sets a failing exit code before it evaluates anything.
- It reads metadata, never executes artifact content.
- It admits only on **positive proof of every condition**.

| # | Condition | Proven by |
|---|-----------|-----------|
| 1 | The run is a pushed `v*` tag, not a dispatch | Workflow event and ref (unchanged) |
| 2 | The tag's commit is reachable from `main` | `pack`'s ancestry assertion (unchanged), re-read from the job outputs |
| 3 | `ci` concluded **success** for that exact commit | The checks API, read-only, at publish time; pending, missing or any other conclusion refuses |
| 4 | The artifact is the one `packed-cli` aggregated as passing on every OS and on the Node floor | The package-test receipt and the aggregate job's outputs |
| 5 | The tarball's `package.json` version equals the tag's version, and is **below 1.0.0** with no pre-release identifier | The packed manifest, read from the tarball |
| 6 | The tarball contains no source map and no map-link trailer ([ADR-0051](0051-cli-distribution-thin-bundle-private-engine.md)) | A scan of tarball entry names and the entry chunk's final bytes |
| 7 | No release binding receipt is present | Directory entries. A custody-shaped artifact belongs to 9d's validator, which does not exist yet; refusing it keeps the two paths from mixing |

Any condition that cannot be evaluated refuses with a fixed code. The exact
codes, inputs and receipt fields live in
[packaging.md](../reference/cli/packaging.md); the procedure lives in the
release runbook.

### 2. The sunset is mechanical

- **At 1.0.** Condition 5 refuses 1.0.0 and above, so the pre-1.0 path cannot
  publish a 1.x version even if 9c/9d never land.
- **When 9d lands.** Step 9d's custody validator **replaces** this admission
  check rather than sitting beside it. Its change removes package-test admission
  outright, so custody is mandatory for every later version, pre-1.0 or not.
- **Recorded.** [current.md](../roadmap/current.md) records the sunset beside
  the Publication row.

### 3. What ADR-0111 loses, and only for pre-1.0 versions

This ADR **partially supersedes ADR-0111** for versions below 1.0.0. Two
statements stop applying to them:

- "missing custody cannot downgrade to test mode";
- "a package-test artifact is not promoted".

For those versions there is no archived ciphertext of the original maps. A
stack trace from a pre-1.0 release is symbolicated only by rebuilding the tag,
on a best-effort basis.

ADR-0111's lazy runtime, its build and pack rules, its no-maps-in-the-package
rule and its whole custody design stay in force and become mandatory again at
the sunset. ADR-0111 gets a dated amendment note pointing here.

### 4. The publish credential

Publication uses **npm trusted publishing (OIDC)**. The npm package trusts
exactly:

- this repository;
- the `release.yml` workflow;
- the `release` environment.

The `release` environment is restricted to `v*` tags and requires the
maintainer's review, which makes it a second human gate after tag creation.

Provenance stays on. The repository-level `NPM_TOKEN` secret is **deleted** once
trusted publishing has been verified. No long-lived publish token remains.

The considered alternative, an environment-scoped `NPM_TOKEN` with a required
reviewer, was rejected. It keeps a long-lived token that can leak from any job
that later gains the environment. If trusted publishing cannot be configured for
the package, that alternative is the fallback, and the choice is recorded with
MVP-A23.

**Maintainer actions.** These are not this ADR's code:

- configuring the trusted publisher on npm;
- creating the environment's reviewer and its tag policy;
- deleting the secret;
- tagging.

### 5. Security sitting

The admission change ships only after a dedicated security sitting, as D59
requires. The sitting covers:

- each condition's proof;
- the event and ref spoofing paths (dispatch, re-runs, a tag moved after `ci`);
- the checks-API read: which workflow, which commit, which conclusion;
- the trusted-publisher binding;
- what a failure leaves behind, for example a partial publish or a re-run of
  the same version.

### Alternatives considered

- **Path A: build 9c/9d and the Wave 4b recipient first.** Rejected by D59. It
  takes about 4–6 weeks and would sit on the MVP's critical path.
- **B2: lightweight custody**, encrypting and archiving the maps once without
  9c's validator. Rejected by D59. It is a partial custody graph whose
  guarantees nobody verifies.
- **C: ship from source or a GitHub Release tarball only.** Rejected by D59. An
  `npm i -g` user is who the MVP is for.
- **Allow pre-release tags (`-rc`, `-beta`).** Rejected by D70, and by
  condition 5.

## Consequences

### Positive

- v0.2.0 can ship on the MVP's schedule from exactly the bytes the cross-OS
  smoke proved, with provenance, `main` ancestry and a green `ci` checked at
  publish time.
- The sunset cannot be forgotten. It is enforced by the version check and by
  9d's replacement of the check.
- No long-lived npm token remains anywhere.

### Negative

- Pre-1.0 releases have no archived maps, so symbolicating their crash reports
  depends on rebuilding the tag.
- The publish job gains a checks-API read and a tarball scan. Both are new code
  on the release path and need tests and the security sitting.
- Trusted publishing ties publication to npm's OIDC trust configuration, which
  lives outside this repository. Its correctness is verified operationally, not
  by CI.
