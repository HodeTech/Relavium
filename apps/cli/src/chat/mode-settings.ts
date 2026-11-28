import type { ChatMode } from '@relavium/shared';

import {
  globalConfigPath,
  prepareDefaultChatMode,
  type ConfigWriteResult,
  type PreparedConfigWrite,
} from '../config/write.js';
import { CliError } from '../process/errors.js';
import type { NativePromptFlow } from '../render/tui/native-prompt-channel.js';
import { CHAT_MODES, MODE_DESCRIPTION } from './chat-mode.js';
import { MODE_EFFECT } from './mode-effects.js';
import {
  startingModePreference,
  startingModeConfigObserver,
  type StartingModeRuntime,
} from './starting-mode.js';

export interface ModeSettingsOptions {
  readonly runtime: StartingModeRuntime;
  readonly cwd: string;
  readonly interactive: boolean;
  readonly flow: NativePromptFlow;
  /** Both callbacks are present for a live chat; neither is present in idle Home. */
  readonly currentMode?: () => ChatMode;
  readonly onCurrentMode?: (mode: ChatMode) => void;
  readonly notice: (text: string) => void;
  readonly assertAdmitting: () => void;
  /** Owns existing-file rewrite disclosure and the writer's final admission check. */
  readonly publish: (
    prepared: PreparedConfigWrite,
    assertAdmitting: () => void,
  ) => ConfigWriteResult | Promise<ConfigWriteResult>;
  readonly prepare?: (mode: ChatMode) => PreparedConfigWrite;
}

function selectedMode(value: string | symbol): ChatMode | undefined {
  return CHAT_MODES.find((mode) => mode === value);
}

/** What both `auto` confirmations state before their question: the effect of `auto`, from the one source (`mode-effects.ts`). */
const AUTO_RISK = MODE_EFFECT.auto.full;

async function endModeSettings(flow: NativePromptFlow): Promise<void> {
  try {
    await flow.end();
  } catch {
    throw new CliError('cli_internal', 'Mode settings could not release the prompt.');
  }
}

/** One explicit mode/default flow shared by live chat and idle Home. Never runs headlessly. */
export async function runModeSettings(options: ModeSettingsOptions): Promise<void> {
  if (!options.interactive || !options.runtime.authority.interactive) {
    options.notice('Mode settings require an interactive chat. Non-interactive chat stays in ask.');
    return;
  }
  let signal: AbortSignal | undefined;
  let narrowed = false;
  let published = false;
  let publishedMode: ChatMode | undefined;
  let publishedAutoAdmitted = false;
  try {
    options.assertAdmitting();
    signal = options.flow.begin();
    const assertAdmitting = (): void => {
      options.assertAdmitting();
      signal?.throwIfAborted();
    };
    const preference = startingModePreference(options.runtime.read(options.cwd));
    assertAdmitting();
    const override =
      preference.source === 'project' || preference.source === 'workspace'
        ? ` ${preference.source} override selects ${preference.mode}; saving globally will not change this effective start.`
        : '';
    options.flow.note(
      `Effective startup: ${preference.mode}. Global default: ${preference.globalMode}.${override}`,
    );
    if (!(await selectStartupAction(options, assertAdmitting))) return;
    assertAdmitting();
    const mode = selectedMode(
      await options.flow.select({
        message: 'Choose a global startup default. Selection alone saves nothing.',
        options: CHAT_MODES.map((value) => ({
          value,
          label: value,
          hint: MODE_DESCRIPTION[value],
        })),
        initialValue: preference.globalMode,
      }),
    );
    assertAdmitting();
    if (mode === undefined) return;
    const autoRisk = mode === 'auto' ? `${AUTO_RISK} ` : '';
    const confirmed = await options.flow.confirm(
      `${autoRisk}Save ${mode} as the global startup default?${override}`,
      false,
    );
    if (confirmed !== true) return;
    // Confirmed narrowing is live even when cancellation, preparation or publication then fails.
    if (mode !== 'auto') {
      options.runtime.authority.revoke();
      narrowed = true;
    }
    const confirmationRevision = options.runtime.authority.revocationRevision;
    const observer = publicationObserver(options.runtime, mode, preference.globalMode);
    assertAdmitting();
    const prepared =
      options.prepare?.(mode) ??
      prepareDefaultChatMode(
        mode,
        options.runtime.homeDir,
        options.runtime.configPath === globalConfigPath(options.runtime.homeDir)
          ? undefined
          : options.runtime.configPath,
        observer,
      );
    const result = await options.publish(prepared, assertAdmitting);
    published = true;
    publishedMode = mode;
    // Publication remains factual after cancellation, but a stale UI continuation cannot widen authority.
    if (mode === 'auto') {
      assertAdmitting();
      publishedAutoAdmitted =
        options.runtime.authority.admitConfirmedAutoDefault(confirmationRevision);
    }
    options.notice(
      `Global startup default saved: ${mode}.${override}${result.durability === 'unconfirmed' ? ' Published, but durability could not be confirmed.' : ''}${mode === 'auto' && !publishedAutoAdmitted ? ' Startup auto was not re-admitted for this invocation.' : ''}`,
    );
  } catch {
    options.notice(
      modeSettingsFailure(published, publishedMode, publishedAutoAdmitted, narrowed, signal),
    );
  } finally {
    if (signal !== undefined) await endModeSettings(options.flow);
  }
}

