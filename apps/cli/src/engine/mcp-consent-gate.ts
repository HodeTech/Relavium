import { join, relative, sep } from 'node:path';

import { CliError } from '../process/errors.js';
import type { CliIo } from '../process/io.js';
import type { GlobalOptions } from '../process/options.js';
import { isInteractiveTerminal } from '../process/output-mode.js';
import { INVISIBLE_CHARS } from '../render/invisible-chars.js';
import { sanitizeUntrustedInline } from '../render/sanitize.js';
import type { ResolvedServerRef, StdioConsentGate } from './mcp-servers.js';
import {
  appendGrant,
  ConsentStoreError,
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
export type ConsentPrompter = (
  subject: ConsentSubject,
  options?: { readonly signal?: AbortSignal },
) => Promise<boolean>;

/**
 * What the prompt shows — the WHOLE decision, as separate fields (§7).
 *
 * A user cannot consent to "the exact declaration" while half of it is invisible, and the environment is
 * exactly the half that changes what an executable does. Each field is sanitized and bounded at composition,
 * because `command`, `args` and the env names are artifact-controlled and a prompt showing a different
 * command than the one that will run is precisely the attack this gate exists to prevent. The three PATHS
 * (`resolvedCommand`, `cwd`, `previouslyApprovedIn`) are the one exception: each is the path exactly as it is,
 * or no subject is made at all ({@link CONSENT_PATH_UNSHOWN}).
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
  readonly signal?: AbortSignal;
  readonly io: CliIo;
  readonly global: GlobalOptions;
  /** `~` — the grant log's home. */
  readonly homeDir: string;
  /** `--allow-mcp-stdio <digest>`, repeatable. Authorizes THIS invocation and writes nothing. */
  readonly allowedDigests?: readonly string[];
  /** Injected in tests; production wires the clack prompt. Absent ⇒ this process cannot ask. */
  readonly prompt?: ConsentPrompter | undefined;
  /**
   * `prompt` is a NATIVE CARD on its host's own input owner (the Home's chord card,
   * [ADR-0139](../../../../docs/decisions/0139-a-workflow-run-is-hosted-inside-the-home.md) §4), not a question put to this
   * invocation's terminal. Such a card needs neither this leg's stdin nor its stdout, so the four terminal signals
   * (`canAsk`) do not decide whether it can ask: a hosted leg's `io` reports non-TTY on purpose, because nothing else about it is
   * interactive. This is the ONE way a hosted leg opens a prompt, and it is honoured only together with a prompter: with no card
   * wired nothing can ask, whatever this says, and the gate refuses with the digests as it does for a script.
   */
  readonly nativeCard?: boolean | undefined;
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
  deps.signal?.throwIfAborted();
  const stdio = refs.filter((ref) => ref.transport === 'stdio');
  const resolved = new Map<string, ResolvedStdioSpawn>();
  if (stdio.length === 0) return resolved;

  const subjects: Subject[] = [];
  for (const ref of stdio) {
    deps.signal?.throwIfAborted();
    const spawn = await resolveOrRefuse(ref, cwd, deps.artifact);
    deps.signal?.throwIfAborted();
    resolved.set(spawn.serverId, spawn);
    subjects.push({ spawn, digest: digestOrRefuse(spawn) });
  }

  deps.signal?.throwIfAborted();
  const path = mcpConsentPath(deps.homeDir);
  const grants = readGrants(path);
  if (grants === undefined) {
    // §5: an unparseable line folds the WHOLE store closed, because a truncated one may be a tombstone — and so does a store that is a
    // link, not a regular file, or over the size bound. Reported here rather than swallowed — the user's own grants have just become
    // invisible, and silence would leave them re-approving everything with no idea why. The file is named from `~`, not by its
    // absolute path.
    deps.io.writeErr(
      `warning: ${consentStoreLabel(deps.homeDir, path)} could not be read; every stdio MCP server will be asked about again. Delete the file or move it aside to start a new grant log.\n`,
    );
  }

  const pending = undecided(subjects, grants, deps.allowedDigests);
  if (pending.length === 0) return resolved;
  if (!canAsk(deps)) refuseWithDigests(pending, deps);
  await askAndRecord(pending, path, grants, deps);
  return resolved;
}

/** One declaration and the digest that identifies it — what a decision is about. */
interface Subject {
  readonly spawn: ResolvedStdioSpawn;
  readonly digest: string;
}

