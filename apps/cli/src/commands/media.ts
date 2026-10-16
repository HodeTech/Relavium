import { join } from 'node:path';
import { FilesystemMediaStore, MediaTemporaryMaintenanceError } from '@relavium/db';
import { globalConfigDir } from '../config/paths.js';
import { CliError } from '../process/errors.js';
import { storageBoundaryError } from '../process/owned-storage.js';
import { EXIT_CODES, type ExitCode } from '../process/exit-codes.js';
import type { CliIo } from '../process/io.js';
import type { GlobalOptions } from '../process/options.js';
import { stringifyJsonLine } from '../render/sanitize.js';

export interface MediaPruneArgs {
  readonly legacyOffline: boolean;
  readonly force: boolean;
}

/** ADR-0106: strict acknowledgements precede even CAS construction; no config/history/key services. */
export async function pruneTemporariesCommand(
  args: MediaPruneArgs,
  deps: { readonly io: CliIo; readonly global: GlobalOptions; readonly homeDir?: string },
): Promise<ExitCode> {
  if (args.legacyOffline !== true || args.force !== true) {
    throw new CliError(
      'invalid_invocation',
      'Temporary maintenance requires --legacy-offline and --force.',
    );
  }
  let report: Awaited<ReturnType<FilesystemMediaStore['pruneLegacyTemporaries']>>;
  try {
    const store = new FilesystemMediaStore(join(globalConfigDir(deps.homeDir), 'media'));
    report = await store.pruneLegacyTemporaries({ legacyOffline: true, force: true });
  } catch (error) {
    if (error instanceof MediaTemporaryMaintenanceError) {
      throw new CliError('invalid_invocation', `Temporary maintenance refused: ${error.reason}.`, {
        cause: error,
      });
    }
    throw storageBoundaryError(error);
  }
  const output = deps.global.json
    ? `${stringifyJsonLine(report)}\n`
    : `Temporary maintenance: removed ${report.removed}, retained ${report.retained}.\n${Object.entries(
        report.reasons,
      )
        .map(([reason, count]) => `${reason}: ${count}\n`)
        .join('')}`;
  try {
    deps.io.writeOut(output);
  } catch (error) {
    throw new CliError('output_unavailable', '', { cause: error });
  }
  return EXIT_CODES.success;
}
