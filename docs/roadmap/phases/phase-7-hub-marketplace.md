# Phase 7 — Relavium Hub & Agent/Workflow Marketplace

> Status: Draft — **PRODUCT PHASE 2**, planned. Depends on Phase 1 (engine + CLI feature-complete),
> Phase 2.6 (child-session + nested workflows + standardized I/O), and the Relavium account
> infrastructure from Phase 5 (managed inference). This is a **draft for future planning**;
> detailed analysis and scoping will follow before the phase is committed.

- **Related**: [phase-6-cloud-execution-portal.md](phase-6-cloud-execution-portal.md),
  [phase-5-managed-inference.md](phase-5-managed-inference.md),
  [phase-2.6-conversational-authoring.md](phase-2.6-conversational-authoring.md),
  [../../reference/contracts/agent-yaml-spec.md](../../reference/contracts/agent-yaml-spec.md),
  [../../reference/contracts/workflow-yaml-spec.md](../../reference/contracts/workflow-yaml-spec.md),
  [../../decisions/0009-git-native-workflow-yaml.md](../../decisions/0009-git-native-workflow-yaml.md),
  [../../decisions/0012-managed-inference-dual-mode.md](../../decisions/0012-managed-inference-dual-mode.md)

The **Relavium Hub** is a web portal where users discover, install, publish, and share
agents and workflows — the community layer that turns Relavium from a solo tool into a
networked platform. It is the marketplace counterpart to the CLI's conversational authoring
and child-session orchestration: what you build and prove in the terminal, you can share
with your team or the world.

## Goal

Build a web-based marketplace where authenticated users can **browse** community agents and
workflows, **install** them into their local `.relavium/` catalog with one click, **publish**
their own (public or private to their organization), **rate and review**, and where Relavium's
own curated "starter packs" provide high-quality agents for common tasks. The Hub is
**not** an execution platform — it is a discovery and distribution layer. Agents and
workflows are downloaded as git-committable YAML files; execution stays local.

## Outcomes (Definition of Done)

- A user with a Relavium account browses the Hub at `hub.relavium.com`, finds an agent
  (e.g. "code-reviewer"), clicks **Install**, and the agent appears in their local
  `.relavium/agents/` ready to use with `relavium chat --agent code-reviewer` or as a
  sub-agent spawn target.
- A user publishes an agent or workflow they authored — choosing **Public** (visible to
  all) or **Private** (visible only to their organization). The Hub validates the YAML
  against the schema, scans for secrets, and assigns a unique slug.
- The Hub surfaces **ratings, review counts, download counts, and last-updated dates**
  for every listing. A "verified by Relavium" badge distinguishes curated starter packs
  from community submissions.
- A **`relavium hub`** CLI subcommand provides the same discovery + install flow from the
  terminal: `relavium hub search "code review"` → `relavium hub install relavium/code-reviewer`.
- The Hub enforces **no secrets in listings** — any submitted YAML containing a plaintext
  key, token, or `{{secrets.*}}` with a literal fallback is rejected at upload. Secrets
  stay in the user's OS keychain; the Hub never sees them.
- Organizations can create **private registries** — collections of agents/workflows visible
  only to their members, with role-based access (admin/editor/viewer).

## Scope

### In scope

- **Hub web portal** (`hub.relavium.com`): agent/workflow listing pages, search, category
  tags, install flow, publish flow with schema validation + secret scan, ratings/reviews,
  user profiles, organization pages.