/**
 * The declarations still needing a decision — **deduped by DIGEST**.
 *
 * Two ids naming a byte-identical declaration are one program and one decision (§10.18's "two agents
 * declaring the same server in one artifact prompt ONCE"). The first implementation asked twice and wrote
 * two grant lines for one digest, and its own count test pinned "2 local programs" — asserting the behaviour
 * the acceptance forbids.
 */
function undecided(
  subjects: readonly Subject[],
  grants: ReadonlyMap<string, unknown> | undefined,
  allowedDigests: readonly string[] | undefined,
): readonly Subject[] {
  const allowed = new Set(allowedDigests ?? []);
  const seen = new Set<string>();
  return subjects.filter(({ digest }) => {
    if ((grants?.has(digest) ?? false) || allowed.has(digest) || seen.has(digest)) return false;
    seen.add(digest);
    return true;
  });
}

/**
 * §6: no prompt without all four signals — so list what would have run, and refuse.
 *
 * The per-server detail goes to STDERR as its own lines and the error message stays ONE line: `renderError`
 * runs a message through `sanitizeInline`, which collapses every newline to a space, so a multi-line message
 * arrived as an unreadable run-on with the digest — the one thing a CI author must copy — buried mid-line.
 */
function refuseWithDigests(pending: readonly Subject[], deps: ConsentGateDeps): never {
  for (const { spawn, digest } of pending) {
    deps.io.writeErr(listedProgram(spawn.serverId, spawn.resolvedCommand, digest));
  }
  throw new CliError(
    'invalid_invocation',
    `this run would start ${String(pending.length)} local program(s) not approved on this machine (listed above). Approve them interactively, or pass --allow-mcp-stdio <digest> for each — the digest is a hash of the declaration, not a secret.`,
  );
}

/**
 * Ask about each undecided program in turn, recording each YES before moving to the next.
 *
 * Recorded as it goes rather than in one batch at the end: a user who approves three and then hits an
 * unwritable home should not lose the two decisions they already made — and a refusal at any point stops the
 * run, so a grant is never written for a program that did not get one.
 */
async function askAndRecord(
  pending: readonly Subject[],
  path: string,
  grants: Parameters<typeof subjectOf>[4],
  deps: ConsentGateDeps,
): Promise<void> {
  // §2: the COUNT once, before the first question, so a user knows how many decisions they are entering
  // rather than discovering the second after granting the first.
  if (pending.length > 1) {
    deps.io.writeErr(`This artifact will start ${String(pending.length)} local programs.\n`);
  }
  const prompt = deps.prompt;
  const now = deps.now ?? ((): string => new Date().toISOString());
  for (const [index, { spawn, digest }] of pending.entries()) {
    deps.signal?.throwIfAborted();
    const approved =
      prompt === undefined
        ? false
        : await prompt(
            subjectOf(spawn, digest, index + 1, pending.length, grants),
            deps.signal === undefined ? undefined : { signal: deps.signal },
          );
    deps.signal?.throwIfAborted();
    if (!approved) {
      throw new CliError(
        'invalid_invocation',
        `MCP server '${safe(spawn.serverId)}' was not approved, so the run did not start.`,
      );
    }
    const grantedAt = now();
    deps.signal?.throwIfAborted();
    recordGrant(deps.homeDir, path, spawn, digest, grantedAt);
  }
}

/**
 * How the grant log is named in a message: from `~`, never by its absolute path (a transcript or a screen share carries the operator's
 * directory layout away). The log is `<home>/.relavium/mcp-consent.ndjson` by construction ({@link mcpConsentPath}), so the label is
 * the path below the home.
 */
function consentStoreLabel(homeDir: string, path: string): string {
  return `~${sep}${relative(homeDir, path)}`;
}

/**
 * Why a consent could not be recorded, in words that carry no path: the store's own refusal (already fixed text), or a fixed sentence
 * for the filesystem faults a person can act on. A raw `fs` message names the absolute path, so it is never echoed.
 */
function recordFailureReason(error: unknown): string {
  if (error instanceof ConsentStoreError) return error.message;
  const code =
    typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined;
  if (code === 'EACCES' || code === 'EPERM') return 'permission denied';
  if (code === 'ENOSPC') return 'no space is left on the device';
  if (code === 'EROFS') return 'the file system is read-only';
  return 'the file could not be written';
}

