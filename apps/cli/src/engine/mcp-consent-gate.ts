import { join } from 'node:path';

import { CliError } from '../process/errors.js';
import type { CliIo } from '../process/io.js';
import type { GlobalOptions } from '../process/options.js';
import { isInteractiveTerminal } from '../process/output-mode.js';
import { sanitizeUntrustedInline } from '../render/sanitize.js';
import type { ResolvedServerRef, StdioConsentGate } from './mcp-servers.js';
import {
  appendGrant,
  fingerprint,
  readGrants,
  resolveStdioSpawn,
  StdioResolutionError,
  type ResolvedStdioSpawn,
} from './mcp-consent.js';

/**
 * The consent gate
 * ([ADR-0084](../../../../docs/decisions/0084-consent-before-a-local-mcp-spawn.md) §1, §2, §6, §7).
 *
 * **Before any spawn, at one chokepoint.** It runs between resolving each declared server to its inline form
 * and building the `McpServerConfig`s — the single point `connectAgentMcp` (chat, agent run) and
 * `connectWorkflowMcp` (workflow run) both pass through. A refused server means `open()` is never
 * constructed, let alone called, which is what makes "nothing was spawned" a property of one decision rather
 * than of every transport adapter.
 *
 * Gating on the **resolved inline ref** rather than on a `[[mcp_servers]]` registration is deliberate: an
 * agent may declare a server with no registration at all, which is exactly the imported-artifact case this
 * exists for.
 */

/**
 * The production gate, ready to hand to `connectAgentMcp` / `connectWorkflowMcp`.
 *
 * One constructor because §1 names BOTH connect paths and the first wiring reached only `relavium run` —
 * leaving `chat`, `chat-resume`, the Home and `agent run` spawning ungated, which is the entire threat this
 * ADR exists for (an imported agent is opened by `chat --agent`, not by `run`). A helper rather than four
 * inline lambdas so a fifth surface cannot wire a subtly different one.
 */
export function createConsentGate(deps: ConsentGateDeps): StdioConsentGate {
  // The `artifact` parameter is FORWARDED, not dropped. It was declared on `StdioConsentGate` and omitted
  // here, and TypeScript accepts a shorter parameter list wherever a longer one is expected — so both
  // callers passed a third argument that vanished at runtime, `deps.artifact` was always `undefined`, and
  // the "declared in <file>" line the ADR requires never rendered on any surface. That is the SECOND time
  // this exact field died silently between a call site that computes it and the prompt that shows it, one
  // layer apart; the return type is now the shared alias so a missing parameter is a type error.
  return (refs, cwd, artifact) =>
    assertStdioConsent(refs, cwd, {
      ...deps,
      ...(artifact === undefined ? {} : { artifact }),
    });
}

/** Where the grant log lives, beside `history.db` and the terminal outbox. */
export function mcpConsentPath(homeDir: string): string {
  return join(homeDir, '.relavium', 'mcp-consent.ndjson');
}

/** Ask the user about one server. `true` approves; anything else refuses. Injected so tests need no TTY. */
export type ConsentPrompter = (subject: ConsentSubject) => Promise<boolean>;

/**
 * What the prompt shows — the WHOLE decision, as separate fields (§7).
 *
 * A user cannot consent to "the exact declaration" while half of it is invisible, and the environment is
 * exactly the half that changes what an executable does. Each field is sanitized and bounded at composition,
 * because `command`, `args` and the env names are artifact-controlled and a prompt showing a different
 * command than the one that will run is precisely the attack this gate exists to prevent.
 */
export interface ConsentSubject {
  readonly serverId: string;
  /** `inline`, or the `[[mcp_servers]]` registration name it came from. */
  readonly provenance: string;
  /** The artifact that declared it, when the caller knows one. */
  readonly artifact: string | undefined;
  /** The absolute executable that will run. */
  readonly resolvedCommand: string;
  /** As authored — shown only when it differs from the resolved path (`npx` → `/opt/homebrew/bin/npx`). */
  readonly authoredCommand: string | undefined;
  /** One entry per argument — NEVER a joined shell string, which would blur argument boundaries. */
  readonly args: readonly string[];
  /** `NAME` → the AUTHORED value, with a secret reference shown as `<secret:name>`. Never a resolved value. */
  readonly env: readonly (readonly [string, string])[];
  readonly cwd: string;
  /** `v1:<hex>` — printed on the refusal path so a CI author can authorize it. Not a secret. */
  readonly digest: string;
  /** How many servers this artifact declares in total, stated once before the first prompt. */
  readonly total: number;
  /** This server's 1-based position among them. */
  readonly index: number;
  /** When a grant for a DIFFERENT fingerprint of the same command exists — where it was approved. */
  readonly previouslyApprovedIn: string | undefined;
}