/** Current-mode changes finish the flow; only an explicit startup action continues to publication. */
async function selectStartupAction(
  options: ModeSettingsOptions,
  assertAdmitting: () => void,
): Promise<boolean> {
  const current = options.currentMode?.();
  if (current === undefined || options.onCurrentMode === undefined) return true;
  const action = await options.flow.select({
    message: `Current mode: ${current}. Change current mode or save a startup default.`,
    options: [
      ...CHAT_MODES.map((mode) => ({ value: mode, label: mode, hint: MODE_DESCRIPTION[mode] })),
      {
        value: 'save-startup',
        label: 'Save startup default',
        hint: 'Separate global preference',
      },
    ],
    initialValue: current,
  });
  assertAdmitting();
  const mode = selectedMode(action);
  if (mode !== undefined) {
    if (mode === 'auto') {
      const confirmed = await options.flow.confirm(
        `${AUTO_RISK} Use auto for this session?`,
        false,
      );
      assertAdmitting();
      if (confirmed !== true) return false;
    }
    options.onCurrentMode(mode);
    options.notice(`Current mode: ${mode}. Startup default unchanged.`);
    return false;
  }
  return action === 'save-startup';
}

function publicationObserver(runtime: StartingModeRuntime, mode: ChatMode, globalMode: ChatMode) {
  const sourceObserver = startingModeConfigObserver(runtime.authority);
  if (mode !== 'auto') return sourceObserver;
  return {
    failed: sourceObserver.failed,
    observed: (sourceMode: ChatMode): void => {
      // The displayed non-auto baseline was revoked before this confirmation. Newer observations still win.
      if (sourceMode !== globalMode) sourceObserver.observed(sourceMode);
    },
  };
}

function modeSettingsFailure(
  published: boolean,
  publishedMode: ChatMode | undefined,
  publishedAutoAdmitted: boolean,
  narrowed: boolean,
  signal: AbortSignal | undefined,
): string {
  if (published) {
    if (publishedMode === 'auto' && !publishedAutoAdmitted)
      return 'Startup default was published. Startup auto was not re-admitted for this invocation.';
    return 'Startup default was published; mode settings could not finish.';
  }
  if (narrowed)
    return 'Startup default was not saved. Startup auto remains revoked for this invocation.';
  if (signal?.aborted === true) return 'Mode settings cancelled. Startup default unchanged.';
  return 'Mode settings could not be completed. Startup default unchanged.';
}

/** What {@link runStartupDefaultSave} is given: the options of {@link runModeSettings} without a live chat's current mode and its setter. */
export type StartupDefaultSaveOptions = Omit<ModeSettingsOptions, 'currentMode' | 'onCurrentMode'>;

/** What the answered selection returns for a mode the startup branch does not offer: no mode, so the branch ends having saved nothing. */
const NOT_OFFERED = Symbol('mode not offered');

/**
 * Save `mode`, chosen elsewhere, as the global startup default: the startup branch of {@link runModeSettings} and nothing else (the chat's
 * `/mode` popup's `[s]` and the bare Home's `Enter` on another mode hand off here, through `popups/mode-confirm.ts`, ADR-0148 §3 and §6). It RUNS that branch rather than repeating it: the flow it is given
 * answers the branch's one selection with `mode` without drawing it (a selection alone saves nothing, and the person chose the mode in the
 * popup), and every other step is today's, on the same prompt: the effective-startup note, the confirmation that defaults to No (`auto`
 * states its effect first), the revocation a confirmed narrowing makes, the config-rewrite disclosure and the visibly admitted publication,
 * the stale-`auto` admission and the result's words. No current mode and no setter are passed, so the session's own mode never changes here.
 * Returns what {@link runModeSettings} returns.
 */
