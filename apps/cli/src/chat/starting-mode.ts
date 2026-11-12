import { ToolDeniedByUserError, type ConfirmActionHook } from '@relavium/core';
import type { ChatMode } from '@relavium/shared';

import { loadResolvedConfig, type LoadedConfig, type LoadConfigOptions } from '../config/load.js';
import type { ResolvedChatConfig } from '../config/resolve.js';
import { CliError } from '../process/errors.js';

export interface StartingModePreference {
  readonly mode: ChatMode;
  readonly source: ResolvedChatConfig['defaultModeSource'];
  readonly globalMode: ChatMode;
  readonly hintShown: boolean;
}

export function readStartingMode(options: LoadConfigOptions): StartingModePreference {
  return startingModePreference(loadResolvedConfig(options));
}

export function startingModePreference(
  loaded: Pick<LoadedConfig, 'config' | 'globalConfig'>,
): StartingModePreference {
  return Object.freeze({
    mode: loaded.config.chat.defaultMode,
    source: loaded.config.chat.defaultModeSource,
    globalMode: loaded.globalConfig?.preferences?.default_mode ?? 'ask',
    hintShown: loaded.globalConfig?.preferences?.default_mode_hint_shown === true,
  });
}

/** Reuse one strict config snapshot for mode, model and all other session settings. */
export function loadStartingModeConfig(
  authority: StartingModeAuthority,
  options: LoadConfigOptions,
): LoadedConfig {
  try {
    const loaded = loadResolvedConfig(options);
    authority.observe(startingModePreference(loaded));
    return loaded;
  } catch (error) {
    authority.revoke();
    throw error;
  }
}

export interface StartingModeRuntime {
  readonly authority: StartingModeAuthority;
  readonly homeDir: string;
  readonly configPath: string;
  read(cwd: string): LoadedConfig;
  resolve(cwd: string): {
    readonly loaded: LoadedConfig;
    readonly startingMode: ChatModeSelection;
    readonly preference: StartingModePreference;
  };
}

/** Selected operator file and authority are pinned once for every host in an invocation. */
export function createStartingModeRuntime(
  initial: LoadedConfig,
  interactive: boolean,
): StartingModeRuntime {
  const authority = new StartingModeAuthority(interactive, startingModePreference(initial));
  const read = (cwd: string): LoadedConfig =>
    loadStartingModeConfig(authority, {
      cwd,
      home: initial.homeDir,
      configPath: initial.globalConfigPath,
    });
  return Object.freeze({
    authority,
    homeDir: initial.homeDir,
    configPath: initial.globalConfigPath,
    read,
    resolve(cwd: string) {
      const loaded = read(cwd);
      const preference = startingModePreference(loaded);
      const startingMode = authority.resolve(() => preference);
      return Object.freeze({ loaded, startingMode, preference });
    },
  });
}

export interface ChatModeSelection {
  readonly mode: ChatMode;
  readonly origin: 'configured' | 'explicit';
  readonly authority: StartingModeAuthority;
}

/** One invocation owns this state, including every retained/pending/replacement host. */
export class StartingModeAuthority {
  readonly interactive: boolean;
  private autoAdmitted: boolean;
  private revision = 0;

  constructor(interactive: boolean, initial: StartingModePreference) {
    this.interactive = interactive;
    this.autoAdmitted =
      interactive &&
      initial.mode === 'auto' &&
      initial.source === 'global' &&
      initial.globalMode === 'auto';
  }

  revoke(): void {
    this.revision += 1;
    this.autoAdmitted = false;
  }

  get revocationRevision(): number {
    return this.revision;
  }

  observe(preference: StartingModePreference): void {
    if (preference.mode !== 'auto') this.revoke();
  }

  /** Called only after the trusted default picker publishes an explicitly confirmed auto choice. */
  admitConfirmedAutoDefault(expectedRevision: number): boolean {
    if (!this.interactive)
      throw new CliError(
        'invalid_invocation',
        'Starting mode settings require an interactive chat.',
      );
    if (expectedRevision !== this.revision) return false;
    this.autoAdmitted = true;
    return true;
  }

  /** Strict reloads never restore authority. A failed or narrower build revokes before construction. */
  resolve(read: () => StartingModePreference): ChatModeSelection {
    let preference: StartingModePreference;
    try {
      preference = read();
    } catch (error) {
      this.revoke();
      throw error;
    }
    this.observe(preference);
    if (!this.interactive) return this.selection('ask', 'configured');
    if (
      preference.mode === 'auto' &&
      (!this.autoAdmitted || preference.source !== 'global' || preference.globalMode !== 'auto')
    ) {
      this.revoke();
      throw new CliError(
        'invalid_invocation',
        'Starting auto mode is no longer admitted. Choose a mode explicitly or confirm the startup default.',
      );
    }
    return this.selection(preference.mode, 'configured');
  }

  explicit(mode: ChatMode): ChatModeSelection {
    return this.selection(this.interactive ? mode : 'ask', 'explicit');
  }

  private selection(mode: ChatMode, origin: ChatModeSelection['origin']): ChatModeSelection {
    return Object.freeze({ mode, origin, authority: this });
  }

  assertDispatch(selection: ChatModeSelection, toolId: string): void {
    if (
      selection.authority !== this ||
      (selection.origin === 'configured' && selection.mode === 'auto' && !this.autoAdmitted)
    ) {
      throw new ToolDeniedByUserError(
        toolId,
        'user_rejected',
        'Starting auto mode was revoked; choose a current mode before another action.',
      );
    }
  }
}

// Core snapshots this exact hook per turn. Later UI mode changes create another hook,
// so they cannot reauthorize an earlier configured-auto turn at final dispatch.
const selections = new WeakMap<ConfirmActionHook, ChatModeSelection>();

export function bindStartingModePolicy(
  hook: ConfirmActionHook,
  selection: ChatModeSelection,
): void {
  if (selections.has(hook))
    throw new CliError('invalid_invocation', 'Chat mode policy was already bound.');
  selections.set(hook, selection);
}

export function assertStartingModeDispatch(
  authority: StartingModeAuthority,
  hook: ConfirmActionHook | undefined,
  toolId: string,
  governed: ReadonlySet<string>,
): void {
  if (!governed.has(toolId)) return;
  const selection = hook === undefined ? undefined : selections.get(hook);
  if (selection === undefined)
    throw new ToolDeniedByUserError(
      toolId,
      'no_approval_hook',
      'Chat mode admission is unavailable.',
    );
  authority.assertDispatch(selection, toolId);
}
