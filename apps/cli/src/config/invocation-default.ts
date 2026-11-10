import { join } from 'node:path';
import type { ProviderId } from '@relavium/llm';
import { ProjectConfigSchema } from '@relavium/shared';
import { loadConfigFile, type LoadedConfig } from './load.js';

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
  if (loaded.projectConfigDir !== undefined) {
    for (const name of ['project.toml', 'workspace.toml']) {
      const layer = loadConfigFile(join(loaded.projectConfigDir, name), ProjectConfigSchema, {
        projectLayer: true,
      });
      if (layer?.chat?.default_model !== undefined) return loaded;
    }
  }
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
