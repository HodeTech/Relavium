import type { ProviderId } from '@relavium/llm';
import type { GlobalConfig } from '@relavium/shared';

/** Operator state comes only from the separately validated selected global config. */
export type StandardEnvKeyConsent = NonNullable<
  NonNullable<GlobalConfig['preferences']>['standard_env_key_consent']
>;
export type StandardEnvKeyName = NonNullable<StandardEnvKeyConsent[ProviderId]>;

/** Closed source names; never accept an arbitrary environment variable or a credential value. */
export const STANDARD_PROVIDER_KEY_ENV_VARS = {
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
  gemini: 'GEMINI_API_KEY',
  deepseek: 'DEEPSEEK_API_KEY',
} as const satisfies { readonly [Id in ProviderId]: NonNullable<StandardEnvKeyConsent[Id]> };

export interface StandardEnvKeyPolicy {
  readonly allows: (id: ProviderId, name: StandardEnvKeyName) => boolean;
  /** Call only after successful publication or an explicit invocation-only choice. */
  readonly allowForInvocation: (id: ProviderId) => void;
  /** UX-only suppression of automatic prompts; never authorizes a key source. */
  readonly defer: (id: ProviderId) => void;
  readonly isDeferred: (id: ProviderId) => boolean;
}

/**
 * One policy per interactive invocation, shared by every replacement host and diagnostic/refresh path.
 * Supply preferences from LoadedConfig.globalConfig, never merged/project preferences. It holds names
 * and choices only: key values are read by the resolver on each lookup. Revocation takes effect on restart.
 * This controller never persists. Failed writes/cancel/selection must not call allowForInvocation.
 */
export function createStandardEnvKeyPolicy(
  validatedSelectedGlobalPreferences?: GlobalConfig['preferences'],
): StandardEnvKeyPolicy {
  const consent = validatedSelectedGlobalPreferences?.standard_env_key_consent;
  const allowed = new Set<ProviderId>();
  const deferred = new Set<ProviderId>();
  const ids = [
    'anthropic',
    'openai',
    'gemini',
    'deepseek',
  ] as const satisfies readonly ProviderId[];
  for (const id of ids) {
    if (consent?.[id] === STANDARD_PROVIDER_KEY_ENV_VARS[id]) allowed.add(id);
  }
  return {
    allows: (id, name) => name === STANDARD_PROVIDER_KEY_ENV_VARS[id] && allowed.has(id),
    allowForInvocation: (id) => {
      allowed.add(id);
      deferred.delete(id);
    },
    defer: (id) => {
      deferred.add(id);
    },
    isDeferred: (id) => deferred.has(id),
  };
}