- **`relavium hub` CLI**: `search`, `install`, `publish`, `list` (user's published items),
  `update` (pull latest version of an installed item), `uninstall`.
- **Starter packs**: Relavium-curated agents for code review, security audit, documentation
  generation, data analysis, deployment — high-quality, maintained, verified.
- **Private registries**: organization-scoped publish/install, role-based access, member
  management (via the existing Relavium account org model from Phase 5).
- **YAML validation + secret scan pipeline**: every published artifact is schema-validated
  and scanned for secrets before acceptance — no manual review bottleneck.
- **Versioning**: agents and workflows carry a `version` field; the Hub tracks versions and
  allows installing a specific version or "latest."
- **Provenance chain**: an installed agent records its Hub source (slug, version, installed
  at) in the local `.relavium/` metadata, so a user always knows where a third-party agent
  came from — critical for the import-trust/consent gate (2.6.B).
- **`relavium hub` in CI**: `relavium hub install relavium/code-reviewer@v2.1` in a CI
  pipeline pulls the agent, making Hub-published workflows CI-portable.

### Explicitly out of scope (→ later phases)

- **Hub-side execution** — the Hub never runs agents or workflows. It is a distribution
  layer, not an execution platform.
- **Monetization / paid marketplace** — listings are free. A paid marketplace with
  revenue sharing, subscription gating, and license-key enforcement is a separate phase.
- **Federated/self-hosted Hub** — organizations hosting their own Hub instance is deferred.
- **Agent dependency resolution** — an agent that depends on another agent (declared in
  YAML) auto-installing its dependencies is deferred.
- **CI/CD triggers from Hub** — webhook-based "on new version, re-run workflow" is
  deferred.

## Work breakdown

### 7.A — Hub web portal foundation

The `apps/portal` surface expanded with marketplace pages.

**Tasks:**

- Landing page: featured agents, categories, search bar, "Get started" flow.
- Agent/workflow detail page: description, README render, rating/review summary,
  download count, version history, install button.
- User profile page: published items, ratings given.
- Organization page: private registry items, member list.
- Search with tag-based filtering (language, task category, provider, modality).
- Responsive design — usable from mobile for browsing (install requires CLI).

**Acceptance:** the portal is live at `hub.relavium.com`; an anonymous user can browse,
search, and read agent details; creating an account (Phase 5 auth) enables install and
publish.

### 7.B — Publish flow + validation pipeline

**Tasks:**

- Upload form: paste or upload `.agent.yaml` / `.relavium.yaml`, set visibility
  (public/private), add description, tags, and README.
- Server-side schema validation: parse against the `@relavium/shared` Zod schemas,
  reject with field-named, positioned errors.
- **Secret scan**: before acceptance, scan every string field in the YAML for patterns
  matching API keys, tokens, passwords, and `{{secrets.*}}` with literal fallback values.
  Reject with a pointer to the offending line. This is the sole security gate — no
  manual review.
- Slug uniqueness: enforce `user-or-org/slug` uniqueness globally; suggest alternatives
  on collision.
- Version management: publish a new version of an existing listing; the Hub keeps all
  versions accessible.
- Deprecation: mark a listing as deprecated with a replacement pointer.

**Acceptance:** a user publishes an agent and it appears on the Hub within seconds; a
malformed YAML or one containing a plaintext key is rejected with an actionable message;
a second publish of the same slug fails with a suggested alternative.

### 7.C — `relavium hub` CLI surface

**Tasks:**

- `relavium hub search <query> [--tag <tag>] [--json]` — search the Hub, list results
  with name, author, rating, downloads, short description.
- `relavium hub install <user/agent>[@<version>]` — download the agent/workflow YAML,
  validate locally, write to `.relavium/agents/` or `.relavium/workflows/`, record
  provenance metadata (source Hub slug, version, installed timestamp).
- `relavium hub publish <path> [--public|--private]` — upload to the Hub. Requires
  authentication (Relavium account from Phase 5). Prompts for description, tags, README.
- `relavium hub list` — list the authenticated user's published items with status.
- `relavium hub update <user/agent>` — pull the latest version of an installed agent.
- `relavium hub uninstall <user/agent>` — remove from the local catalog (the file is
  deleted; provenance metadata is cleared). A dirty (user-modified) agent warns before
  uninstall.
- `--json` support on all read commands per ADR-0049.

**Acceptance:** a user types `relavium hub search "security"` and sees ranked results;
`relavium hub install relavium/security-auditor` downloads and installs the agent; a
subsequent `relavium chat --agent security-auditor` works immediately.

### 7.D — Starter packs and curation

**Tasks:**

- A curated collection of 10–15 high-quality agents covering common use cases:
  code review, security audit, documentation generation, data analysis (CSV/JSON),
  API integration testing, deployment verification, changelog generation, PR summary,
  test generation, accessibility audit.
- Each starter-pack agent is **authored, reviewed, and maintained by Relavium** —
  verified badge, guaranteed schema-valid, kept up to date with provider/model changes.
- Starter packs are pre-installed or one-click installable from the onboarding wizard
  (2.6.J) — the wizard's final step offers "Install starter agents?" after key setup.
- A `relavium hub starters` command lists and installs starter packs.

**Acceptance:** a new user completes onboarding and has the option to install starter
agents; each starter agent is independently usable and documented.

### 7.E — Organization private registries

**Tasks:**

- Organization creation and management (rides Phase 5 org model).
- Private publish: an agent/workflow published to an org is visible only to org members.
- Role-based access: admin (manage org, publish, remove), editor (publish, edit listings),
  viewer (install only).
- Member invitation and removal.
- Org-scoped `relavium hub install` and `relavium hub search --org <org>`.

**Acceptance:** an org admin creates the org, invites members, publishes private agents;
members can install them; non-members cannot see or install them.

## Milestones

| In-phase | Completed by | Outcome |
|----------|--------------|---------|
| M7-1 Hub foundation | 7.A | Hub portal live; browse + search + detail pages |
| M7-2 Publish + validation | 7.B | Upload flow with schema validation + secret scan |
| M7-3 CLI integration | 7.C | `relavium hub` subcommand family |
| M7-4 Starter packs + curation | 7.D | Curated agents shipped, onboarding integration |
| M7-5 Private registries | 7.E | Organization-scoped publish and install |

## Dependencies

- **Phase 5 (managed inference)** — the Relavium account system (auth, user identity,
  organizations) is the prerequisite for Hub authentication and private registries.
- **Phase 2.6** — the standardized agent/workflow I/O contract (2.6.N) and the
  conversational authoring package (2.6.A) are the substrate agents published to the
  Hub consume; the Hub validates against the same schemas.
- **Phase 1** — the `.relavium.yaml` / `.agent.yaml` schema and the CLI's catalog
  resolution are the install target; the Hub distributes files in the same format the
  engine already consumes.

## Risks & mitigations

| Risk | Mitigation |
|------|------------|
| Malicious agents in the marketplace (crypto miners, data exfiltration) | Mandatory secret scan at publish; the import-trust/consent gate (2.6.B) prompts the user on first install from an untrusted source; starter packs are Relavium-reviewed; user ratings surface quality signals |
| Secret leakage in published YAML | Automated scan pipeline at upload — reject before acceptance; the scan pattern set is maintained and expanded |
| Hub becomes a support burden (stale agents, broken listings) | Deprecation markers; automated schema re-validation on provider/model catalog updates; "last verified" date on listings |
| Scope creep into execution platform | Explicit out-of-scope boundary: the Hub never executes, never holds keys, never proxies LLM calls |
| Low initial content (empty marketplace problem) | Starter packs seed the marketplace with high-quality content from day one; the CLI's conversational authoring (2.6.B) makes creating new agents low-friction |

Part of [roadmap/](../README.md).
