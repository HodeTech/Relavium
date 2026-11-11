import { CliError } from '../process/errors.js';

/**
 * A typed, **file-attributed** config error (error-handling.md: untrusted input fails with a
 * typed, user-facing validation error that names the offending file). Maps to exit `2`. The
 * `message` is user-safe — config files hold no secrets (config-spec.md), and the detail is a
 * TOML position or a Zod field path, never the file's contents.
 */
export class ConfigError extends CliError {
  readonly filePath: string;

  constructor(
    filePath: string,
    detail: string,
    opts?: { readonly cause?: unknown; readonly pathFree?: true },
  ) {
    super('config_error', opts?.pathFree === true ? detail : `${filePath}: ${detail}`, opts);
    this.name = 'ConfigError';
    this.filePath = filePath;
  }
}

/** These known operator settings use fixed copy and never retain an authored path or cause. */
export class OperatorConfigError extends ConfigError {
  constructor(
    setting: 'standard_env_key_consent' | 'keychain_unavailable_acknowledged',
    placement: boolean,
  ) {
    const prefix = `[preferences].${setting}`;
    const repair = placement
      ? 'Remove it from project/workspace config and configure it only in the selected global config.'
      : setting === 'standard_env_key_consent'
        ? 'Use only anthropic = "ANTHROPIC_API_KEY", openai = "OPENAI_API_KEY", gemini = "GEMINI_API_KEY", or deepseek = "DEEPSEEK_API_KEY"; remove invalid entries from the selected global config.'
        : 'Set it to true or false, or remove it from the selected global config.';
    super('', `${prefix} is invalid. ${repair}`, { pathFree: true });
    this.name = 'OperatorConfigError';
  }
}
