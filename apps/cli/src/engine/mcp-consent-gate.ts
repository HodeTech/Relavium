import { join } from 'node:path';

import type { McpServerRef } from '@relavium/shared';

import { CliError } from '../process/errors.js';
import type { CliIo } from '../process/io.js';
import type { GlobalOptions } from '../process/options.js';
import { isInteractiveTerminal } from '../process/output-mode.js';
import { sanitizeUntrustedInline } from '../render/sanitize.js';
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
export function createConsentGate(
  deps: ConsentGateDeps,
): (
  refs: readonly McpServerRef[],
  cwd: string,
) => Promise<ReadonlyMap<string, ResolvedStdioSpawn>> {
  return (refs, cwd) => assertStdioConsent(refs, cwd, deps);
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
}

/**
 * Refuse, or let every declared stdio server through — resolving each to the exact program it names.
 *
 * Returns the resolved spawns keyed by server id, so the caller spawns the SAME absolute path that was
 * consented to rather than re-resolving the authored word against a `PATH` that may have changed.
 */
export async function assertStdioConsent(
  refs: readonly McpServerRef[],
  cwd: string,
  deps: ConsentGateDeps,
): Promise<ReadonlyMap<string, ResolvedStdioSpawn>> {
  const stdio = refs.filter((ref) => ref.transport === 'stdio');
  const resolved = new Map<string, ResolvedStdioSpawn>();
  if (stdio.length === 0) return resolved;

  const subjects: { spawn: ResolvedStdioSpawn; digest: string }[] = [];
  for (const ref of stdio) {
    const spawn = await resolveOrRefuse(ref, cwd);
    resolved.set(spawn.serverId, spawn);
    subjects.push({ spawn, digest: fingerprint(spawn) });
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

  const pending = subjects.filter(
    ({ digest }) => !(grants?.has(digest) ?? false) && !allowed.has(digest),
  );
  if (pending.length === 0) return resolved;

  if (!canAsk(deps)) {
    // §6: no prompt without all four signals. The digest is printed because it is exactly what
    // `--allow-mcp-stdio` accepts, and it is not a secret — it is a hash of an approved declaration.
    throw new CliError('invalid_invocation', refusalMessage(pending));
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
    appendGrant(path, {
      v: 1,
      digest,
      command: spawn.resolvedCommand,
      args: [...spawn.args],
      envNames: Object.keys(spawn.env),
      cwd: spawn.cwd,
      grantedAt: now(),
    });
  }
  return resolved;
}

/** Resolve one declaration, turning a resolution failure into the surface's typed exit-2 fault. */
async function resolveOrRefuse(ref: McpServerRef, cwd: string): Promise<ResolvedStdioSpawn> {
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
        provenance: { kind: 'inline' },
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

/** The non-interactive refusal — names each executable and prints the digest that authorizes it. */
function refusalMessage(pending: readonly { spawn: ResolvedStdioSpawn; digest: string }[]): string {
  const lines = pending.map(
    ({ spawn, digest }) => `  ${safe(spawn.serverId)}: ${safe(spawn.resolvedCommand)}  ${digest}`,
  );
  return [
    `this run would start ${String(pending.length)} local program(s) that have not been approved on this machine:`,
    ...lines,
    'Approve them interactively, or pass --allow-mcp-stdio <digest> for each (the digest is a hash of the declaration, not a secret).',
  ].join('\n');
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
    args: spawn.args.map(safe),
    env: Object.entries(spawn.env).map(([name, value]) => [safe(name), safe(displayValue(value))]),
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

/** Every displayed field goes through this: terminal controls stripped, length bounded. */
function safe(text: string): string {
  const cleaned = sanitizeUntrustedInline(text);
  return cleaned.length <= MAX_FIELD_CHARS ? cleaned : `${cleaned.slice(0, MAX_FIELD_CHARS)}…`;
}

/** A bound on any one displayed field — a hostile declaration cannot push the decision off the screen. */
const MAX_FIELD_CHARS = 200;
