/**
 * Saving the default model of new chats from the `/models` popup ([ADR-0063](../../../../docs/decisions/0063-cli-config-write-contract.md)
 * §1, [ADR-0066](../../../../docs/decisions/0066-normalized-reasoning-effort-control.md) §6, [ADR-0148](../../../../docs/decisions/0148-a-user-started-report-setting-or-flow-is-a-centred-popup.md)
 * §6): the one adapter both hosts' writers are reached through, and a stand-alone chat's writer.
 *
 * - {@link saveDefaultModel} runs a host's writer and says what it came to as a {@link DefaultModelSaveResult} (it never rejects): saved, with
 *   the writer's durability and whether the effective default (project → workspace → global, read again) is now the model chosen; or refused,
 *   by kind (a symbolic-link config, a cancelled card, any other failure; nothing while the host is closing). The Home's `HomeModelsPort`
 *   writer and a stand-alone chat's are adapted by this one function, so the two cannot drift on what a person is told.
 * - {@link createChatDefaultModelWriter} is the stand-alone chat's writer, which it never had (the picker of a chat could only reseat): the SAME
 *   path as the Home's (`prepareGlobalPreferences` over the global `[preferences]`, with the starting-mode observer of the read, then the
 *   publication), and the same consent: when an existing config must be rewritten, the rewrite disclosure is noted on this chat's native card
 *   and the file is published only while that card is visibly on screen (`publishModePreference`: `NativePromptUi.assertVisible`); a config
 *   that does not exist yet is written with no card, as the Home writes it.
 */

import type { ProviderId } from '@relavium/llm';
import type { ReasoningEffort } from '@relavium/shared';

import {
  ConfigWriteRefusedError,
  globalConfigPath,
  prepareGlobalPreferences,
  type ConfigWriteResult,
} from '../config/write.js';
import type { NoticeFlush } from '../engine/effect-retention.js';
import type { DefaultModelSaveResult, ModelChoice } from '../popups/settings-port.js';
import { CliError } from '../process/errors.js';
import type { NativePromptFlow, NativePromptUi } from '../render/tui/native-prompt-channel.js';
import { publishModePreference } from './mode-preference-publication.js';
import { startingModeConfigObserver, type StartingModeRuntime } from './starting-mode.js';

/** What a writer of the default model publishes (`HomeModelsPort.writeDefault`, `ChatModelsPort.writeDefault`): the write's durability. */
export type DefaultModelWrite = (
  modelId: string,
  provider: ProviderId,
  reasoningEffort?: ReasoningEffort,
) => void | ConfigWriteResult | Promise<void | ConfigWriteResult>;

/** What {@link saveDefaultModel} is given besides the choice. */
export interface DefaultModelSaveOptions {
  /** The host's writer. */
  readonly write: DefaultModelWrite;
  /** The effective default model, read again after the write (project → workspace → global); it may throw. */
  readonly readEffective: () => string | undefined;
  /** Whether the host is closing: then nothing is said, whatever the writer did. */
  readonly closing: () => boolean;
  /** Where a fault of the writer is reported first (the host's work owner), before it is told as a failed save. */
  readonly failure?: ((cause: unknown) => void) | undefined;
}

/** The kind of a writer's refusal: a symbolic-link config, a card the person cancelled (the writers throw `invalid_invocation`), or a failure. */
function refusalOf(cause: unknown): 'symlink' | 'cancelled' | 'failed' {
  if (cause instanceof ConfigWriteRefusedError) return 'symlink';
  if (cause instanceof CliError && cause.code === 'invalid_invocation') return 'cancelled';
  return 'failed';
}

/** Run the writer for `choice` and say what it came to; see the module header. Never rejects. */
export async function saveDefaultModel(
  options: DefaultModelSaveOptions,
  choice: ModelChoice,
): Promise<DefaultModelSaveResult> {
  let written: void | ConfigWriteResult;
  try {
    written = await options.write(choice.modelId, choice.provider, choice.reasoningEffort);
  } catch (cause) {
    if (options.closing()) return { kind: 'refused', reason: 'closing' };
    options.failure?.(cause);
    return { kind: 'refused', reason: refusalOf(cause) };
  }
  if (options.closing()) return { kind: 'refused', reason: 'closing' };
  const durability = written === undefined ? 'confirmed' : written.durability;
  let effective: string | undefined;
  try {
    effective = options.readEffective();
  } catch {
    // The write was published: a read that fails afterwards does not make it unsaved, only unconfirmed here.
    return { kind: 'saved', durability, effect: 'unknown' };
  }
  if (effective === undefined) return { kind: 'saved', durability, effect: 'unknown' };
  return {
    kind: 'saved',
    durability,
    effect: effective === choice.modelId ? 'applies' : 'overridden',
  };
}

/** What a stand-alone chat's writer needs: the invocation's starting-mode runtime (its config file) and this chat's native prompt. */
export interface ChatDefaultModelWriterOptions {
  readonly runtime: StartingModeRuntime;
  readonly flow: NativePromptFlow;
  readonly ui: NativePromptUi;
  /** The renderer's flush, once the chat's card surface is ready; `undefined` before. */
  readonly flushVisible: () => NoticeFlush | undefined;
  /** Throws once the chat no longer admits work (it is closing). */
  readonly assertAdmitting: () => void;
}

/** A stand-alone chat's writer of the default model of new chats; see the module header. */
export function createChatDefaultModelWriter(
  options: ChatDefaultModelWriterOptions,
): (
  modelId: string,
  provider: ProviderId,
  reasoningEffort?: ReasoningEffort,
) => Promise<ConfigWriteResult> {
  const { runtime, flow } = options;
  return async (modelId, provider, reasoningEffort) => {
    options.assertAdmitting();
    const prepared = prepareGlobalPreferences(
      {
        defaultModel: modelId,
        defaultProvider: provider,
        ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
      },
      runtime.homeDir,
      // The same file the chat's config was read from (`--config` honoured), as the startup-default writer targets it.
      runtime.configPath === globalConfigPath(runtime.homeDir) ? undefined : runtime.configPath,
      startingModeConfigObserver(runtime.authority),
    );
    // A config that does not exist yet loses nothing: it is written with no card, as the Home writes it.
    if (!prepared.rewriteNeeded) return prepared.publish(options.assertAdmitting);
    const signal = flow.begin();
    try {
      flow.busy('Saving default model…');
      return await publishModePreference({
        prepared,
        flow,
        ui: options.ui,
        flushVisible: options.flushVisible,
        assertAdmitting: () => {
          options.assertAdmitting();
          signal.throwIfAborted();
        },
      });
    } catch (cause) {
      if (signal.aborted && cause === signal.reason)
        throw new CliError('invalid_invocation', 'Default model change cancelled.');
      throw cause;
    } finally {
      await flow.end();
    }
  };
}