export interface ConsentGateDeps {
  readonly io: CliIo;
  readonly global: GlobalOptions;
  /** `~` — the grant log's home. */
  readonly homeDir: string;
  /** `--allow-mcp-stdio <digest>`, repeatable. Authorizes THIS invocation and writes nothing. */
  readonly allowedDigests?: readonly string[];
  /** Injected in tests; production wires the clack prompt. Absent ⇒ this process cannot ask. */
  readonly prompt?: ConsentPrompter | undefined;
  /** Injected so a test's grant carries a fixed timestamp. */
  readonly now?: (() => string) | undefined;
  /**
   * The artifact that declared these servers — shown at the prompt (§7), never fingerprinted.
   *
   * §7 lists it as a required field, "so the imported-artifact case names its own file", and the first
   * implementation carried the field through three types without ever assigning it: `subject.artifact` was
   * always `undefined` and the `declared in` line never rendered. The field that names the threat the whole
   * ADR exists for was dead.
   */
  readonly artifact?: string | undefined;
}

/**
 * Refuse, or let every declared stdio server through — resolving each to the exact program it names.
 *
 * Returns the resolved spawns keyed by server id, so the caller spawns the SAME absolute path that was
 * consented to rather than re-resolving the authored word against a `PATH` that may have changed.
 */
export async function assertStdioConsent(
  refs: readonly ResolvedServerRef[],
  cwd: string,
  deps: ConsentGateDeps,
): Promise<ReadonlyMap<string, ResolvedStdioSpawn>> {
  const stdio = refs.filter((ref) => ref.transport === 'stdio');
  const resolved = new Map<string, ResolvedStdioSpawn>();
  if (stdio.length === 0) return resolved;

  const subjects: { spawn: ResolvedStdioSpawn; digest: string }[] = [];
  for (const ref of stdio) {
    const spawn = await resolveOrRefuse(ref, cwd, deps.artifact);
    resolved.set(spawn.serverId, spawn);
    subjects.push({ spawn, digest: digestOrRefuse(spawn) });
  }

  const path = mcpConsentPath(deps.homeDir);
  const grants = readGrants(path);
  if (grants === undefined) {
    // §5: an unparseable line folds the WHOLE store closed, because a truncated one may be a tombstone.
    // Reported here rather than swallowed — the user's own grants have just become invisible, and silence
    // would leave them re-approving everything with no idea why.
    deps.io.writeErr(
      `warning: ${sanitizeUntrustedInline(path)} could not be read; every stdio MCP server will be asked about again.\n`,
    );
  }
  const allowed = new Set(deps.allowedDigests ?? []);

  // **Deduped by DIGEST.** Two ids naming a byte-identical declaration are one program and one decision —
  // §10.18's "two agents declaring the same server in one artifact prompt ONCE". The first implementation
  // asked twice and wrote two grant lines for one digest, and its own count test pinned "2 local programs",
  // asserting the behaviour the acceptance forbids.
  const seen = new Set<string>();
  const pending = subjects.filter(({ digest }) => {
    if ((grants?.has(digest) ?? false) || allowed.has(digest) || seen.has(digest)) return false;
    seen.add(digest);
    return true;
  });
  if (pending.length === 0) return resolved;

  if (!canAsk(deps)) {
    // §6: no prompt without all four signals. The per-server detail goes to STDERR as its own lines and the
    // error message stays ONE line — `renderError` runs a message through `sanitizeInline`, which collapses
    // every newline to a space, so a multi-line message arrived as an unreadable run-on with the digest —
    // the one thing a CI author must copy — buried mid-line.
    for (const { spawn, digest } of pending) {
      deps.io.writeErr(`  ${safe(spawn.serverId)}: ${safe(spawn.resolvedCommand)}  ${digest}\n`);
    }
    throw new CliError(
      'invalid_invocation',
      `this run would start ${String(pending.length)} local program(s) not approved on this machine (listed above). Approve them interactively, or pass --allow-mcp-stdio <digest> for each — the digest is a hash of the declaration, not a secret.`,
    );
  }

  // §2: the COUNT once, before the first question, so a user knows how many decisions they are entering
  // rather than discovering the second after granting the first.
  if (pending.length > 1) {
    deps.io.writeErr(`This artifact will start ${String(pending.length)} local programs.\n`);
  }
  const prompt = deps.prompt;
  const now = deps.now ?? ((): string => new Date().toISOString());
  for (const [index, { spawn, digest }] of pending.entries()) {
    const approved =
      prompt === undefined
        ? false
        : await prompt(subjectOf(spawn, digest, index + 1, pending.length, grants));
    if (!approved) {
      throw new CliError(
        'invalid_invocation',
        `MCP server '${safe(spawn.serverId)}' was not approved, so the run did not start.`,
      );
    }
    try {
      appendGrant(path, {
        v: 1,
        digest,
        command: spawn.resolvedCommand,
        args: [...spawn.args],
        envNames: Object.keys(spawn.env),
        cwd: spawn.cwd,
        grantedAt: now(),
      });
    } catch (error) {
      // A symlinked store, a full disk, an unwritable home. The run fails CLOSED either way — nothing has
      // been spawned, the gate runs entirely before any config is built — but it must fail as an invocation
      // fault naming the file, not as exit 1 "an unexpected internal error occurred" seconds after the user
      // answered YES to a security prompt.
      throw new CliError(
        'invalid_invocation',
        `your consent could not be recorded in ${safe(path)}: ${safe(error instanceof Error ? error.message : String(error))}`,
        { cause: error },
      );
    }
  }
  return resolved;
}

