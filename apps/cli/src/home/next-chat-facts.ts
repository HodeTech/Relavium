import type { LlmProviderId } from '@relavium/shared';

import { defaultChatModel } from '../chat/agent-source.js';
import { inferProviderFromModel } from '../chat/default-agent.js';
import type { ResolvedChatConfig } from '../config/resolve.js';
import { directoryLabelHere } from '../render/display-roots.js';
import type { HomeStatusFacts } from './home-status-facts.js';

/**
 * How the Home's status line derives the facts of the NEXT chat ([ADR-0146](../../../../docs/decisions/0146-the-home-and-the-chat-share-one-calm-layout-and-the-first-run-has-no-dead-end.md)
 * §2) from the configuration, by the rules a new chat is built by and not by rules of its own: {@link nextChatSettings} is the rule `driveHome`'s
 * `startChat` applies to the two `[chat]` snapshots it holds (it calls this very function), and {@link nextChatFacts} resolves the model and the
 * provider with `defaultChatModel`, the function the default agent is bound by (`chat/agent-source.ts`). A test builds a chat and the facts from the
 * same configuration and compares them. The type of the facts and the equality the controller compares them by are `home-status-facts.ts`'s, which
 * imports nothing, so the controller does not load the engine to hold them.
 */

/** The three settings a chat's agent and its reasoning tier come from, in the shape the resolved `[chat]` block has them. */
export type NextChatSettings = Pick<
  ResolvedChatConfig,
  'defaultModel' | 'defaultProvider' | 'reasoningEffort'
>;

/**
 * The model, the provider and the effort a chat started now is built from: the EFFECTIVE `[chat]` block read fresh now (project, workspace,
 * global, and a model this invocation chose), and the snapshot taken when the Home opened as the fallback. The model and the provider come from
 * the SAME snapshot: when the fresh read supplies a model, ITS provider is taken (absent means inferred from the id, never back-filled from the
 * startup snapshot, or a fresh model paired with a stale provider would dial the wrong adapter); only with no fresh model do both fall back to the
 * startup pair. The effort is the fresh one, else the startup one. This is the rule `driveHome`'s `startChat` applies, moved here so the status
 * line cannot drift from it.
 */
export function nextChatSettings(
  effective: NextChatSettings | undefined,
  startup: NextChatSettings,
): NextChatSettings {
  const fresh = effective?.defaultModel;
  const [defaultModel, defaultProvider] =
    fresh === undefined
      ? [startup.defaultModel, startup.defaultProvider]
      : [fresh, effective?.defaultProvider];
  return {
    defaultModel,
    defaultProvider,
    reasoningEffort: effective?.reasoningEffort ?? startup.reasoningEffort,
  };
}

/** What {@link nextChatFacts} derives the facts from. */
export interface NextChatFactsInput {
  readonly settings: NextChatSettings;
  /** The starting mode a new chat opens in (`ChatModeSelection.mode`). */
  readonly mode: string;
  /**
   * Whether a provider has a usable key, from the Home's cached sample (never a read of the keychain): consulted only when no model is
   * configured, as the default agent's choice is (`defaultChatModel`).
   */
  readonly hasKey: (id: LlmProviderId) => boolean;
  readonly directory: string;
}

/**
 * The facts of the next chat: the model and provider the default agent would bind (`defaultChatModel`, then the provider inferred from the
 * model's id when none is named, as the agent's own build does; none when neither can name one), the starting mode, the effort and the
 * directory.
 */
export function nextChatFacts(input: NextChatFactsInput): HomeStatusFacts {
  const { settings } = input;
  const { model, provider } = defaultChatModel({
    defaultModel: settings.defaultModel,
    ...(settings.defaultProvider === undefined
      ? {}
      : { defaultProvider: settings.defaultProvider }),
    hasKey: input.hasKey,
  });
  const named = provider ?? inferProviderFromModel(model);
  return {
    ...(named === undefined ? {} : { provider: named }),
    model,
    mode: input.mode,
    ...(settings.reasoningEffort === undefined ? {} : { effort: settings.reasoningEffort }),
    directory: input.directory,
  };
}

/**
 * The working directory as the status line's label (`~/acme-web`, `…/app`: never absolute), read by THIS machine's path rules
 * (`directoryLabelHere`): a backslash is a separator on a Windows host and part of a name anywhere else, so a POSIX directory named
 * `a\..\..\Library` is never labelled as another place (SE7-8). `platform` is the machine's by default so a test can read a path from any machine.
 */
export function statusDirectory(
  cwd: string,
  home: string | undefined,
  platform: NodeJS.Platform = process.platform,
): string {
  return directoryLabelHere(cwd, home, undefined, platform);
}
