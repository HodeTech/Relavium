import { relative } from 'node:path';

import { prepareProjectInit } from '../authoring/project-init.js';
import type { CommandLifetime } from '../process/command-lifetime.js';
import { EXIT_CODES, type ExitCode } from '../process/exit-codes.js';
import type { CliIo } from '../process/io.js';
import type { GlobalOptions } from '../process/options.js';
import { sanitizeInline, stringifyJsonLine } from '../render/sanitize.js';

/** Explicit shell action; Home confirms the same prepared core in its existing native tree. */
export function initCommand(deps: {
  readonly io: CliIo;
  readonly global: GlobalOptions;
  readonly commandLifetime?: CommandLifetime;
  readonly homeDir?: string;
}): ExitCode {
  const admit = (): void => deps.commandLifetime?.work.assertAdmitting();
  admit();
  const result = prepareProjectInit(deps.global.cwd, deps.homeDir).publish(admit);
  const path = relative(deps.global.cwd, result.projectConfigDir) || '.';
  const created = result.created.map((directory) => relative(deps.global.cwd, directory) || '.');
  if (deps.global.json)
    deps.io.writeOut(`${stringifyJsonLine({ status: result.status, path, created })}\n`);
  else if (result.status === 'already-initialized')
    deps.io.writeOut(`Already initialized at ${sanitizeInline(path)}.\n`);
  else for (const directory of created) deps.io.writeOut(`Created ${sanitizeInline(directory)}\n`);
  return EXIT_CODES.success;
}
