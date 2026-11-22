import {
  parseWorkflow,
  resolveAndValidateWorkflowInputs,
  WorkflowParseError,
  type WorkflowDefinition,
} from '@relavium/core';

import { inputAdmissionMessage, resolveInputs } from '../commands/inputs.js';
import { CliError, isCliError } from '../process/errors.js';
import { sourceLabel } from '../process/source-label.js';
import { sanitizeUntrustedInline } from '../render/sanitize.js';
import { NATIVE_PROMPT_BACK, type NativePromptFlow } from '../render/tui/native-prompt-channel.js';
import { discoverCatalog, type CatalogEntry } from '../workflows/catalog.js';
import { resolveWorkflowSource } from '../workflows/resolve.js';
import type { HostedLaunch, HostedSecretPort, RunHost } from './run-host.js';

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

/** What the form has so far: the workflow, its fields and the NON-SECRET values given (never a masked one). */
interface LaunchForm {
  readonly choice: LaunchChoice;
  readonly fields: readonly LaunchField[];
  readonly values: Readonly<Record<string, string>>;
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
    }
  /** The answer to the field being asked. `undefined` for a masked field (its value is in the hold, not here) or an omitted one. */
  | { readonly kind: 'answered'; readonly turn: number; readonly value: string | undefined }
  | { readonly kind: 'back'; readonly turn: number }
  | { readonly kind: 'confirmed'; readonly turn: number; readonly yes: boolean }
  | { readonly kind: 'launched'; readonly turn: number; readonly notice: string }
  /** Leave the flow: `Ctrl+C`, a refusal, the Home closing. Ignored once the run is starting (it cannot be un-started). */
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

/**
 * The whole launch flow as a pure function: a state and an event in, the next state and the effects to run out. Nothing here reads a
 * clock, a prompt, a file or a host. An event for a prompt that is no longer the current one is ignored.
 */
