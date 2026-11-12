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
import { startingModePreference, type StartingModeRuntime } from './starting-mode.js';

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

const AUTO_RISK =
  'Auto permits ordinary governed actions without approval, including file writes. Protected-path and permission denials still apply.';

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
    const current = options.currentMode?.();
    if (current !== undefined && options.onCurrentMode !== undefined) {
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
          if (confirmed !== true) return;
        }
        options.onCurrentMode(mode);
        options.notice(`Current mode: ${mode}. Startup default unchanged.`);
        return;
      }
      if (action !== 'save-startup') return;
    }
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
    const confirmed = await options.flow.confirm(
      `${mode === 'auto' ? `${AUTO_RISK} ` : ''}Save ${mode} as the global startup default?${override}`,
      false,
    );
    if (confirmed !== true) return;
    // Confirmed narrowing is live even when cancellation, preparation or publication then fails.
    if (mode !== 'auto') {
      options.runtime.authority.revoke();
      narrowed = true;
    }
    const confirmationRevision = options.runtime.authority.revocationRevision;
    assertAdmitting();
    const prepared =
      options.prepare?.(mode) ??
      prepareDefaultChatMode(
        mode,
        options.runtime.homeDir,
        options.runtime.configPath === globalConfigPath(options.runtime.homeDir)
          ? undefined
          : options.runtime.configPath,
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
      published
        ? publishedMode === 'auto' && !publishedAutoAdmitted
          ? 'Startup default was published. Startup auto was not re-admitted for this invocation.'
          : 'Startup default was published; mode settings could not finish.'
        : narrowed
          ? 'Startup default was not saved. Startup auto remains revoked for this invocation.'
          : signal?.aborted === true
            ? 'Mode settings cancelled. Startup default unchanged.'
            : 'Mode settings could not be completed. Startup default unchanged.',
    );
  } finally {
    if (signal !== undefined) await endModeSettings(options.flow);
  }
}