/** Resolve one declaration, turning a resolution failure into the surface's typed exit-2 fault. */
/**
 * The declaration's digest, or a clean refusal when the declaration has no canonical form.
 *
 * §3 refuses a lone surrogate "at parse", because such a string has no UTF-8 encoding and a second,
 * non-TypeScript implementation could not hold it, let alone reproduce the digest. `canonicalJson` is where
 * that refusal lives; without this wrapper it left the gate as an untyped `NonCanonicalValueError` and
 * surfaced as an internal error rather than as the refusal the ADR describes.
 */
function digestOrRefuse(spawn: ResolvedStdioSpawn): string {
  try {
    return fingerprint(spawn);
  } catch (error) {
    throw new CliError(
      'invalid_invocation',
      `MCP server '${safe(spawn.serverId)}' cannot be fingerprinted, so it cannot be approved: ${
        error instanceof Error ? safe(error.message) : 'the declaration has no canonical form'
      }.`,
    );
  }
}

async function resolveOrRefuse(
  ref: ResolvedServerRef,
  cwd: string,
  artifact: string | undefined,
): Promise<ResolvedStdioSpawn> {
  if (ref.id === undefined || ref.command === undefined) {
    throw new CliError(
      'invalid_invocation',
      'an MCP stdio server reached the consent gate without an id or a command.',
    );
  }
  try {
    return await resolveStdioSpawn(
      {
        serverId: ref.id,
        // `resolveMcpServerRef` records the registration it resolved a by-name `ref` from on the host-only
        // `__registration` field, because the schema has nowhere to carry it and the ref is never re-parsed.
        // Without it a config-declared server displayed as `inline`, telling a user the declaration was in
        // the artifact when it was in their own config.
        provenance:
          ref.registrationName === undefined
            ? { kind: 'inline' }
            : { kind: 'registration', name: ref.registrationName },
        ...(artifact === undefined ? {} : { artifact }),
        command: ref.command,
        ...(ref.args === undefined ? {} : { args: ref.args }),
        ...(ref.env === undefined ? {} : { env: ref.env }),
      },
      cwd,
    );
  } catch (error) {
    if (error instanceof StdioResolutionError) {
      throw new CliError('invalid_invocation', `${error.message}.`);
    }
    throw error;
  }
}

/** All four signals (§6) — and a prompter actually wired, since a caller with none cannot ask either. */
function canAsk(deps: ConsentGateDeps): boolean {
  return (
    deps.prompt !== undefined &&
    isInteractiveTerminal({
      stdoutIsTty: deps.io.stdoutIsTty,
      stdinIsTty: deps.io.stdinIsTty,
      json: deps.global.json,
      env: deps.io.env,
    })
  );
}