export function runStartupDefaultSave(
  options: StartupDefaultSaveOptions,
  mode: ChatMode,
): Promise<void> {
  const { flow } = options;
  return runModeSettings({
    runtime: options.runtime,
    cwd: options.cwd,
    interactive: options.interactive,
    notice: options.notice,
    assertAdmitting: options.assertAdmitting,
    publish: options.publish,
    ...(options.prepare === undefined ? {} : { prepare: options.prepare }),
    flow: {
      ...flow,
      // The one selection of the startup branch, answered with the mode the person chose; a mode the branch does not offer saves nothing.
      select: (request) =>
        Promise.resolve(
          request.options.some((option) => option.value === mode) ? mode : NOT_OFFERED,
        ),
    },
  });
}

// ── The `/mode` popup's hand-off: the result, not the words (ADR-0148 §3, §6) ───────────────────────────────────────────────

/**
 * What saving the global startup default from the `/mode` popup (a chat's `[s]`, the Home's `Enter`) came to, as {@link runStartupDefaultSave} said it, read back
 * as a result so that the popup can say it on the host's channel in a few words (the residue rule, ADR-0148 §6: nothing of a setting goes into
 * the transcript). The bare Home's `/mode` popup (`popups/mode-home.ts`) reads the same result for its Done step, with the flow's own sentence.
 *
 * - `saved`: the config was published. `durability` is the writer's (`unknown` when the flow failed after publishing and did not say it);
 *   `overriddenBy` names the project or workspace setting that selects another mode where this chat started (new chats here keep that one);
 *   `autoAfterRestart`: `auto` was saved but is not admitted for this run, so new chats start in it after a restart (the stale-`auto` refusal);
 *   `unfinished`: the file is written and what follows the publication could not be finished.
 * - `unchanged`: the person declined the confirmation (it defaults to No), the mode is not one the branch offers, or the flow was cancelled.
 * - `refused`: nothing was saved; `autoRevoked` when a confirmed narrowing had already revoked startup `auto` for this run.
 */
export type StartupDefaultSaveResult =
  | {
      readonly kind: 'saved';
      readonly durability: 'confirmed' | 'unconfirmed' | 'unknown';
      readonly overriddenBy?: 'project' | 'workspace' | undefined;
      readonly autoAfterRestart: boolean;
      readonly unfinished: boolean;
    }
  | { readonly kind: 'unchanged' }
  | { readonly kind: 'refused'; readonly autoRevoked: boolean };

/** The words of {@link runModeSettings}' startup branch that say a result: what {@link startupDefaultResultOf} reads (it says them itself, above). */
const SAID = {
  saved: 'Global startup default saved: ',
  published: 'Startup default was published',
  unconfirmed: ' Published, but durability could not be confirmed.',
  notReadmitted: ' Startup auto was not re-admitted for this invocation.',
  revoked: ' Startup auto remains revoked for this invocation.',
  cancelled: 'Mode settings cancelled. Startup default unchanged.',
} as const;

/** The setting the success sentence names as selecting another mode where the chat started (` project override selects plan; …`). */
const OVERRIDE = /^Global startup default saved: [a-z-]+\. (project|workspace) override selects /u;

/**
 * The result {@link runStartupDefaultSave}'s one sentence says, or `unchanged` when it said none (a declined confirmation ends the branch with
 * no word). Read from the branch's own fixed words, so a sentence it adds or rewords is pinned by `popups/mode-confirm.test.ts`, which drives
 * every path of the real flow; an unknown sentence is read as nothing saved, never as saved.
 */
export function startupDefaultResultOf(said: string | undefined): StartupDefaultSaveResult {
  if (said === undefined || said === SAID.cancelled) return { kind: 'unchanged' };
  const overriddenBy = OVERRIDE.exec(said)?.[1];
  if (said.startsWith(SAID.saved))
    return {
      kind: 'saved',
      durability: said.includes(SAID.unconfirmed) ? 'unconfirmed' : 'confirmed',
      ...(overriddenBy === 'project' || overriddenBy === 'workspace' ? { overriddenBy } : {}),
      autoAfterRestart: said.endsWith(SAID.notReadmitted),
      unfinished: false,
    };
  if (said.startsWith(SAID.published)) {
    const autoAfterRestart = said.endsWith(SAID.notReadmitted);
    return {
      kind: 'saved',
      durability: 'unknown',
      autoAfterRestart,
      unfinished: !autoAfterRestart,
    };
  }
  return { kind: 'refused', autoRevoked: said.endsWith(SAID.revoked) };
}
