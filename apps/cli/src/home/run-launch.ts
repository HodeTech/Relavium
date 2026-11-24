import { basename } from 'node:path';

import {
  BUILTIN_TOOLS,
  parseWorkflow,
  resolveAndValidateWorkflowInputs,
  WorkflowParseError,
  type WorkflowDefinition,
} from '@relavium/core';

import { inputAdmissionMessage, resolveInputs } from '../commands/inputs.js';
import { faultForTranscript } from '../config/config-error-text.js';
import { ConfigError } from '../config/errors.js';
import { loadResolvedConfig, type LoadedConfig } from '../config/load.js';
import { shortRunId } from '../history/run-detail-model.js';
import { CliError, isCliError } from '../process/errors.js';
import { sourceLabel } from '../process/source-label.js';
import { sanitizeUntrustedInline } from '../render/sanitize.js';
import { NATIVE_PROMPT_BACK, type NativePromptFlow } from '../render/tui/native-prompt-channel.js';
import { workflowSourceDigest } from '../run-core/source-digest.js';
import { discoverCatalog, fileStem, type CatalogEntry } from '../workflows/catalog.js';
import { resolveWorkflowSource } from '../workflows/resolve.js';
import type { HostedLaunch, HostedSecretPort, RunHost, RunHostSnapshot } from './run-host.js';

/**
 * Launch a workflow from the Home
 * ([ADR-0139](../../../../docs/decisions/0139-a-workflow-run-is-hosted-inside-the-home.md) §2, §4, §7): a picker over the project's valid
 * workflows, a form for its declared inputs, a confirmation that defaults to No, and one call to {@link RunHost.start}.
 *
 * **A pure machine plus its effects.** {@link reduceLaunch} is the whole flow as a pure function of a state and an event; it returns the
 * next state and the effects to run, and does nothing else. The driver ({@link createRunLaunch}) runs each effect through a port (the
 * native prompt flow, the catalog, the host) and feeds the answer back as an event. Every event that answers a prompt carries the TURN
 * of the prompt it answers, and the reducer ignores one whose turn is not the current one: a second `Enter` that reaches the machine
 * in the same tick as the first answers a prompt that is already gone, so it starts nothing. The `starting` state IS the single-flight
 * latch (ADR-0139 §2): a second confirmation finds the machine past `confirming` and emits no second `start`.
 *
 * **A secret never enters the machine.** The machine's state and events hold the names and the non-secret values only. A masked field's
 * value goes from the native password prompt into a {@link SecretHold} the driver closes over, and leaves it only through the
 * {@link HostedSecretPort} handed to `start`, which empties it. It is in no state, no event, no notice and no log line; a field that is
 * left (`Esc` back, `Ctrl+C`, a refusal) wipes its entry.
 *
 * **`Esc` steps back one field and `Ctrl+C` leaves** (ADR-0139 §5): every field and the confirmation open with `escape: 'back'`; the
 * picker has nothing to step back to, so `Esc` there leaves. A typed-ahead `Enter` at the confirmation lands on its default, No.
 */

/** A workflow the picker offers. */
export interface LaunchChoice {
  /** The project-relative path the host resolves exactly as `relavium run <path>` does, so a file named other than its id still runs. */
  readonly path: string;
  readonly slug: string;
  /** What the picker shows, already sanitized and bounded. */
  readonly label: string;
}

/** One declared input, as the form asks it. */
export interface LaunchField {
  readonly name: string;
  readonly type: InputDecl['type'];
  readonly secret: boolean;
  /** An answer is required: declared required, with no default. */
  readonly required: boolean;
  /** The prompt text: the name, its type and what the author wrote, sanitized and bounded. */
  readonly label: string;
}

type InputDecl = NonNullable<WorkflowDefinition['workflow']['inputs']>[number];

/**
 * What the form has so far: the workflow, its fields and the NON-SECRET values given (never a masked one).
 *
 * `sourceDigest` is the digest of the exact file text of ONE read: the pick-time `catalog.load`. The fields, the `choice.label` the
 * confirmation prints (rebuilt at the pick from that read, not taken from the list's) and the values asked for are all from it, so
 * the digest binds what the confirmation names and asks. It goes to the host with the start, which refuses when the file it reads is
 * not that text (LAUNCH-5). It is not a secret. It binds the workflow file only: the project and global configuration, the consent
 * grants and the other things a start reads are not in it (see `PrepareRunRequest.expectedSourceDigest`).
 */
interface LaunchForm {
  readonly choice: LaunchChoice;
  readonly fields: readonly LaunchField[];
  readonly values: Readonly<Record<string, string>>;
  readonly sourceDigest: string;
  /** The file scope the confirmation names, as read with the same file: the start refuses when the project's has changed since. */
  readonly fsScope: LaunchFsScope | undefined;
}

export type LaunchState =
  | { readonly kind: 'idle'; readonly turn: number }
  | { readonly kind: 'picking'; readonly turn: number; readonly choices: readonly LaunchChoice[] }
  | {
      readonly kind: 'asking';
      readonly turn: number;
      readonly choices: readonly LaunchChoice[];
      readonly form: LaunchForm;
      readonly index: number;
    }
  | {
      readonly kind: 'confirming';
      readonly turn: number;
      readonly choices: readonly LaunchChoice[];
      readonly form: LaunchForm;
    }
  | {
      readonly kind: 'starting';
      readonly turn: number;
      readonly choice: LaunchChoice;
      readonly form: LaunchForm;
    }
  | { readonly kind: 'closed'; readonly turn: number; readonly notice: string };

export type LaunchEvent =
  | { readonly kind: 'opened'; readonly choices: readonly LaunchChoice[] }
  | {
      readonly kind: 'picked';
      readonly turn: number;
      readonly choice: LaunchChoice;
      readonly fields: readonly LaunchField[];
      /** The digest of the file text `fields` were built from, carried to the start. */
      readonly sourceDigest: string;
      /** The file scope read with it (`undefined` when the configuration could not be read: the start then reads it and refuses). */
      readonly fsScope?: LaunchFsScope | undefined;
    }
  /** The answer to the field being asked. `undefined` for a masked field (its value is in the hold, not here) or an omitted one. */
  | { readonly kind: 'answered'; readonly turn: number; readonly value: string | undefined }
  | { readonly kind: 'back'; readonly turn: number }
  | { readonly kind: 'confirmed'; readonly turn: number; readonly yes: boolean }
  | { readonly kind: 'launched'; readonly turn: number; readonly notice: string }
  /**
   * Leave the flow: `Ctrl+C`, a refusal, the Home closing, an aborted flow. In every state it closes the flow with the notice, `starting`
   * included: a flow that found its start already aborted would otherwise never settle, and `/run` and `r` would join a dead promise. A
   * stop that reaches `starting` BEFORE the driver called the host starts nothing; one that arrives after the host has the start closes
   * the flow and wipes what is held, and the host's late answer is ignored. The abort of the flow's signal is that stop, and the same
   * signal is the host's: it stops the host's leg while it prepares, so the start that was in flight cannot start a run afterwards
   * (a started run is the run view's to cancel).
   */
  | { readonly kind: 'stop'; readonly notice?: string | undefined };

