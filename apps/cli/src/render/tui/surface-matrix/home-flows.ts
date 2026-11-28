import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runModeSettings } from '../../../chat/mode-settings.js';
import { createStartingModeRuntime } from '../../../chat/starting-mode.js';
import { loadResolvedConfig } from '../../../config/load.js';
import type { NativePromptChannel } from './home-host.js';

/**
 * The real flows the Home asks its native prompt channel for, run over the channel the matrix mounted, with scripted ports (nothing is
 * written outside a temporary directory, nothing reaches a network or the keychain). The card a person sees is the card the flow draws.
 */

/** What a flow needs of the host it runs over: the channel, and a place to register what to close afterwards. Both chat hosts and the Home have it. */
export interface FlowHost {
  readonly channel: NativePromptChannel | undefined;
  defer: (cleanup: () => void) => void;
}

function channelOf(m: FlowHost): NativePromptChannel {
  if (m.channel === undefined) throw new Error('the surface needs a native prompt channel');
  return m.channel;
}

/** A temporary operator home and project directory, removed when the cell ends. */
function temporaryHome(m: FlowHost): { home: string; cwd: string } {
  const root = mkdtempSync(join(tmpdir(), 'relavium-matrix-'));
  const home = join(root, 'home');
  const cwd = join(home, 'project');
  mkdirSync(cwd, { recursive: true });
  m.defer(() => {
    rmSync(root, { recursive: true, force: true });
  });
  return { home, cwd };
}

/** A flow left running: the matrix never awaits it, so a rejection (the channel is disposed at the end) must not be unhandled. */
const leave = (running: Promise<unknown>): void => {
  running.catch(() => undefined);
};

/** `/mode`: the startup-default flow's first question, over a temporary home and a real config read. */
export function openModeFlow(m: FlowHost): void {
  const { home, cwd } = temporaryHome(m);
  const runtime = createStartingModeRuntime(loadResolvedConfig({ cwd, home }), true);
  leave(
    runModeSettings({
      runtime,
      cwd,
      interactive: true,
      flow: channelOf(m).flow,
      notice: () => {},
      assertAdmitting: () => {},
      publish: (prepared, assertAdmitting) => prepared.publish(assertAdmitting),
    }),
  );
}