/**
 * Persist one decision, or fail as an INVOCATION fault naming the file.
 *
 * A symlinked store, a full disk, an unwritable home. The run fails CLOSED either way — nothing has been
 * spawned, the gate runs entirely before any config is built — but it must not surface as exit 1 "an
 * unexpected internal error occurred" seconds after the user answered YES to a security prompt.
 */
function recordGrant(
  homeDir: string,
  path: string,
  spawn: ResolvedStdioSpawn,
  digest: string,
  grantedAt: string,
): void {
  try {
    appendGrant(path, {
      v: 1,
      digest,
      command: spawn.resolvedCommand,
      args: [...spawn.args],
      envNames: Object.keys(spawn.env),
      cwd: spawn.cwd,
      grantedAt,
    });
  } catch (error) {
    throw new CliError(
      'invalid_invocation',
      `your consent could not be recorded in ${consentStoreLabel(homeDir, path)}: ${recordFailureReason(error)}`,
      { cause: error },
    );
  }
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

/**
 * All four signals (§6) — and a prompter actually wired, since a caller with none cannot ask either. A native card is its own
 * signal (see {@link ConsentGateDeps.nativeCard}): the Home that mounts it is a terminal with a person at it by construction.
 */
function canAsk(deps: ConsentGateDeps): boolean {
  if (deps.prompt === undefined) return false;
  if (deps.nativeCard === true) return true;
  return isInteractiveTerminal({
    stdoutIsTty: deps.io.stdoutIsTty,
    stdinIsTty: deps.io.stdinIsTty,
    json: deps.global.json,
    env: deps.io.env,
  });
}

/**
 * Compose what the prompt shows — sanitized and bounded at the point of composition (§7), except the three paths, which are shown
 * exactly or refused ({@link exactPath}).
 */
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
    resolvedCommand: exactPath(spawn.resolvedCommand),
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
    cwd: exactPath(spawn.cwd),
    digest,
    total,
    index,
    previouslyApprovedIn: elsewhere === undefined ? undefined : exactPath(elsewhere.cwd),
  };
}

/**
 * What a start says when a program's path cannot be shown as it is on any surface: fixed words, no path, and no command, because no
 * prompt can approve it (the Home's card says its own sentence, which names the shell, for a path only a card must refuse).
 */
export const CONSENT_PATH_UNSHOWN =
  'Not started: a local program has a path that cannot be shown as it is, so it cannot be approved.';

/**
 * A path as it is, or a refusal before any prompt is made.
 *
 * A path is the decision itself (what runs, where, where it was approved before), and a repository ships the program it names, so
 * `tools/srv` with a zero-width space, a word joiner, a byte-order mark, a bidi override, a bell, an escape, a no-break space or a
 * trailing space in its name is a different file from `tools/srv`. {@link clean} would strip some of those, and the rest draw nothing
 * or a blank, so a prompt would name the visible twin while the real file runs. Such a path reaches no prompter: not the Home's card,
 * not the shell's question. Refusing here, before the subject exists, is what keeps every surface's check on the raw text; a check in
 * a prompter only ever saw the cleaned one.
 */
function exactPath(path: string): string {
  if (!shownExactly(path)) throw new CliError('invalid_invocation', CONSENT_PATH_UNSHOWN);
  return path;
}

/**
 * Whether every surface can show `path` exactly as it is and whole: no longer than {@link MAX_PATH_CHARS}, nothing {@link clean} would
 * change (a control, a bidi or zero-width character, a secret-shaped part), no {@link HIDDEN_CHAR}, and no space at either end, where
 * a row draws it as nothing. An ordinary space between visible characters (`My  Tools`) is shown as it is.
 */
function shownExactly(path: string): boolean {
  return (
    path.length <= MAX_PATH_CHARS &&
    !HIDDEN_CHAR.test(path) &&
    !EDGE_SPACE.test(path) &&
    clean(path) === path
  );
}

/**
 * The part of {@link HIDDEN_CHAR} the shared {@link INVISIBLE_CHARS} does not hold. A regular expression literal, so the Braille blank is
 * written as its escape and no string of this file spells the character itself.
 */
const CONTROL_OR_BLANK = /\p{Cc}|[^\S ]|\u2800/u;

/**
 * A character no prompt may show inside a path, because a person cannot see it or cannot tell it from another: a control, one that draws
 * nothing ({@link INVISIBLE_CHARS}: the format characters and every default-ignorable one), a blank other than the ordinary space (a
 * no-break space, an ideographic space, a line separator: any `\s` but U+0020), and the Braille blank U+2800, which draws a space and
 * is none of those. No global flag, so `test` keeps no position between calls.
 */