export type LaunchEffect =
  | { readonly kind: 'pick'; readonly turn: number; readonly choices: readonly LaunchChoice[] }
  | {
      readonly kind: 'ask';
      readonly turn: number;
      readonly field: LaunchField;
      readonly position: number;
      readonly total: number;
      readonly form: LaunchForm;
    }
  | { readonly kind: 'confirm'; readonly turn: number; readonly form: LaunchForm }
  | { readonly kind: 'start'; readonly turn: number; readonly form: LaunchForm }
  /** Wipe masked values: the named ones (a field being left), or all of them. */
  | { readonly kind: 'forget'; readonly names: readonly string[] | 'all' }
  | { readonly kind: 'close'; readonly notice: string };

export interface LaunchStep {
  readonly state: LaunchState;
  readonly effects: readonly LaunchEffect[];
}

export const LAUNCH_CANCELLED = 'Run cancelled.';
export const LAUNCH_NO_WORKFLOWS =
  'No workflows to run in this project. Add one under .relavium/workflows (see /init).';

/** What `open(slug)` says when no valid workflow of the project carries that slug: no flow is begun and nothing is read by it. */
export function launchNotOffered(slug: string): string {
  return `Not started. ${bounded(slug, LABEL_LIMIT)} is not a valid workflow of this project.`;
}

/**
 * The names two files are known by in a refusal: their file names, without the workflow suffix when that leaves two different stems. A
 * path is longer than the message row (78 columns), so a message that carried paths showed none of them. The suffix stays when the two
 * stems are equal (`deploy.yaml` and `deploy.relavium.yaml` would otherwise both read `deploy`, and no remedy could tell them apart).
 */
function fileNames(first: string, second: string): readonly [string, string] {
  const a = basename(first);
  const b = basename(second);
  return fileStem(a) === fileStem(b) ? [a, b] : [fileStem(a), fileStem(b)];
}

/**
 * What `open(slug, path)` says when the file that holds `slug` now is not the one the list showed: a file that changed its id since the list
 * was read, or a second file that took the slug, would otherwise be confirmed and run under a file the person never saw. No flow is begun.
 * The remedy comes first, then the file that holds the slug now, by its full file name. The listed file is not named: the list reads again,
 * and naming it as well made the sentence longer than the 78-column row when the two names keep their suffixes.
 */
export function launchMoved(slug: string, now: string): string {
  return `Not started. Open the list again: ${bounded(slug, LABEL_LIMIT)} is now in ${bounded(basename(now), REASON_LIMIT)}.`;
}

/**
 * What `open(slug)` says when two valid files of the project declare that workflow id: no flow is begun, because which of the two a
 * `slug` means is not for this flow to guess (the export refuses a clash the same way). The remedy comes first, then the two file names
 * (the catalog's own paths are not shown; see {@link fileNames}).
 */
export function launchAmbiguous(slug: string, first: string, second: string): string {
  const [firstName, secondName] = fileNames(first, second);
  return `Not started. Rename one of ${bounded(firstName, REASON_LIMIT)} or ${bounded(secondName, REASON_LIMIT)}: both declare ${bounded(slug, LABEL_LIMIT)}.`;
}

/**
 * What the launch says when the file the person picked declares another workflow id by the time it is read: the list (or the row) is stale,
 * and nothing is confirmed under a name the file no longer carries. The remedy first, then the id the file declares now.
 */
export function launchChanged(slug: string, now: string): string {
  return `Not started. Open the list again: the file listed as ${bounded(slug, LABEL_LIMIT)} declares ${bounded(now, LABEL_LIMIT)} now.`;
}

const IGNORED = (state: LaunchState): LaunchStep => ({ state, effects: [] });

function withValue(
  values: Readonly<Record<string, string>>,
  name: string,
  value: string,
): Readonly<Record<string, string>> {
  // A null-prototype accumulator: an input may be named `__proto__` (the name grammar allows it).
  const out: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const key of Object.keys(values)) out[key] = values[key] ?? '';
  out[name] = value;
  return out;
}

function withoutValue(
  values: Readonly<Record<string, string>>,
  name: string,
): Readonly<Record<string, string>> {
  const out: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const key of Object.keys(values)) if (key !== name) out[key] = values[key] ?? '';
  return out;
}

function ask(turn: number, form: LaunchForm, index: number): LaunchEffect {
  const field = form.fields[index];
  if (field === undefined) throw new CliError('cli_internal', 'launch form index out of range');
  return { kind: 'ask', turn, field, position: index + 1, total: form.fields.length, form };
}

/** Go to the field at `index`, or to the confirmation when the form has no more. */
function toField(
  state: { readonly turn: number },
  choices: readonly LaunchChoice[],
  form: LaunchForm,
  index: number,
  forget: readonly string[],
): LaunchStep {
  const turn = state.turn + 1;
  const wipe: LaunchEffect[] = forget.length === 0 ? [] : [{ kind: 'forget', names: forget }];
  if (index < form.fields.length)
    return {
      state: { kind: 'asking', turn, choices, form, index },
      effects: [...wipe, ask(turn, form, index)],
    };
  return {
    state: { kind: 'confirming', turn, choices, form },
    effects: [...wipe, { kind: 'confirm', turn, form }],
  };
}

function toPicker(
  state: Extract<LaunchState, { kind: 'asking' | 'confirming' }>,
  forget: LaunchEffect,
): LaunchStep {
  const turn = state.turn + 1;
  return {
    state: { kind: 'picking', turn, choices: state.choices },
    effects: [forget, { kind: 'pick', turn, choices: state.choices }],
  };
}

function closeWith(state: LaunchState, notice: string): LaunchStep {
  return {
    state: { kind: 'closed', turn: state.turn + 1, notice },
    effects: [
      { kind: 'forget', names: 'all' },
      { kind: 'close', notice },
    ],
  };
}

