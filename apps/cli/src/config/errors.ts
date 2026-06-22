import { CliError } from '../process/errors.js';

/**
 * A typed, **file-attributed** config error (error-handling.md: untrusted input fails with a
 * typed, user-facing validation error that names the offending file). Maps to exit `2`. The
 * `message` is user-safe — config files hold no secrets (config-spec.md), and the detail is a
 * TOML position or a Zod field path, never the file's contents.
 */
export class ConfigError extends CliError {
  readonly filePath: string;

  constructor(filePath: string, detail: string, opts?: { readonly cause?: unknown }) {
    super('config_error', `${filePath}: ${detail}`, opts);
    this.name = 'ConfigError';
    this.filePath = filePath;
  }
}