/** Compose what the prompt shows — sanitized and bounded at the point of composition (§7). */
function subjectOf(
  spawn: ResolvedStdioSpawn,
  digest: string,
  index: number,
  total: number,
  grants: ReadonlyMap<string, { readonly command: string; readonly cwd: string }> | undefined,
): ConsentSubject {
  // A grant for the SAME executable in a different directory: the prompt says where, so a project-scoped
  // re-ask is a recognition rather than a fresh decision (§3's answer to consent fatigue).
  const elsewhere = [...(grants?.values() ?? [])].find(
    (grant) => grant.command === spawn.resolvedCommand && grant.cwd !== spawn.cwd,
  );
  return {
    serverId: safe(spawn.serverId),
    provenance: spawn.provenance.kind === 'inline' ? 'inline' : safe(spawn.provenance.name),
    artifact: spawn.artifact === undefined ? undefined : safe(spawn.artifact),
    resolvedCommand: safe(spawn.resolvedCommand),
    authoredCommand: spawn.command === spawn.resolvedCommand ? undefined : safe(spawn.command),
    // **The COUNT is bounded, not just each field's length.** A review measured a 406-argument declaration
    // producing a 415-line block whose visible tail — the only part above the confirm prompt on any normal
    // terminal — was entirely attacker-composed, with the real `executable` line at index 2. A per-field
    // clip cannot stop that; only a per-LIST clip can, and this function's own comment claimed the property
    // the clip alone did not provide.
    args: clipArgs(spawn.args.map(safe)),
    env: clipEnv(
      Object.entries(spawn.env).map(([name, value]): readonly [string, string] => [
        safe(name),
        safe(displayValue(value)),
      ]),
    ),
    cwd: safe(spawn.cwd),
    digest,
    total,
    index,
    previouslyApprovedIn: elsewhere === undefined ? undefined : safe(elsewhere.cwd),
  };
}

/**
 * How an authored env value is SHOWN: a sole secret reference as `<secret:NAME>`, anything else verbatim.
 *
 * A resolved credential never reaches here — `spawn.env` carries the authored text, pre-resolution — and the
 * marker is derived from the same anchored pattern the digest uses, so what is displayed and what is
 * identified cannot disagree.
 */
function displayValue(value: string): string {
  const reference = /^\{\{\s*secrets\.([A-Za-z0-9._-]+)\s*\}\}$/.exec(value);
  return reference?.[1] === undefined ? value : `<secret:${reference[1]}>`;
}

/**
 * Keep a displayed list to what fits above a prompt, with the remainder stated as a count.
 *
 * The overflow line is part of the decision rather than a footnote: a user must know they are approving
 * more than they can see, and "12 of 406" is the fact that tells them to open the artifact instead.
 */
function clipArgs(items: readonly string[]): readonly string[] {
  if (items.length <= MAX_DISPLAYED_ENTRIES) return items;
  return [
    ...items.slice(0, MAX_DISPLAYED_ENTRIES),
    `… and ${String(items.length - MAX_DISPLAYED_ENTRIES)} more arguments — open the artifact to read them`,
  ];
}

function clipEnv(
  items: readonly (readonly [string, string])[],
): readonly (readonly [string, string])[] {
  if (items.length <= MAX_DISPLAYED_ENTRIES) return items;
  return [
    ...items.slice(0, MAX_DISPLAYED_ENTRIES),
    [
      `… and ${String(items.length - MAX_DISPLAYED_ENTRIES)} more`,
      'environment variables — open the artifact to read them',
    ] as const,
  ];
}

/** How many arguments / environment variables the prompt shows before the rest become a count. */
const MAX_DISPLAYED_ENTRIES = 12;

/** Every displayed field goes through this: terminal controls stripped, length bounded. */
function safe(text: string): string {
  // **Zero-width too**, which §7 says these fields strip and the first implementation did not.
  // `sanitizeUntrustedInline` deliberately KEEPS ZWJ/ZWNJ — correct for prose, wrong for a structured field
  // in a trust decision, where `--safe\u200b--evil` and `--safe--evil` render identically and an executable
  // name is exactly the kind of field the provider surface already rejects them from.
  const cleaned = sanitizeUntrustedInline(text).replace(ZERO_WIDTH, '');
  return cleaned.length <= MAX_FIELD_CHARS ? cleaned : `${cleaned.slice(0, MAX_FIELD_CHARS)}…`;
}

/** ZWSP/ZWNJ/ZWJ, word joiner, Mongolian vowel separator, BOM — invisible, and identity-bearing here. */
const ZERO_WIDTH = /[\u200B-\u200D\u2060\u180E\uFEFF]/g;

/** A bound on any one displayed field — a hostile declaration cannot push the decision off the screen. */
const MAX_FIELD_CHARS = 200;