function reduceAnswer(
  state: Extract<LaunchState, { kind: 'asking' }>,
  value: string | undefined,
): LaunchStep {
  const field = state.form.fields[state.index];
  if (field === undefined) return IGNORED(state);
  // A masked value is not an event payload: the driver answers a masked field with `undefined` and keeps the value in the hold, so the
  // machine never sees one. An empty answer is "omitted" and records nothing.
  const values =
    value === undefined || value === ''
      ? state.form.values
      : withValue(state.form.values, field.name, value);
  return toField(state, state.choices, { ...state.form, values }, state.index + 1, []);
}

function reduceBack(state: Extract<LaunchState, { kind: 'asking' | 'confirming' }>): LaunchStep {
  const index = state.kind === 'asking' ? state.index : state.form.fields.length;
  const previous = state.form.fields[index - 1];
  if (previous === undefined) return toPicker(state, { kind: 'forget', names: 'all' });
  // The field being returned to is asked again from nothing: its earlier value (a masked one above all) is dropped.
  const form = { ...state.form, values: withoutValue(state.form.values, previous.name) };
  return toField(state, state.choices, form, index - 1, [previous.name]);
}

type EventOf<Kind extends LaunchEvent['kind']> = Extract<LaunchEvent, { readonly kind: Kind }>;

function reduceOpened(state: LaunchState, event: EventOf<'opened'>): LaunchStep {
  if (state.kind !== 'idle') return IGNORED(state);
  if (event.choices.length === 0) return closeWith(state, LAUNCH_NO_WORKFLOWS);
  const turn = state.turn + 1;
  return {
    state: { kind: 'picking', turn, choices: event.choices },
    effects: [{ kind: 'pick', turn, choices: event.choices }],
  };
}

function reducePicked(state: LaunchState, event: EventOf<'picked'>): LaunchStep {
  if (state.kind !== 'picking' || event.turn !== state.turn) return IGNORED(state);
  const form: LaunchForm = {
    choice: event.choice,
    fields: event.fields,
    values: Object.create(null) as Record<string, string>,
    sourceDigest: event.sourceDigest,
    fsScope: event.fsScope,
  };
  return toField(state, state.choices, form, 0, []);
}

function reduceAnswered(state: LaunchState, event: EventOf<'answered'>): LaunchStep {
  if (state.kind !== 'asking' || event.turn !== state.turn) return IGNORED(state);
  return reduceAnswer(state, event.value);
}

function reduceBackEvent(state: LaunchState, event: EventOf<'back'>): LaunchStep {
  if ((state.kind !== 'asking' && state.kind !== 'confirming') || event.turn !== state.turn)
    return IGNORED(state);
  return reduceBack(state);
}

function reduceConfirmed(state: LaunchState, event: EventOf<'confirmed'>): LaunchStep {
  // THE LATCH (ADR-0139 §2): only the current confirmation answers, and answering moves the machine on. A second `Enter` in the
  // same tick finds `starting` here, and emits nothing.
  if (state.kind !== 'confirming' || event.turn !== state.turn) return IGNORED(state);
  if (!event.yes) return closeWith(state, LAUNCH_CANCELLED);
  const turn = state.turn + 1;
  return {
    state: { kind: 'starting', turn, choice: state.form.choice, form: state.form },
    effects: [{ kind: 'start', turn, form: state.form }],
  };
}

function reduceLaunched(state: LaunchState, event: EventOf<'launched'>): LaunchStep {
  if (state.kind !== 'starting' || event.turn !== state.turn) return IGNORED(state);
  return closeWith(state, event.notice);
}

/**
 * The whole launch flow as a pure function: a state and an event in, the next state and the effects to run out. Nothing here reads a
 * clock, a prompt, a file or a host. An event for a prompt that is no longer the current one is ignored. Each event has its own small
 * reducer above, so what one answers is read in one place.
 */