export function reduceLaunch(state: LaunchState, event: LaunchEvent): LaunchStep {
  if (state.kind === 'closed') return IGNORED(state);
  switch (event.kind) {
    case 'opened': {
      if (state.kind !== 'idle') return IGNORED(state);
      if (event.choices.length === 0) return closeWith(state, LAUNCH_NO_WORKFLOWS);
      const turn = state.turn + 1;
      return {
        state: { kind: 'picking', turn, choices: event.choices },
        effects: [{ kind: 'pick', turn, choices: event.choices }],
      };
    }
    case 'stop':
      // A run that is starting is not stopped by a key: the host has it, and cancelling a leg is the run view's.
      return state.kind === 'starting'
        ? IGNORED(state)
        : closeWith(state, event.notice ?? LAUNCH_CANCELLED);
    case 'picked': {
      if (state.kind !== 'picking' || event.turn !== state.turn) return IGNORED(state);
      const form: LaunchForm = {
        choice: event.choice,
        fields: event.fields,
        values: Object.create(null) as Record<string, string>,
      };
      return toField(state, state.choices, form, 0, []);
    }
    case 'answered':
      if (state.kind !== 'asking' || event.turn !== state.turn) return IGNORED(state);
      return reduceAnswer(state, event.value);
    case 'back':
      if ((state.kind !== 'asking' && state.kind !== 'confirming') || event.turn !== state.turn)
        return IGNORED(state);
      return reduceBack(state);
    case 'confirmed': {
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
    case 'launched':
      if (state.kind !== 'starting' || event.turn !== state.turn) return IGNORED(state);
      return closeWith(state, event.notice);
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// The catalog the picker offers, and the one-line reasons for what it does not.
// ---------------------------------------------------------------------------------------------------------------------

/** The project's workflow files and their parsed definitions, behind a port so the flow is testable without a project. */
export interface LaunchCatalog {
  /** Every workflow file, valid or not. May throw a {@link CliError} (an unreadable catalog directory). */
  readonly list: () => readonly CatalogEntry[];
  /** Read and parse one file by its project-relative path. Throws a {@link CliError} for a path that no longer resolves or parses. */
  readonly load: (path: string) => WorkflowDefinition;
}

/**
 * The catalog of the project the Home is in. The project directory is found afresh on every read, as a chat finds it when it is
 * built: a `.relavium/` that `/init` made in this very Home, or another terminal's checkout, is seen without a restart.
 */
export function createProjectCatalog(options: {
  readonly cwd: string;
  readonly projectConfigDir: () => string | undefined;
  readonly homeDir: string;
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
        return parseWorkflow(source.yaml, { source: sourceLabel(cwd, source.path) });
      } catch (cause) {
        if (cause instanceof WorkflowParseError)
          throw new CliError('invalid_invocation', cause.message, { cause });
        throw cause;
      }
    },
  };
}

const LABEL_LIMIT = 60;
const REASON_LIMIT = 80;
const SKIPPED_LISTED = 3;

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
        label: bounded(entry.name ?? entry.slug, LABEL_LIMIT),
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

/** The confirmation's question: the workflow and each input, a masked one by name only. */
function confirmation(form: LaunchForm, masked: ReadonlySet<string>): string {
  const given = form.fields
    .filter((field) => field.secret || Object.hasOwn(form.values, field.name))
    .map((field) =>
      field.secret
        ? masked.has(field.name)
          ? `${field.name}=••••`
          : `${field.name}=(none)`
        : `${field.name}=${bounded(form.values[field.name] ?? '', SUMMARY_VALUE_LIMIT)}`,
    );
  const inputs = given.length === 0 ? '' : ` with ${given.join(', ')}`;
  return bounded(`Run ${form.choice.label}${inputs}?`, SUMMARY_LIMIT);
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
  readonly host: Pick<RunHost, 'start'>;
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
   */
  readonly open: () => Promise<string>;
  /** The launch in flight, if any. */
  readonly session: () => LaunchSession | undefined;
}

function launchNotice(choice: LaunchChoice, launch: HostedLaunch): string {
  if (launch.kind === 'started')
    return `Started ${choice.label} as run ${sanitizeUntrustedInline(launch.runId)}. It runs in the background.`;
  return sanitizeUntrustedInline(launch.message);
}

const FIELD_PROMPT_ESCAPE = 'back';

export function createRunLaunch(deps: RunLaunchDeps): RunLaunch {
  const { flow, catalog } = deps;
  let current: { readonly session: LaunchSession; readonly done: Promise<string> } | undefined;

  const open = async (): Promise<string> => {
    if (current !== undefined) return current.done;
    deps.assertAdmitting?.();
    let entries: readonly CatalogEntry[];
    try {
      entries = catalog.list();
    } catch (cause) {
      if (isCliError(cause)) return sanitizeUntrustedInline(cause.message);
      throw cause;
    }
    const { choices, skipped } = offeredWorkflows(entries);
    if (choices.length === 0)
      return skipped === undefined ? LAUNCH_NO_WORKFLOWS : `${LAUNCH_NO_WORKFLOWS} ${skipped}`;

    const signal = flow.begin();
    const hold = createSecretHold();
    const running = runSession({ deps, hold, signal });
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
}): SessionRun {
  const { deps, hold, signal } = options;
  const { flow, host, catalog } = deps;
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
    const answer = await flow.select({
      message: 'Run which workflow?',
      options: effect.choices.map((choice, index) => ({
        value: String(index),
        label: choice.label,
        hint: bounded(choice.path, REASON_LIMIT),
      })),
      escape: 'cancel',
    });
    const choice = typeof answer === 'string' ? effect.choices[Number(answer)] : undefined;
    if (choice === undefined) {
      dispatch({ kind: 'stop' });
      return;
    }
    loaded = catalog.load(choice.path);
    dispatch({ kind: 'picked', turn: effect.turn, choice, fields: launchFields(loaded) });
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
    // No is the default: an `Enter` typed ahead, or pressed twice, answers No.
    const answer = await flow.confirm(
      confirmation(effect.form, hold.names()),
      false,
      FIELD_PROMPT_ESCAPE,
    );
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
    const { choice, values } = effect.form;
    const launch = await host.start({
      workflow: choice.path,
      rawInputs: values,
      secrets: hold.port,
    });
    dispatch({ kind: 'launched', turn: effect.turn, notice: launchNotice(choice, launch) });
  }

  return run;
}
