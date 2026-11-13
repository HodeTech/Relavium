import type { ProviderId } from '@relavium/llm';
import type { LoadedConfig } from './load.js';

export interface InvocationModelDefault {
  readonly model: string;
  readonly provider: ProviderId;
}

/** An explicit invocation choice remains below validated project/workspace model preferences. */
export function applyInvocationDefault(
  loaded: LoadedConfig,
  binding: InvocationModelDefault | undefined,
): LoadedConfig {
  if (binding === undefined) return loaded;
  if (loaded.hasRepositoryChatModel) return loaded;
  return {
    ...loaded,
    config: {
      ...loaded.config,
      chat: {
        ...loaded.config.chat,
        defaultModel: binding.model,
        defaultProvider: binding.provider,
      },
    },
  };
}