export function reduceLaunch(state: LaunchState, event: LaunchEvent): LaunchStep {
  if (state.kind === 'closed') return IGNORED(state);
  switch (event.kind) {
    case 'opened':
      return reduceOpened(state, event);
    case 'stop':
      // `starting` is no exception: an ignored stop left `done` pending for good when the flow was aborted before the host was called.
      return closeWith(state, event.notice ?? LAUNCH_CANCELLED);
    case 'picked':
      return reducePicked(state, event);
    case 'answered':
      return reduceAnswered(state, event);
    case 'back':
      return reduceBackEvent(state, event);
    case 'confirmed':
      return reduceConfirmed(state, event);
    case 'launched':
      return reduceLaunched(state, event);
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// The catalog the picker offers, and the one-line reasons for what it does not.
// ---------------------------------------------------------------------------------------------------------------------

/** The tiers of `[defaults].fs_scope`, as the run host's tool environment reads them (`sandboxed` when the config names none). */
export type LaunchFsTier = NonNullable<LoadedConfig['config']['fsScope']>;

/**
 * The file scope a start would run under, read when the workflow was picked: the tier, and whether a repository's own configuration set it.
 * The only layers that carry `fs_scope` are the project and workspace files, so a tier that is not the default always came from the
 * repository (`.relavium/project.toml` or `workspace.toml`).
 */
export interface LaunchFsScope {
  readonly tier: LaunchFsTier;
  readonly fromRepository: boolean;
}

/** A workflow file read once: what it parsed to, and the digest of the exact text that was parsed. */
export interface LoadedWorkflow {
  readonly definition: WorkflowDefinition;
  /** `workflowSourceDigest` of the text `definition` was parsed from: the one the start is later checked against. */
  readonly sourceDigest: string;
  /**
   * The file scope the same pick found. A catalog that reports none (a stub) leaves the confirmation naming no scope, which reads as the
   * default, so the start is bound to `sandboxed`: the scope the confirmation implied.
   */
  readonly fsScope?: LaunchFsScope | undefined;
}

/** The project's workflow files and their parsed definitions, behind a port so the flow is testable without a project. */
export interface LaunchCatalog {
  /** Every workflow file, valid or not. May throw a {@link CliError} (an unreadable catalog directory). */
  readonly list: () => readonly CatalogEntry[];
  /**
   * Read and parse one file by its project-relative path, ONCE: the definition and the digest come from the same text, so the form and
   * the confirmation built from the first are bound by the second. Throws a {@link CliError} for a path that no longer resolves or parses.
   */
  readonly load: (path: string) => LoadedWorkflow;
}

/**
 * The catalog of the project the Home is in. The project directory is found afresh on every read, as a chat finds it when it is
 * built: a `.relavium/` that `/init` made in this very Home, or another terminal's checkout, is seen without a restart.
 */
export function createProjectCatalog(options: {
  readonly cwd: string;
  readonly projectConfigDir: () => string | undefined;
  readonly homeDir: string;
  /** The global `--config` override, as a start loads its configuration (so the scope shown is the scope a start reads). */
  readonly configPath?: string | undefined;
}): LaunchCatalog {
  const { cwd, homeDir } = options;
  return {
    list: () => {
      const projectConfigDir = options.projectConfigDir();
      return projectConfigDir === undefined
        ? []
        : discoverCatalog({ projectConfigDir, cwd, kind: 'workflows', homeDir });
    },
    load: (path) => {
      const source = resolveWorkflowSource(path, {
        cwd,
        projectConfigDir: options.projectConfigDir(),
        homeDir,
      });
      try {
        const definition = parseWorkflow(source.yaml, { source: sourceLabel(cwd, source.path) });
        // The digest is of the very string the parse was given. The host digests the string IT reads the same way, before it parses.
        return {
          definition,
          sourceDigest: workflowSourceDigest(source.yaml),
          fsScope: readFsScope(cwd, homeDir, options.configPath),
        };
      } catch (cause) {
        if (cause instanceof WorkflowParseError)
          throw new CliError('invalid_invocation', cause.message, { cause });
        throw cause;
      }
    },
  };
}

/**
 * The file scope a start from `cwd` would use, read the way the start reads it. A configuration that cannot be read REFUSES the pick
 * (L1), with the file named from the project or `~` and never by its absolute path: the start would refuse it anyway, and a
 * confirmation that named no scope because none could be read would read as `sandboxed`, which is a claim nobody checked. The refusal
 * comes before the form, so no input (a masked one above all) is typed for a start that cannot happen.
 */
function readFsScope(cwd: string, homeDir: string, configPath: string | undefined): LaunchFsScope {
  try {
    const { config } = loadResolvedConfig({ cwd, configPath, home: homeDir });
    return { tier: config.fsScope ?? 'sandboxed', fromRepository: config.fsScope !== undefined };
  } catch (cause) {
    const shown = faultForTranscript(cause, { cwd, homeDir });
    if (shown instanceof ConfigError)
      throw new CliError('invalid_invocation', `Not started. ${shown.message}`, { cause: shown });
    throw cause;
  }
}

const LABEL_LIMIT = 60;
const REASON_LIMIT = 80;
const SKIPPED_LISTED = 3;

/** What a workflow is called on the picker, the confirmation and the notices: its name, or its id when it has none. One rule for the list read and the pick read. */
function workflowLabel(name: string | undefined, id: string): string {
  return bounded(name ?? id, LABEL_LIMIT);
}

function bounded(text: string, limit: number): string {
  const clean = sanitizeUntrustedInline(text);
  return clean.length <= limit ? clean : `${clean.slice(0, limit - 1)}…`;
}

/** The valid entries as choices, and the invalid ones as one line saying why they are not offered. */
export function offeredWorkflows(entries: readonly CatalogEntry[]): {
  readonly choices: readonly LaunchChoice[];
  readonly skipped: string | undefined;
} {
  const choices: LaunchChoice[] = [];
  const invalid: CatalogEntry[] = [];
  for (const entry of entries) {
    if (entry.valid)
      choices.push({
        path: entry.path,
        slug: entry.slug,
        label: workflowLabel(entry.name, entry.slug),
      });
    else invalid.push(entry);
  }
  if (invalid.length === 0) return { choices, skipped: undefined };
  const listed = invalid
    .slice(0, SKIPPED_LISTED)
    .map(
      (entry) =>
        `${bounded(entry.slug, LABEL_LIMIT)} (${bounded(entry.error ?? 'could not be read', REASON_LIMIT)})`,
    );
  const more = invalid.length > listed.length ? `, and ${invalid.length - listed.length} more` : '';
  return { choices, skipped: `Not offered, the file is not valid: ${listed.join('; ')}${more}.` };
}

// ---------------------------------------------------------------------------------------------------------------------
// The form: one field per declared input, validated by the one core validator.
// ---------------------------------------------------------------------------------------------------------------------

const DESCRIPTION_LIMIT = 100;
const DEFAULT_LIMIT = 40;

function scalarDefault(value: unknown): string | undefined {
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
    ? String(value)
    : undefined;
}

/** One field per declared input, in declaration order; what the author wrote passes the sanitize floor. */
export function launchFields(def: WorkflowDefinition): readonly LaunchField[] {
  const declared = def.workflow.inputs ?? [];
  return declared.map((decl, index) => {
    const secret = decl.type === 'secret';
    const required = decl.required === true && decl.default === undefined;
    const traits = [decl.type, required ? 'required' : 'optional'];
    // A scalar default is shown; a list or an object is not (and a secret has none).
    const scalar = scalarDefault(decl.default);
    const fallback =
      !secret && scalar !== undefined ? `default ${bounded(scalar, DEFAULT_LIMIT)}` : undefined;
    if (fallback !== undefined) traits.push(fallback);
    const description =
      decl.description === undefined || decl.description === ''
        ? ''
        : ` — ${bounded(decl.description, DESCRIPTION_LIMIT)}`;
    return {
      name: decl.name,
      type: decl.type,
      secret,
      required,
      label: `Input ${String(index + 1)} of ${String(declared.length)}: ${decl.name} (${traits.join(', ')})${description}`,
    };
  });
}

function nullProto(name: string, value: string): Record<string, string> {
  const out: Record<string, string> = Object.create(null) as Record<string, string>;
  out[name] = value;
  return out;
}

/**
 * What is wrong with one field's value, or `undefined`. The workflow's own validator runs over a workflow that declares only this
 * input, so it judges exactly this value (its type, its enum, its bounds) and none of the inputs not asked yet. The text it returns
 * is the validator's structural, value-free reason, so a rejected secret is never echoed.
 */
export function fieldIssue(
  def: WorkflowDefinition,
  field: LaunchField,
  value: string,
): string | undefined {
  if (value === '') return field.required ? 'A value is required.' : undefined;
  const decl = (def.workflow.inputs ?? []).find((candidate) => candidate.name === field.name);
  if (decl === undefined) return 'This input is not declared by the workflow.';
  const probe: WorkflowDefinition = { ...def, workflow: { ...def.workflow, inputs: [decl] } };
  try {
    const given = nullProto(field.name, value);
    const coerced = field.secret ? resolveInputs(probe, {}, given) : resolveInputs(probe, given);
    const admitted = resolveAndValidateWorkflowInputs(probe, coerced);
    return admitted.ok
      ? undefined
      : bounded(admitted.issues[0]?.message ?? 'The value is not valid.', 160);
  } catch (cause) {
    return isCliError(cause) ? bounded(cause.message, 160) : 'The value is not valid.';
  }
}

/** The whole form, once: what `prepareRun` will check again, so a refusal is found while the person is still in the form. */
function formIssue(
  def: WorkflowDefinition,
  values: Readonly<Record<string, string>>,
  secrets: Readonly<Record<string, string>>,
): string | undefined {
  try {
    const admitted = resolveAndValidateWorkflowInputs(def, resolveInputs(def, values, secrets));
    return admitted.ok ? undefined : inputAdmissionMessage(admitted.issues);
  } catch (cause) {
    return isCliError(cause) ? bounded(cause.message, 240) : 'The inputs are not valid.';
  }
}

const SUMMARY_VALUE_LIMIT = 24;
const SUMMARY_LIMIT = 200;

/**
 * The confirmation's question: the workflow and each input, a masked one by name only. When the inputs do not all fit
 * {@link SUMMARY_LIMIT}, as many whole `name=value` entries as fit are shown and the rest are counted (`and 3 more`), so a later input is
 * never silently out of the question (M-3). Even the first may not fit (a long label): the count then stands alone.
 */
/** One `name=value` per input that was given (or is secret): a masked one by name only, never its value. */
function givenInputs(form: LaunchForm, masked: ReadonlySet<string>): readonly string[] {
  return form.fields
    .filter((field) => field.secret || Object.hasOwn(form.values, field.name))
    .map((field) => {
      if (!field.secret)
        return `${field.name}=${bounded(form.values[field.name] ?? '', SUMMARY_VALUE_LIMIT)}`;
      return masked.has(field.name) ? `${field.name}=••••` : `${field.name}=(none)`;
    });
}

/** ` with a=1, b=2`, with what did not fit counted: ` with a=1 and 3 more`, or ` with 4 inputs` when not even one entry fits. */
function inputsClause(given: readonly string[], shown: number): string {
  const hidden = given.length - shown;
  if (given.length === 0) return '';
  if (shown === 0) return ` with ${String(hidden)} input${hidden === 1 ? '' : 's'}`;
  const listed = given.slice(0, shown).join(', ');
  return hidden === 0 ? ` with ${listed}` : ` with ${listed} and ${String(hidden)} more`;
}

function confirmationQuestion(form: LaunchForm, masked: ReadonlySet<string>): string {
  const given = givenInputs(form, masked);
  const head = `Run ${form.choice.label}`;
  for (let shown = given.length; shown > 0; shown -= 1) {
    const question = `${head}${inputsClause(given, shown)}?`;
    if (sanitizeUntrustedInline(question).length <= SUMMARY_LIMIT)
      return bounded(question, SUMMARY_LIMIT);
  }
  return bounded(`${head}${inputsClause(given, 0)}?`, SUMMARY_LIMIT);
}

// ---------------------------------------------------------------------------------------------------------------------
// What the run can do: the sentence that stands above the question.
// ---------------------------------------------------------------------------------------------------------------------

/** The most characters the host's sentence takes: four rows at 80 columns, so the whole card stays far inside 24 rows. */
const AUTHORITY_LIMIT = 280;
/** How many allowed commands and MCP servers are named before the rest are counted, and how much of each name is shown. */
const COMMANDS_SHOWN = 2;
const COMMAND_NAME_LIMIT = 22;
const SERVERS_SHOWN = 3;
const SERVER_NAME_LIMIT = 22;

/** The built-in tools' own classification, by id: the one place a tool is known to write, so no list of names is kept here. */
const TOOL_POLICY = new Map(BUILTIN_TOOLS.map((tool) => [tool.id, tool.policy]));

/**
 * The tools the workflow's agent nodes may call: a node's own `tools` (which only narrows) or else its inline agent's. A `$ref` agent
 * is not read by the launch (the CLI reads no agent file while it prepares), so a node bound to one adds nothing here.
 */
function grantedTools(def: WorkflowDefinition): ReadonlySet<string> {
  const inline = new Map<string, readonly string[] | undefined>();
  for (const agent of def.workflow.agents ?? [])
    if ('id' in agent) inline.set(agent.id, agent.tools);
  const granted = new Set<string>();
  for (const node of def.workflow.nodes)
    if (node.type === 'agent')
      for (const tool of node.tools ?? inline.get(node.agent_ref) ?? []) granted.add(tool);
  return granted;
}

/** The MCP servers the workflow's inline agents declare, by the name each is known by (a registration name, or the inline id), once each. */
function declaredServers(def: WorkflowDefinition): readonly string[] {
  const names = new Set<string>();
  for (const agent of def.workflow.agents ?? [])
    if ('id' in agent)
      for (const server of agent.mcp_servers ?? []) {
        const name = server.ref ?? server.id;
        if (name !== undefined) names.add(name);
      }
  return [...names];
}

/**
 * Author text inside the host's sentence: through the sanitize floor, bounded, and in double quotes (a quote inside it becomes an
 * apostrophe), so what the workflow's author wrote reads as a quoted name and can never continue the sentence it stands in.
 */
function quoted(text: string, limit: number): string {
  return `"${bounded(text, limit).replaceAll('"', "'")}"`;
}

/**
 * `run commands` with the first allowed ones NAMED (the exact entries, then the patterns), because a count says nothing about what
 * runs: one `bash` or `npm run x` is arbitrary code under the person's own account. It says the file scope does not limit them, because
 * the scope is the jail of the file tools and a command is not inside it. With no allowlist the tool is disabled (ADR-0029): a grant
 * alone lets nothing run, and nothing is said.
 */
function commandsClause(def: WorkflowDefinition, granted: ReadonlySet<string>): string | undefined {
  const allowed = [
    ...(def.workflow.tools?.allowedCommands ?? []),
    ...(def.workflow.tools?.allowedCommandGlobs ?? []),
  ];
  if (!granted.has('run_command') || allowed.length === 0) return undefined;
  const shown = allowed
    .slice(0, COMMANDS_SHOWN)
    .map((command) => quoted(command, COMMAND_NAME_LIMIT));
  const rest = allowed.length - shown.length;
  return `run commands, which the file scope does not limit (${shown.join(', ')}${rest > 0 ? `, and ${String(rest)} more` : ''})`;
}

/**
 * The built-in tools that start a process of their own (the git tools) are named by id: they run whatever git does with the working
 * tree, outside what the file scope bounds, and `run_command` has its own clause. Only the ids of tools the host itself ships are
 * named, so nothing an author wrote is put in this clause.
 */
function processToolsClause(granted: ReadonlySet<string>): string | undefined {
  const names = [...granted]
    .filter((tool) => tool !== 'run_command' && TOOL_POLICY.get(tool)?.spawnsProcess === true)
    .sort();
  return names.length === 0 ? undefined : `start processes (${names.join(', ')})`;
}

function serversClause(def: WorkflowDefinition): string | undefined {
  const servers = declaredServers(def);
  if (servers.length === 0) return undefined;
  const shown = servers.slice(0, SERVERS_SHOWN).map((name) => quoted(name, SERVER_NAME_LIMIT));
  const rest = servers.length - shown.length;
  return `use MCP ${servers.length === 1 ? 'server' : 'servers'} ${shown.join(', ')}${rest > 0 ? ` and ${String(rest)} more` : ''}`;
}

/**
 * What a Yes lets the run do, in one bounded passage that is the HOST's: it is drawn as its own row above the question (the card's
 * note), so the workflow's name, which the question carries, cannot continue it, and every author word inside it is quoted. It is
 * built from the SAME bytes the confirmation binds: the definition read at the pick (its digest goes to the start) and the file scope
 * read with it (which the start checks again). The run is unattended: nothing asks again.
 *
 * - The file scope comes FIRST and is shown whenever it is not the default (`sandboxed`): a repository's own configuration can widen
 *   it, and the person confirming a workflow has not read that file.
 * - Then what the workflow's own definition grants: running commands (the first allowed ones named, and the words that the file scope
 *   does not limit them), the git tools by id, writing files, and the MCP servers it starts (a local program still meets its own
 *   consent card).
 *
 * `undefined` when there is nothing to say, so a workflow that can only read inside its workspace is asked about as it always was.
 */
export function launchAuthorityNote(
  def: WorkflowDefinition,
  fsScope: LaunchFsScope | undefined,
): string | undefined {
  const granted = grantedTools(def);
  const clauses = [
    commandsClause(def, granted),
    processToolsClause(granted),
    [...granted].some((tool) => TOOL_POLICY.get(tool)?.fsWrite === true)
      ? 'write files'
      : undefined,
    serversClause(def),
  ].filter((clause): clause is string => clause !== undefined);
  const sentences = [
    fsScope === undefined || fsScope.tier === 'sandboxed'
      ? undefined
      : `File scope: ${fsScope.tier}${fsScope.fromRepository ? ', set by this repository' : ''}.`,
    clauses.length === 0 ? undefined : `This run can ${clauses.join('; ')}.`,
  ].filter((sentence): sentence is string => sentence !== undefined);
  return sentences.length === 0 ? undefined : bounded(sentences.join(' '), AUTHORITY_LIMIT);
}

// ---------------------------------------------------------------------------------------------------------------------
// The masked values, held away from everything else.
// ---------------------------------------------------------------------------------------------------------------------

interface SecretHold {
  readonly set: (name: string, value: string) => void;
  readonly names: () => ReadonlySet<string>;
  /** A fresh copy for ONE validation call; it is not kept. */
  readonly copy: () => Readonly<Record<string, string>>;
  readonly forget: (names: readonly string[] | 'all') => void;
  /** What `start` is given: the values for the names the run core asks for, once, and then nothing is left. */
  readonly port: HostedSecretPort;
}

function createSecretHold(): SecretHold {
  const held = new Map<string, string>();
  const copy = (): Readonly<Record<string, string>> => {
    const out: Record<string, string> = Object.create(null) as Record<string, string>;
    for (const [name, value] of held) out[name] = value;
    return out;
  };
  return {
    set: (name, value) => {
      held.set(name, value);
    },
    names: () => new Set(held.keys()),
    copy,
    forget: (names) => {
      if (names === 'all') held.clear();
      else for (const name of names) held.delete(name);
    },
    port: (names) => {
      const out: Record<string, string> = Object.create(null) as Record<string, string>;
      for (const name of names) {
        const value = held.get(name);
        if (value !== undefined) out[name] = value;
      }
      held.clear();
      return Promise.resolve(out);
    },
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// The driver.
// ---------------------------------------------------------------------------------------------------------------------

export interface RunLaunchDeps {
  /** The Home's native prompt flow: the only place a field, a card or a masked value is ever asked. */
  readonly flow: Pick<
    NativePromptFlow,
    'begin' | 'end' | 'note' | 'busy' | 'select' | 'text' | 'password' | 'confirm'
  >;
  /**
   * `snapshot` is read once, before the form opens: with a leg preparing or executing the host refuses every start, so asking the
   * person for a workflow, its inputs and a confirmation only to say so at the end wastes the form (and a typed secret).
   * Absent, the host's refusal at the end is the only one.
   */
  readonly host: Pick<RunHost, 'start'> & { readonly snapshot?: () => RunHostSnapshot };
  readonly catalog: LaunchCatalog;
  /** Throws when the Home is closing; called before anything is asked. */
  readonly assertAdmitting?: (() => void) | undefined;
  /**
   * Every state the machine enters. It holds no secret by construction; this is the one place its states are visible, and the tests
   * assert on each of them.
   */
  readonly observe?: ((state: LaunchState) => void) | undefined;
}

/** A launch in flight: the machine, and the way an event reaches it. */
export interface LaunchSession {
  readonly state: () => LaunchState;
  readonly dispatch: (event: LaunchEvent) => void;
}

export interface RunLaunch {
  /**
   * Run the launch flow once and resolve with the notice the Home shows. A second call while one is open joins it. It rejects only
   * for a fault no refusal describes; every refusal is a notice.
   *
   * With a `slug` the picker is skipped once and the form starts for that workflow (the Defined tab's `r`), through the same
   * machine, validation, confirmation (default No) and single-start latch. The slug is only COMPARED with the slugs of the valid
   * catalog entries: it is never a path, never read from disk, and one that matches no entry opens nothing ({@link launchNotOffered}).
   * `Esc` at the first field steps back to the picker, which then opens on that workflow. With the catalog `path` the row was listed
   * from, the flow refuses a slug whose file is another one now ({@link launchMoved}), so the form and the confirmation (which name the
   * workflow by its label) are never shown for a file the person did not see. It is compared with the fresh catalog's own path and is
   * never read or resolved. The file the flow then reads must still declare the id it was listed under ({@link launchChanged}).
   */
  readonly open: (slug?: string, path?: string) => Promise<string>;
  /** The launch in flight, if any. */
  readonly session: () => LaunchSession | undefined;
}

/**
 * What `open` says, before it opens anything, when the host is already hosting a leg: which run, and where it is. The id is cut and put
 * through the one-line floor (`shortRunId`); the remedy is the strip's own row, which `Enter` reopens ([ADR-0139] §3).
 */
export function launchBusy(snapshot: RunHostSnapshot): string | undefined {
  if (!snapshot.launching && snapshot.active === undefined) return undefined;
  const runId = snapshot.active?.runId;
  return runId === undefined
    ? 'A run is already starting.'
    : `A run is already executing (${shortRunId(runId)}). Enter on its ▶ row opens it.`;
}

function launchNotice(choice: LaunchChoice, launch: HostedLaunch): string {
  if (launch.kind === 'started')
    return `Started ${choice.label} as run ${sanitizeUntrustedInline(launch.runId)}. It runs in the background.`;
  return sanitizeUntrustedInline(launch.message);
}

const FIELD_PROMPT_ESCAPE = 'back';

/** What `open` has settled before it begins a flow: the notice that ends it, or the offered workflows (and what was skipped) to begin on. */
type Admission =
  | { readonly kind: 'refused'; readonly notice: string }
  | {
      readonly kind: 'admitted';
      readonly choices: readonly LaunchChoice[];
      readonly skipped: string | undefined;
    };

/**
 * A slug that names no offered workflow starts no flow at all: nothing is begun, asked or loaded for it. Two files that declare it are
 * refused too, naming both: the first of them is not the one the person meant. With a `path` the row was listed from, a slug whose file
 * is another one now is refused as well. `undefined` when the slug (or no slug) may begin a flow.
 */
function slugRefusal(
  choices: readonly LaunchChoice[],
  slug: string | undefined,
  path: string | undefined,
): string | undefined {
  if (slug === undefined) return undefined;
  const [first, second] = choices.filter((choice) => choice.slug === slug);
  if (first === undefined) return launchNotOffered(slug);
  if (second !== undefined) return launchAmbiguous(slug, first.path, second.path);
  return path !== undefined && first.path !== path ? launchMoved(slug, first.path) : undefined;
}

/** The catalog read and its refusals, before anything is asked: an unreadable catalog, nothing to run, or a slug that cannot begin. */
function admit(deps: RunLaunchDeps, slug: string | undefined, path: string | undefined): Admission {
  let entries: readonly CatalogEntry[];
  try {
    entries = deps.catalog.list();
  } catch (cause) {
    if (isCliError(cause))
      return { kind: 'refused', notice: sanitizeUntrustedInline(cause.message) };
    throw cause;
  }
  const { choices, skipped } = offeredWorkflows(entries);
  if (choices.length === 0)
    return {
      kind: 'refused',
      notice: skipped === undefined ? LAUNCH_NO_WORKFLOWS : `${LAUNCH_NO_WORKFLOWS} ${skipped}`,
    };
  const refusal = slugRefusal(choices, slug, path);
  return refusal === undefined
    ? { kind: 'admitted', choices, skipped }
    : { kind: 'refused', notice: refusal };
}

export function createRunLaunch(deps: RunLaunchDeps): RunLaunch {
  const { flow } = deps;
  let current: { readonly session: LaunchSession; readonly done: Promise<string> } | undefined;

  const open = async (slug?: string, path?: string): Promise<string> => {
    if (current !== undefined) return current.done;
    deps.assertAdmitting?.();
    const busy = deps.host.snapshot === undefined ? undefined : launchBusy(deps.host.snapshot());
    if (busy !== undefined) return busy;
    const admission = admit(deps, slug, path);
    if (admission.kind === 'refused') return admission.notice;
    const { choices, skipped } = admission;

    const signal = flow.begin();
    const hold = createSecretHold();
    const running = runSession({ deps, hold, signal, preselect: slug, skipped });
    current = { session: running.session, done: running.done };
    try {
      if (skipped !== undefined) flow.note(skipped, 'Run workflow');
      running.session.dispatch({ kind: 'opened', choices });
      const notice = await running.done;
      if (running.fault !== undefined) throw running.fault.cause;
      return notice;
    } finally {
      current = undefined;
      hold.forget('all');
      await flow.end();
    }
  };

  return { open, session: () => current?.session };
}

interface SessionRun {
  readonly session: LaunchSession;
  readonly done: Promise<string>;
  fault: { readonly cause: unknown } | undefined;
}

/** The machine and the loop that runs its effects. */
function runSession(options: {
  readonly deps: RunLaunchDeps;
  readonly hold: SecretHold;
  readonly signal: AbortSignal;
  /** The slug the picker is skipped for, once; the picker opens on it when the person steps back to it. */
  readonly preselect?: string | undefined;
  /** The line the picker showed about the files it did not offer: put back when a card that replaced it is left. */
  readonly skipped?: string | undefined;
}): SessionRun {
  const { deps, hold, signal, preselect, skipped } = options;
  const { flow, host, catalog } = deps;
  let preselected = preselect !== undefined; // the picker is skipped only the first time
  let state: LaunchState = { kind: 'idle', turn: 0 };
  let loaded: WorkflowDefinition | undefined;
  let finish: (notice: string) => void = () => undefined;
  const done = new Promise<string>((resolve) => {
    finish = resolve;
  });
  const run: SessionRun = {
    done,
    fault: undefined,
    session: { state: () => state, dispatch: (event) => dispatch(event) },
  };

  function dispatch(event: LaunchEvent): void {
    const step = reduceLaunch(state, event);
    if (step.state !== state) {
      state = step.state;
      deps.observe?.(state);
    }
    for (const effect of step.effects) execute(effect);
  }

  /** The note the flow carried before a card put its own row there: the skipped files the picker named, or none. */
  function restoreNote(): void {
    if (skipped === undefined) flow.note('');
    else flow.note(skipped, 'Run workflow');
  }

  function fail(cause: unknown): void {
    // An expected refusal is a notice; anything else is carried out to the caller, after the flow is closed.
    let notice: string;
    if (isCliError(cause) && cause.code === 'invalid_invocation')
      notice = sanitizeUntrustedInline(cause.message);
    else {
      run.fault = { cause };
      notice = 'The run could not be started.';
    }
    // A run that is starting is closed by its own outcome; every other state, by a stop.
    if (state.kind === 'starting') dispatch({ kind: 'launched', turn: state.turn, notice });
    else dispatch({ kind: 'stop', notice });
  }

  function execute(effect: LaunchEffect): void {
    switch (effect.kind) {
      case 'forget':
        hold.forget(effect.names);
        return;
      case 'close':
        finish(effect.notice);
        return;
      case 'pick':
        void pick(effect).catch(fail);
        return;
      case 'ask':
        void askField(effect).catch(fail);
        return;
      case 'confirm':
        void confirm(effect).catch(fail);
        return;
      case 'start':
        void start(effect).catch(fail);
        return;
    }
  }

  async function pick(effect: Extract<LaunchEffect, { kind: 'pick' }>): Promise<void> {
    const at = preselect === undefined ? -1 : effect.choices.findIndex((c) => c.slug === preselect);
    let answer: string | symbol;
    if (preselected && at >= 0) {
      // The Defined tab asked for this workflow: the picker is skipped this once, and everything after it is the ordinary flow.
      preselected = false;
      answer = String(at);
    } else {
      preselected = false;
      answer = await flow.select({
        message: 'Run which workflow?',
        options: effect.choices.map((choice, index) => ({
          value: String(index),
          label: choice.label,
          hint: bounded(choice.path, REASON_LIMIT),
        })),
        ...(at >= 0 ? { initialValue: String(at) } : {}),
        escape: 'cancel',
      });
    }
    const choice = typeof answer === 'string' ? effect.choices[Number(answer)] : undefined;
    if (choice === undefined) {
      dispatch({ kind: 'stop' });
      return;
    }
    const fresh = catalog.load(choice.path);
    // The file is read again here, after the list: what it declares now must be what the list showed, or the form and the confirmation
    // would name one workflow and run another.
    if (fresh.definition.workflow.id !== choice.slug)
      throw new CliError(
        'invalid_invocation',
        launchChanged(choice.slug, fresh.definition.workflow.id),
      );
    loaded = fresh.definition;
    // The digest of that very read goes into the form, and so to the start: the id above is a name, this is the content. The label the
    // confirmation prints is rebuilt from the same read: the list's label may be from a file that has changed since (a new `name:`
    // with the id kept), and the question would then name one workflow over the graph another file digested.
    const named: LaunchChoice = {
      ...choice,
      label: workflowLabel(fresh.definition.workflow.name, fresh.definition.workflow.id),
    };
    dispatch({
      kind: 'picked',
      turn: effect.turn,
      choice: named,
      fields: launchFields(fresh.definition),
      sourceDigest: fresh.sourceDigest,
      fsScope: fresh.fsScope,
    });
  }

  async function askField(effect: Extract<LaunchEffect, { kind: 'ask' }>): Promise<void> {
    const { field, turn } = effect;
    const def = loaded;
    if (def === undefined) throw new CliError('cli_internal', 'launch form has no workflow');
    const message = field.label;
    const validate = (value: string): string | undefined => fieldIssue(def, field, value);
    let answer: string | symbol;
    if (field.type === 'boolean') {
      answer = await flow.select({
        message,
        options: [
          { value: 'true', label: 'true' },
          { value: 'false', label: 'false' },
          ...(field.required ? [] : [{ value: '', label: '(use the default)' }]),
        ],
        escape: FIELD_PROMPT_ESCAPE,
      });
    } else if (field.secret) {
      answer = await flow.password({ message, validate, escape: FIELD_PROMPT_ESCAPE });
    } else {
      answer = await flow.text({ message, validate, escape: FIELD_PROMPT_ESCAPE });
    }
    if (answer === NATIVE_PROMPT_BACK) {
      dispatch({ kind: 'back', turn });
      return;
    }
    if (typeof answer !== 'string') {
      dispatch({ kind: 'stop' });
      return;
    }
    if (field.secret) {
      // The value goes into the hold and nowhere else: the event carries none.
      if (answer !== '') hold.set(field.name, answer);
      dispatch({ kind: 'answered', turn, value: undefined });
      return;
    }
    dispatch({ kind: 'answered', turn, value: answer });
  }

  async function confirm(effect: Extract<LaunchEffect, { kind: 'confirm' }>): Promise<void> {
    const def = loaded;
    if (def === undefined) throw new CliError('cli_internal', 'launch form has no workflow');
    const refusal = formIssue(def, effect.form.values, hold.copy());
    if (refusal !== undefined) {
      dispatch({ kind: 'stop', notice: `Not started. ${refusal}` });
      return;
    }
    // What the run can do is the HOST's own row above the question (the card's note): the workflow's name, which the question carries,
    // is in another row and cannot continue it. It stays only while this card is up, and the picker's note is put back after it.
    const authority = launchAuthorityNote(def, effect.form.fsScope);
    if (authority !== undefined) flow.note(authority);
    let answer: boolean | symbol;
    try {
      // No is the default: an `Enter` typed ahead, or pressed twice, answers No.
      answer = await flow.confirm(
        confirmationQuestion(effect.form, hold.names()),
        false,
        FIELD_PROMPT_ESCAPE,
      );
    } finally {
      if (authority !== undefined) restoreNote();
    }
    if (answer === NATIVE_PROMPT_BACK) dispatch({ kind: 'back', turn: effect.turn });
    else if (typeof answer === 'boolean')
      dispatch({ kind: 'confirmed', turn: effect.turn, yes: answer });
    else dispatch({ kind: 'stop' });
  }

  async function start(effect: Extract<LaunchEffect, { kind: 'start' }>): Promise<void> {
    if (signal.aborted) {
      dispatch({ kind: 'stop', notice: LAUNCH_CANCELLED });
      return;
    }
    flow.busy('Starting the run…');
    const { choice, values, sourceDigest, fsScope } = effect.form;
    // **`Esc` and `Ctrl+C` while the leg prepares (P1-4).** The screen says `Esc cancel`, and the engine build, the reconcile and an MCP
    // connect can take up to two minutes. The abort does two things at once: it closes THIS flow (the keyboard is the Home's again, the
    // held values are wiped) and, through the request's signal, stops the host's leg, so the connect and the consent card close and the run
    // core's next checkpoint throws before a run exists. The host's late answer is ignored by the closed machine. The listener lives only
    // until the host has answered: a started run is the run view's to cancel.
    const leave = (): void => {
      dispatch({ kind: 'stop' });
    };
    signal.addEventListener('abort', leave, { once: true });
    try {
      const launch = await host.start({
        workflow: choice.path,
        rawInputs: values,
        secrets: hold.port,
        // The host reads the file again; it must find the text this confirmation was built from, or it starts nothing.
        expectedSourceDigest: sourceDigest,
        // The file scope the confirmation named: the start refuses, before anything is asked, when the project now sets another.
        expectedFsScope: fsScope?.tier ?? 'sandboxed',
        signal,
      });
      dispatch({ kind: 'launched', turn: effect.turn, notice: launchNotice(choice, launch) });
    } finally {
      signal.removeEventListener('abort', leave);
    }
  }

  return run;
}
