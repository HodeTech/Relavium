import {
  commandGrantRoot,
  commandGrantsPath,
  createCommandGrantStore,
  removeCommandGrantsFile,
  type CommandGrantStore,
  type CommandGrantUnavailable,
} from '../permissions/command-grants.js';
import { findProjectConfigDir } from '../config/paths.js';
import { resolveHomeDir } from '../config/load.js';
import { CliError } from '../process/cli-error.js';
import { EXIT_CODES, type ExitCode } from '../process/exit-codes.js';
import type { CliIo } from '../process/io.js';
import type { GlobalOptions } from '../process/options.js';
import { writeRecordLines } from '../render/records.js';
import { sanitizeInline, stripTerminalControls } from '../render/sanitize.js';
import { createOsKeychainStore } from '../secrets/os-keychain.js';
import type { KeychainStore } from '../secrets/keychain.js';

/**
 * `relavium permissions list|revoke` (MVP-4, [ADR-0118](../../../../docs/decisions/0118-a-command-outside-the-allowlist-asks-instead-of-failing.md)
 * §2) — look at, and take back, the commands this project's operator chose to remember. Canonical home:
 * [command-permissions.md](../../../../docs/reference/cli/command-permissions.md).
 *
 * It never prints a command. The store keeps only keyed digests of the commands, so what a list can say is the program's name
 * (when it could be named without risking a credential), how many arguments follow, and when it was remembered. The listing is
 * for THIS project; `revoke --all` removes the whole file, which every project shares.
 */

export interface PermissionsRevokeArgs {
  /** Forget every remembered command, for every project: the file is removed. */
  readonly all: boolean;
  /** The 1-based number of the grant in `permissions list`. Absent exactly when `all` is set. */
  readonly index?: number;
}

export interface PermissionsDeps {
  readonly io: CliIo;
  readonly global: GlobalOptions;
  /** The operator's home (the directory that holds `.relavium`). Tests inject a temp directory. */
  readonly homeDir?: string;
  /** The OS keychain by default; tests inject an in-memory one so nothing real is touched. */
  readonly keychain?: KeychainStore;
}

function homeOf(deps: PermissionsDeps): string {
  return deps.homeDir ?? resolveHomeDir({});
}

function openStore(deps: PermissionsDeps): { store: CommandGrantStore; homeDir: string } {
  const homeDir = homeOf(deps);
  const projectConfigDir = findProjectConfigDir(deps.global.cwd, homeDir);
  const store = createCommandGrantStore({
    homeDir,
    projectRoot: commandGrantRoot(deps.global.cwd, projectConfigDir),
    keychain: deps.keychain ?? createOsKeychainStore(),
  });
  return { store, homeDir };
}

/** One refusal per reason, each naming the way out. None of them carries a command, a digest or a keychain message. */
function unavailable(reason: CommandGrantUnavailable | 'full', homeDir: string): CliError {
  switch (reason) {
    case 'full':
      return new CliError(
        'config_error',
        'The remembered-command file is at its line or size bound, so another line cannot be added to it. `relavium permissions revoke --all` removes it.',
      );
    case 'no-key':
      return new CliError(
        'invalid_invocation',
        'The OS keychain is not available (or holds an unusable entry), so the remembered commands cannot be read. Unlock it and retry, or run `relavium permissions revoke --all` to start over: it removes the file and clears the entry.',
      );
    case 'unreadable':
      return new CliError(
        'config_error',
        `The remembered-command file ${stripTerminalControls(commandGrantsPath(homeDir))} could not be read, so nothing in it is trusted. \`relavium permissions revoke --all\` removes it.`,
      );
    case 'unwritable':
      return new CliError('storage_unavailable', '');
  }
}

/** Output that cannot be delivered is its own failure, never a report of success. */
function deliver(deps: PermissionsDeps, emit: (io: CliIo) => void): void {
  try {
    emit(deps.io);
  } catch (error) {
    throw new CliError('output_unavailable', '', { cause: error });
  }
}

