import '../frames.js';
import { label, type Producer, type Recorder } from '../golden.js';

import type { RunHostSnapshot } from '../../../../home/run-host.js';
import { NO_USABLE_KEY_NOTICE } from '../../../../home/drive-home.js';
import { launchBusy } from '../../../../home/run-launch.js';
import { RESUME_ANOTHER_DIRECTORY, RESUME_RESTORING } from '../../../../home/session-picker.js';
import { STARTING_CHAT_LINE } from '../../home-app.js';
import { PROVIDER_KEYS_AT_THE_HOME } from '../../home-controller.js';
import { STDIN_PROMPT_NOTE } from '../../../../commands/agent-run.js';
import { requireKey } from '../../../../onboarding/wizard.js';
import { DUMP_PROMPT, dumpToScrollback } from '../../../scrollback.js';
import { cardStates, SIZE_100, SIZE_80, withCard } from './prompts.js';

/**
 * The sentences the Home and its flows add to the cards of `/resume`, `/run`, `/providers`, `/models`, the first-run wizard and the
 * suspended transcript. A sentence a function builds is recorded by calling it; one a view draws is recorded from the real view; one that
 * is written inline in a host too large to mount for its sake (the controller, `driveHome`, the Home's app, the agent-run command) is the
 * source literal ({@link sourceLiteral}), and where a real view can draw it too, the frame is recorded beside it.
 */

const NO_SENTENCE = '(no sentence: the form opens)';

/** What `/run` answers while the host already hosts a run: the one function that builds it, over every snapshot that decides it. */
const runLaunchBusy: Recorder = () => {
  const cases: readonly (readonly [string, RunHostSnapshot])[] = [
    [
      label({ launching: false, active: 'none' }),
      { launching: false, active: undefined, last: undefined },
    ],
    [
      label({ launching: true, active: 'none' }),
      { launching: true, active: undefined, last: undefined },
    ],
    [
      label({ launching: false, active: 'preparing', leg: 'start' }),
      {
        launching: false,
        active: { leg: 'start', runId: undefined, cancelling: false },
        last: undefined,
      },
    ],
    [
      label({ launching: false, active: 'executing', leg: 'start', cancelling: false }),
      {
        launching: false,
        active: { leg: 'start', runId: 'run_0123456789abcdef', cancelling: false },
        last: undefined,
      },
    ],
    [
      label({ launching: false, active: 'executing', leg: 'resume', cancelling: true }),
      {
        launching: false,
        active: { leg: 'resume', runId: 'run_0123456789abcdef', cancelling: true },
        last: undefined,
      },
    ],
  ];
  return Object.fromEntries(
    cases.map(([state, snapshot]) => [state, launchBusy(snapshot) ?? NO_SENTENCE]),
  );
};

/** The validator message of the wizard's key prompt: a local function of the wizard, only reachable through a clack prompt (source literal). */
const onboardingKeyRequired: Recorder = () => ({
  // The key is the one the golden was recorded under, so the diff reads before and after on one entry.
  'validate message (source literal)': requireKey('') ?? NO_SENTENCE,
});

/** The acknowledgement line under the suspended transcript: the constant, and the whole block `dumpToScrollback` writes around it. */
const scrollbackDumpPrompt: Recorder = () => {
  const block = (lines: readonly string[]): readonly string[] => {
    let written = '';
    void dumpToScrollback(
      {
        writeOut: (text) => {
          written = text;
        },
        // Never answered: the block is written before the wait starts.
        waitForContinue: () => new Promise<void>(() => undefined),
      },
      lines,
    );
    return written.split('\n').filter((row) => row.length > 0);
  };
  return {
    DUMP_PROMPT: DUMP_PROMPT,
    ...Object.fromEntries(
      [
        ['transcript=empty', []],
        ['transcript=one-line', ['hello']],
      ].map(([state, lines]) => [
        `written block ${String(state)}`,
        block(lines as readonly string[]),
      ]),
    ),
  };
};

