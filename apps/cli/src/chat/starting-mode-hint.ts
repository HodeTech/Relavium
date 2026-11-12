import type { ChatMode } from '@relavium/shared';

import {
  globalConfigPath,
  prepareChatModeHintShown,
  type PreparedConfigWrite,
} from '../config/write.js';
import type { NoticeFlush } from '../engine/effect-retention.js';
import {
  startingModePreference,
  type ChatModeSelection,
  type StartingModeRuntime,
  type StartingModePreference,
} from './starting-mode.js';

const HINT =
  'You started in ask mode. Shift+Tab or /mode changes the current mode. Use /mode to configure the startup default.';
const REWRITE =
  'Recording this hint rewrites the global config and removes its comments and ordering.';
const FAILED = 'The startup mode hint could not be recorded. Chat remains available.';
const SAVED = 'Startup mode hint recorded.';
const UNCONFIRMED =
  'Startup mode hint recorded, but persistence after a crash could not be confirmed.';

export interface StartingModeHintOptions {
  readonly runtime: StartingModeRuntime;
  readonly cwd: string;
  readonly selection: ChatModeSelection;
  readonly currentMode: () => ChatMode;
  readonly notice: (text: string) => void;
  /** Must acknowledge the exact published transcript notice, not merely a flushed footer. */
  readonly flushNotice: NoticeFlush;
  readonly isActive: () => boolean;
  readonly assertAdmitting: () => void;
  /** A host with synchronous frame/custody evidence revalidates it at both writer gates. */
  readonly assertVisible?: () => void;
}

export interface StartingModeHintPorts {
  readonly prepareHintShown?: (home: string, configPath: string) => PreparedConfigWrite;
}

interface HintState {
  delivered: boolean;
  pending?: Promise<void>;
}

// An invocation owns its runtime. Neither construction nor a discarded build consumes this state.
const hints = new WeakMap<StartingModeRuntime, HintState>();

function eligible(options: StartingModeHintOptions): boolean {
  return (
    options.runtime.authority.interactive &&
    options.selection.authority === options.runtime.authority &&
    options.selection.origin === 'configured' &&
    options.selection.mode === 'ask' &&
    options.currentMode() === 'ask' &&
    options.isActive()
  );
}

function assertCurrent(options: StartingModeHintOptions): void {
  options.assertAdmitting();
  if (!eligible(options)) throw new Error('The startup mode hint is no longer active.');
}

/** Diagnostics are advisory: a closed/failed notice sink must never prevent chat. */
function note(options: StartingModeHintOptions, text: string): void {
  try {
    assertCurrent(options);
    options.notice(text);
  } catch {
    // There is no acknowledgement or retry through a different output surface.
  }
}

async function deliver(
  options: StartingModeHintOptions,
  ports: StartingModeHintPorts,
  state: HintState,
): Promise<void> {
  try {
    assertCurrent(options);
    let preference: StartingModePreference;
    try {
      // The runtime performs the strict reload and observes narrower preferences before returning.
      preference = startingModePreference(options.runtime.read(options.cwd));
    } catch {
      options.runtime.authority.revoke();
      throw new Error('The startup mode preference could not be read.');
    }
    if (preference.hintShown || preference.mode !== 'ask') return;
    assertCurrent(options);
    await options.flushNotice(() => {
      assertCurrent(options);
      options.notice(HINT);
    });
    const assertDisplayed = (): void => {
      assertCurrent(options);
      options.assertVisible?.();
    };
    assertDisplayed();
    // Visible delivery is the invocation deduplication boundary. A later save failure is not a
    // reason to repeat the hint in this invocation; another invocation still reads the actual file.
    state.delivered = true;
    const prepare =
      ports.prepareHintShown ??
      ((home: string, configPath: string) =>
        prepareChatModeHintShown(
          home,
          configPath === globalConfigPath(home) ? undefined : configPath,
        ));
    const prepared = prepare(options.runtime.homeDir, options.runtime.configPath);
    if (prepared.rewriteNeeded) {
      await options.flushNotice(() => {
        assertCurrent(options);
        options.notice(REWRITE);
      });
    }
    assertDisplayed();
    const result = prepared.publish(assertDisplayed);
    note(options, result.durability === 'confirmed' ? SAVED : UNCONFIRMED);
  } catch {
    note(options, FAILED);
  }
}

/** Run only from an active interactive renderer hook. All failures remain advisory and path-free. */
export async function activateStartingModeHint(
  options: StartingModeHintOptions,
  ports: StartingModeHintPorts = {},
): Promise<void> {
  try {
    if (!eligible(options)) return;
    let state = hints.get(options.runtime);
    if (state === undefined) {
      state = { delivered: false };
      hints.set(options.runtime, state);
    }
    // Serialize replacement activations, but let the new current session retry a discarded flush.
    while (state.pending !== undefined) {
      await state.pending;
      if (!eligible(options)) return;
    }
    if (state.delivered) return;
    // Defer work until after installing the lock: a notice subscriber may re-enter synchronously.
    const pending = Promise.resolve().then(() => deliver(options, ports, state));
    state.pending = pending;
    try {
      await pending;
    } finally {
      if (state.pending === pending) delete state.pending;
    }
  } catch {
    note(options, FAILED);
  }
}