const write = (deps: PermissionsDeps, text: string): void =>
  deliver(deps, (io) => io.writeOut(text));
const writeRecords = (deps: PermissionsDeps, records: readonly unknown[]): void =>
  deliver(deps, (io) => writeRecordLines(io, records));

/** `relavium permissions list` — the numbered grants of this project. Exit 0 for an empty list: nothing remembered is not a fault. */
export function permissionsListCommand(deps: PermissionsDeps): ExitCode {
  const { store, homeDir } = openStore(deps);
  const listed = store.list();
  if (!listed.ok) throw unavailable(listed.reason, homeDir);
  if (deps.global.json) {
    writeRecords(
      deps,
      listed.grants.map((grant) => ({
        index: grant.index,
        id: grant.id,
        program: sanitizeInline(grant.program),
        args: grant.args,
        grantedAt: sanitizeInline(grant.grantedAt),
      })),
    );
    return EXIT_CODES.success;
  }
  if (listed.grants.length === 0) {
    write(deps, 'No remembered commands for this project.\n');
    return EXIT_CODES.success;
  }
  const lines = listed.grants.map((grant) => {
    const noun = grant.args === 1 ? 'argument' : 'arguments';
    return `  ${grant.index}. ${sanitizeInline(grant.program)}  (${grant.args} ${noun})  remembered ${sanitizeInline(grant.grantedAt)}\n`;
  });
  write(
    deps,
    `Remembered commands for this project (${listed.grants.length}):\n${lines.join('')}` +
      'Revoke one with `relavium permissions revoke <number>`, or all of them with `relavium permissions revoke --all`.\n',
  );
  return EXIT_CODES.success;
}

/** `relavium permissions revoke <number>|--all`. A number that names nothing is an invalid invocation (exit 2), not a silent no-op. */
export function permissionsRevokeCommand(
  args: PermissionsRevokeArgs,
  deps: PermissionsDeps,
): ExitCode {
  if (args.all) {
    // The recovery needs no project root and no readable file. It also forgets the digest key (best effort: a locked keychain is
    // ignored), so an older copy of the file restored later stops validating.
    const homeDir = homeOf(deps);
    const removed = removeCommandGrantsFile(homeDir, deps.keychain ?? createOsKeychainStore());
    if (!removed.ok) throw unavailable(removed.reason, homeDir);
    if (deps.global.json) {
      writeRecords(deps, [{ action: 'revoke-all', removed: removed.removed }]);
    } else {
      write(
        deps,
        removed.removed
          ? 'Removed every remembered command, for every project.\n'
          : 'There were no remembered commands to remove.\n',
      );
    }
    return EXIT_CODES.success;
  }
  const { store, homeDir } = openStore(deps);
  if (args.index === undefined) {
    throw new CliError(
      'invalid_invocation',
      'Give the number of the remembered command to revoke.',
    );
  }
  const revoked = store.revoke(args.index);
  if (!revoked.ok) {
    if (revoked.reason === 'no-such-grant') {
      throw new CliError(
        'invalid_invocation',
        'There is no remembered command with that number. `relavium permissions list` shows the numbers.',
      );
    }
    throw unavailable(revoked.reason, homeDir);
  }
  if (deps.global.json) {
    writeRecords(deps, [
      {
        action: 'revoke',
        index: args.index,
        id: revoked.id,
        program: sanitizeInline(revoked.program),
        args: revoked.args,
      },
    ]);
  } else {
    write(
      deps,
      `Revoked remembered command ${args.index}: ${sanitizeInline(revoked.program)}, ${revoked.args} ${revoked.args === 1 ? 'argument' : 'arguments'}. It asks again the next time it is needed. The numbers have changed: \`relavium permissions list\` shows them.\n`,
    );
  }
  return EXIT_CODES.success;
}