/**
 * The three sentences `driveHome` writes: a chat refused for want of a key, a session of another directory, and the wait while one restores.
 * The last two are the REAL strings (`RESUME_ANOTHER_DIRECTORY`, `RESUME_RESTORING` of `home/session-picker.ts`, which `driveHome` draws),
 * not exports that only this recorder reads.
 */
const driveHomeSentences: Recorder = () => {
  const out: Record<string, readonly string[] | string> = {
    'chat notice: no usable key (source literal)': NO_USABLE_KEY_NOTICE,
    'resume notice: another directory (source literal)': RESUME_ANOTHER_DIRECTORY,
    'resume wait (source literal)': RESUME_RESTORING,
  };
  // The restore's wait is the native prompt channel's busy card (`restoring.busy(RESUME_RESTORING)`): the real view draws it, and its legend says
  // what `Esc` does to it.
  for (const size of [SIZE_80, SIZE_100]) {
    withCard(
      (channel) => {
        channel.flow.busy(RESUME_RESTORING);
      },
      ({ ui }) =>
        Object.assign(
          out,
          cardStates(
            `resume wait frame size=${String(size.cols)}x${String(size.rows)}`,
            ui,
            ui.getSnapshot(),
            size,
          ),
        ),
    );
  }
  return out;
};

/**
 * The sentences the Home's controller writes: the provider-typo pointer. (The `/models` picker's two hints are retired with it: `/models` is a
 * popup, whose rows say why a model cannot be chosen, `models-popup` in `popups.tsx`.)
 */
const homeControllerSentences: Recorder = () => ({
  'provider typo, in a hosted chat (source literal)': PROVIDER_KEYS_AT_THE_HOME,
});

/** The echo line of the Home while the first chat is built: inline in the Home's app (source literal). */
const homeAppStartingChat: Recorder = () => ({
  'echo line (source literal)': STARTING_CHAT_LINE,
});

/** What `relavium agent run` says on stderr before it reads a prompt from a terminal: the shell's own line, not a TUI string (source literal). */
const agentRunStdinNote: Recorder = () => ({
  'stderr line (source literal)': STDIN_PROMPT_NOTE,
});

export const HOME_HOST_PRODUCERS: readonly Producer[] = [
  {
    id: 'run-launch-busy',
    file: 'home/run-launch.ts',
    describe:
      'launchBusy: what /run says while a run already starts or executes (names the strip’s row and Enter), by host snapshot.',
  },
  {
    id: 'onboarding-key-required',
    file: 'onboarding/wizard.ts',
    describe:
      'The wizard key prompt’s validator message (names Esc to skip setup); clack path only, a source literal.',
  },
  {
    id: 'scrollback-dump-prompt',
    file: 'render/scrollback.ts',
    describe:
      'The line under the suspended transcript (Press Enter to return), and the block dumpToScrollback writes around it.',
  },
  {
    id: 'drive-home-sentences',
    file: 'home/drive-home.tsx',
    describe:
      'The key-less chat refusal, the other-directory resume notice, and the restoring note (drawn by the native card).',
  },
  {
    id: 'home-controller-sentences',
    file: 'render/tui/home-controller.ts',
    describe:
      'The provider-typo pointer in a hosted chat (the /models picker’s hints are retired with it).',
  },
  {
    id: 'home-app-starting-chat',
    file: 'render/tui/home-app.tsx',
    describe:
      'The echo line while the first chat is built (Starting chat… · Ctrl+C to exit); a source literal.',
  },
  {
    id: 'agent-run-stdin-note',
    file: 'commands/agent-run.ts',
    describe:
      'The stderr line before a one-shot reads its prompt from a terminal (Ctrl-D / Ctrl-Z); shell output, a source literal.',
  },
];

export const HOME_HOST_RECORDERS = {
  'run-launch-busy': runLaunchBusy,
  'onboarding-key-required': onboardingKeyRequired,
  'scrollback-dump-prompt': scrollbackDumpPrompt,
  'drive-home-sentences': driveHomeSentences,
  'home-controller-sentences': homeControllerSentences,
  'home-app-starting-chat': homeAppStartingChat,
  'agent-run-stdin-note': agentRunStdinNote,
} as const satisfies Readonly<Record<string, Recorder>>;
