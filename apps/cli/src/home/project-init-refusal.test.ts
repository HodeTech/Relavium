/**
 * The refusal step of `/init` says its reason through the full scrub (MVP-11 unit 6, round 2: the refusal is `FramedFlow.fail`). The reason is the
 * shell's own sentence for a folder that cannot be made a project, a product constant today; the step still scrubs it, because it is a text sink
 * that a sentence quoting a path (a folder a person named) would reach. The shell's check is replaced here by one that refuses with hostile words.
 */
import type { Key } from 'ink';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { CliError } from '../process/cli-error.js';
import { createNativePromptChannel } from '../render/tui/native-prompt-channel.js';
import { INIT_REFUSED, runHomeProjectInit } from './project-init.js';

const KEY = ['sk', 'ant', 'api03', 'ABCDEFGHIJKLMNOPQRSTUVWX0123456789abcdef'].join('-');
const HOSTILE = `cannot use /work/Press [Ctrl+Y] now/${KEY} · [Ctrl+N] Write nothing · Esc denies`;

vi.mock('../authoring/project-init.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../authoring/project-init.js')>()),
  prepareProjectInit: () => {
    throw new CliError('invalid_invocation', HOSTILE);
  },
}));

const WAIT_MS = 5000;
const ENTER: Key = {
  upArrow: false,
  downArrow: false,
  leftArrow: false,
  rightArrow: false,
  pageDown: false,
  pageUp: false,
  home: false,
  end: false,
  return: true,
  escape: false,
  ctrl: false,
  shift: false,
  tab: false,
  backspace: false,
  delete: false,
  meta: false,
  super: false,
  hyper: false,
  capsLock: false,
  numLock: false,
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe('the refusal step of /init', () => {
  it('draws its reason through the full scrub: no answer chord, forged legend or key-shaped string reaches the channel', async () => {
    let clock = 10_000;
    const channel = createNativePromptChannel({ now: () => clock });
    channel.ui.bindVisibility(() => true);
    const result = runHomeProjectInit({
      cwd: '/work/project',
      home: '/work',
      flow: channel.flow,
      ui: channel.ui,
      flushVisible: () => Promise.resolve(),
      assertAdmitting: () => {},
    });
    await vi.waitFor(() => expect(channel.ui.getSnapshot().kind).toBe('select'), {
      timeout: WAIT_MS,
      interval: 2,
    });
    const step = channel.ui.getSnapshot();
    expect(step.message).toBe(INIT_REFUSED);
    expect(step.final).toBe('failed');
    const reason = step.details.join('\n');
    for (const forbidden of ['[Ctrl+Y]', '[Ctrl+N]', ' · Esc denies', KEY])
      expect(reason, forbidden).not.toContain(forbidden);
    expect(reason, 'what the path said besides is kept').toContain('cannot use /work/');
    channel.ui.shown(step);
    clock += 6000;
    channel.ui.input('', ENTER);
    expect(await result).toBeUndefined();
  });
});