const HIDDEN_CHAR = new RegExp(`${CONTROL_OR_BLANK.source}|${INVISIBLE_CHARS.source}`, 'u');

/** The ordinary space where a row draws it as nothing: at the end of a path (and, for a stored path, at its start). */
const EDGE_SPACE = /^ | $/u;

/**
 * The longest path a prompt shows, whole. Neither surface cuts a path: the shell writes it on one line the terminal wraps, and the
 * card wraps its row (`hardWrap`) or, when the card does not fit the terminal, draws no card but `Prompt does not fit — enlarge the
 * terminal`. So the bound is where an ordinary card stops fitting the smallest terminal the Home supports: at 80 columns a detail row
 * holds 76 (the gutter and its margin take 4), a labelled path row takes ceil((12 + length) / 76) rows, and an 80×24 card with no
 * arguments keeps 14 rows for the executable and its directory, 7 each: 7 * 76 - 12 = 520. Measured by painting the card at 80×24:
 * with both paths at 520 characters it is drawn whole, at 521 it does not fit. Real `node_modules/.pnpm` paths (whose store names pnpm
 * keeps to 120 characters) are well inside it; the 200 the gate keeps for the author's words is not a path's bound.
 */
const MAX_PATH_CHARS = 520;

/**
 * One program of the non-interactive list a script's author picks a digest from (§6), as `  <id>: <path>  <digest>`.
 *
 * The path is the one thing the author reads to decide, so it is never a visible twin: a path every prompt could show is written as it
 * is (whole, so a long one keeps its file name), and any other is written with each hidden character as a `\uXXXX` escape (and each
 * backslash doubled, so an escape cannot be forged by a name that spells one), then a note that says so and that only the digest can
 * approve it.
 */
function listedProgram(serverId: string, path: string, digest: string): string {
  if (shownExactly(path)) return `  ${safe(serverId)}: ${path}  ${digest}\n`;
  const escaped = escapeHidden(path);
  const note =
    escaped === path
      ? 'no prompt can show this path as it is, so only its digest can approve it'
      : 'this path holds characters that do not show, written here as \\u escapes; only its digest can approve it';
  return `  ${safe(serverId)}: ${sanitizeUntrustedInline(escaped)}  ${digest}  (${note})\n`;
}

/** `path` with every {@link HIDDEN_CHAR} and an edge space as a visible escape and every backslash doubled; `path` itself when it has none. */
function escapeHidden(path: string): string {
  if (!HIDDEN_CHAR.test(path) && !EDGE_SPACE.test(path)) return path;
  const points = [...path];
  return points
    .map((point, at) => {
      if (point === '\\') return '\\\\';
      const edge = point === ' ' && (at === 0 || at === points.length - 1);
      return edge || HIDDEN_CHAR.test(point) ? escapeOf(point) : point;
    })
    .join('');
}

/** `\uXXXX`, or `\u{XXXXX}` past the Basic Multilingual Plane. */
function escapeOf(point: string): string {
  const hex = (point.codePointAt(0) ?? 0).toString(16).toUpperCase();
  return hex.length > 4 ? `\\u{${hex}}` : `\\u${hex.padStart(4, '0')}`;
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
  const cleaned = clean(text);
  return cleaned.length <= MAX_FIELD_CHARS ? cleaned : `${cleaned.slice(0, MAX_FIELD_CHARS)}…`;
}

/** {@link safe} before its length bound: terminal controls stripped, secrets masked, zero-width characters removed. */
function clean(text: string): string {
  // **Zero-width too**, which §7 says these fields strip and the first implementation did not.
  // `sanitizeUntrustedInline` deliberately KEEPS ZWJ/ZWNJ — correct for prose, wrong for a structured field
  // in a trust decision, where `--safe\u200b--evil` and `--safe--evil` render identically and an executable
  // name is exactly the kind of field the provider surface already rejects them from.
  return sanitizeUntrustedInline(text).replace(ZERO_WIDTH, '');
}

/** ZWSP/ZWNJ/ZWJ, word joiner, Mongolian vowel separator, BOM — invisible, and identity-bearing here. */
const ZERO_WIDTH = /[\u200B-\u200D\u2060\u180E\uFEFF]/g;

/** A bound on any one displayed field — a hostile declaration cannot push the decision off the screen. */
const MAX_FIELD_CHARS = 200;
