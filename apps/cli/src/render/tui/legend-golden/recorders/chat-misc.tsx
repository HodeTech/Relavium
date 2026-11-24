import { legendStates } from '../frames.js';
import { MarkdownStream } from '../../../markdown/stream.js';
import { label, type Producer, type Recorder } from '../golden.js';
import { isHintShaped } from '../hint-shape.js';
import { sourceLiteral } from '../source-literal.js';
import { CHAT_MODES } from '@relavium/shared';
import { effortUnavailableNote } from '../../../../chat/effort-notice.js';
import {
  commandsOf,
  placementOf,
  type PaletteSurface,
} from '../../../../commands/repl-commands.js';
import {
  providerKeyAvailabilityMessage,
  providerRowHint,
  type CredentialSurface,
  type ProviderKeyAvailability,
} from '../../../../engine/providers.js';
import { AttachmentBar } from '../../attachment-bar.js';
import { ChatView, idleHint } from '../../chat-ink.js';
import { MODE_CHANGE_RUNNING_NOTICE, emptyEditor } from '../../chat-input.js';
import { formatBusyLine, formatReasoningPanel, streamingAbortHint } from '../../chat-projection.js';
import { createChatStore } from '../../chat-store.js';
import { spinnerFrame } from '../../format.js';
import { FULLSCREEN_TRANSCRIPT_BOUND, type SessionViewState } from '../../session-view-model.js';
import { shellDenyHint } from '../../shell.js';

/**
 * The chat's own hints ([ADR-0057](../../../../../../../docs/decisions/0057-cli-chat-modes-and-per-tool-approval.md),
 * [ADR-0122](../../../../../../../docs/decisions/0122-the-home-is-the-interactive-product.md)) and the sentences elsewhere that name a key:
 * the idle prompt's hint bar, the in-flight busy line and its abort hint, the reasoning panel's toggle, the interrupt line, the notice a
 * mode change refuses with, the shell deny hint, the attachment bar, the registry's descriptions, and the provider and effort notices.
 */

export const CHAT_MISC_PRODUCERS: readonly Producer[] = [
  {
    id: 'chat-view-hints',
    file: 'render/tui/chat-ink.tsx',
    describe:
      'the chat view’s hint rows (idle bar, busy line, Interrupting line, display-paused line, thinking toggle) by running x draft x armed x approval x compaction x command x reasoning, drawn with and without colour',
  },
  {
    id: 'chat-idle-hint',
    file: 'render/tui/chat-ink.tsx',
    describe: '`idleHint(armed, emptyDraft)`: the idle prompt’s hint bar for its three states',
  },
  {
    id: 'chat-busy-line',
    file: 'render/tui/chat-projection.ts',
    describe:
      'the in-flight busy line (`… · Esc to stop`) and the abort hint under streamed content, by what the turn is doing',
  },
  {
    id: 'chat-reasoning-header',
    file: 'render/tui/chat-projection.ts',
    describe: 'the reasoning panel’s header with its `Ctrl+T` toggle, collapsed and expanded',
  },
  {
    id: 'chat-input-notice',
    file: 'render/tui/chat-input.ts',
    describe: 'the notice `Shift+Tab` answers with while a turn runs',
  },
  {
    id: 'shell-deny-hint',
    file: 'render/tui/shell.ts',
    describe: 'the line a refused `!` command leaves, which names `Shift+Tab` in plan mode',
  },
  {
    id: 'attachment-bar',
    file: 'render/tui/attachment-bar.tsx',
    describe: 'the chip bar above the prompt and its `Esc to clear` tail',
  },
  {
    id: 'repl-command-words',
    file: 'commands/repl-commands.ts',
    describe:
      'the registry words that name a key (a command’s description on a surface, its reject hint), by surface',
  },
  {
    id: 'provider-key-hints',
    file: 'engine/providers.ts',
    describe:
      'the provider row’s hint (`Enter to review it`) and the no-key remedy sentence, by key status and surface',
  },
  {
    id: 'effort-unavailable-note',
    file: 'chat/effort-notice.ts',
    describe:
      'the reasoning-effort note that names `Ctrl+R` (TUI) or a shell command (shell) for a model the catalog does not know',
  },
  {
    id: 'starting-mode-hint',
    file: 'chat/starting-mode-hint.ts',
    describe:
      'the one-time notice that names `Shift+Tab` and `/mode` when a chat starts in ask mode',
  },
];

// ── the chat view ────────────────────────────────────────────────────────────────────────────────────────────────────────

const base = (): SessionViewState =>
  createChatStore(false, undefined, FULLSCREEN_TRANSCRIPT_BOUND).getSnapshot().state;

interface ChatCase {
  readonly state: string;
  readonly running?: boolean;
  readonly text?: string;
  readonly armed?: boolean;
  readonly patch?: Partial<SessionViewState>;
  readonly busyCommand?: string;
  readonly suspended?: boolean;
  readonly reasoningVisible?: boolean;
  /** Characters the markdown stream was given: the answer is drawn through it, with an `…` once it holds more than it keeps live. */
  readonly streamed?: number;
}

const CHAT_CASES: readonly ChatCase[] = [
  { state: 'idle, empty draft' },
  { state: 'idle, a draft', text: 'hello' },
  { state: 'idle, armed', armed: true },
  { state: 'running, before the first token', running: true, patch: { turnStartedAtMs: 0 } },
  {
    state: 'running, armed (Interrupting)',
    running: true,
    armed: true,
    patch: { turnStartedAtMs: 0 },
  },
  {
    state: 'running, the model is reasoning',
    running: true,
    patch: { turnStartedAtMs: 0, liveReasoning: 'thinking about it' },
  },
  {
    state: 'running, reasoning panel expanded',
    running: true,
    reasoningVisible: true,
    patch: { turnStartedAtMs: 0, liveReasoning: 'thinking about it' },
  },
  { state: 'running, answer streaming', running: true, patch: { liveTokens: 'The answer so far' } },
  {
    state: 'running, answer streaming through the markdown stream',
    running: true,
    streamed: 20,
    patch: { liveTokens: 'The answer so far' },
  },
  {
    state: 'running, a long answer streaming (the head is elided)',
    running: true,
    streamed: 6000,
    patch: { liveTokens: 'The answer so far' },
  },
  {
    state: 'running, waiting for an approval',
    running: true,
    patch: { turnStartedAtMs: 0, approvalSinceMs: 1000 },
  },
  { state: 'running, compacting the conversation', running: true, patch: { compacting: true } },
  { state: 'running, a ! command', running: true, busyCommand: 'npm test' },
  { state: 'running, display paused', running: true, suspended: true },
];

/** A markdown stream that was given `characters` characters of an answer, as the chat's live turn holds one. */
function streamOf(characters: number): MarkdownStream {
  const stream = new MarkdownStream();
  stream.append('word '.repeat(Math.ceil(characters / 5)).slice(0, characters));
  return stream;
}

const chatView = (item: ChatCase, color: boolean) => (
  <ChatView
    state={{ ...base(), ...item.patch }}
    tick={0}
    nowMs={5000}
    color={color}
    editor={item.text === undefined ? emptyEditor() : { text: item.text, cursor: item.text.length }}
    running={item.running === true}
    mode="ask"
    reasoningVisible={item.reasoningVisible === true}
    interruptArmed={item.armed === true}
    busyCommand={item.busyCommand}
    displaySuspended={item.suspended === true}
    markdown={item.streamed === undefined ? undefined : streamOf(item.streamed)}
    columns={100}
  />
);

const chatViewHints: Recorder = () => {
  const out: Record<string, readonly string[]> = {};
  for (const item of CHAT_CASES) {
    Object.assign(
      out,
      legendStates(item.state, (color) => chatView(item, color), { columns: 100 }),
    );
  }
  return out;
};

const idle: Recorder = () => {
  const out: Record<string, string> = {};
  for (const armed of [false, true]) {
    for (const emptyDraft of [true, false])
      out[label({ armed, emptyDraft })] = idleHint(armed, emptyDraft);
  }
  return out;
};

const busyLine: Recorder = () => {
  const spinner = spinnerFrame(0);
  const common = { spinner, liveTokens: '', liveTokensTruncated: false };
  const cases: Record<string, ReturnType<typeof formatBusyLine>> = {
    compacting: formatBusyLine({ ...common, compacting: true }),
    'a ! command': formatBusyLine({ ...common, compacting: false, busyCommand: 'npm test' }),
    'waiting for an approval': formatBusyLine({
      ...common,
      compacting: false,
      awaitingApprovalMs: 65_000,
    }),
    'working, no timer yet': formatBusyLine({ ...common, compacting: false }),
    working: formatBusyLine({ ...common, compacting: false, elapsedMs: 5000 }),
    thinking: formatBusyLine({
      ...common,
      compacting: false,
      elapsedMs: 5000,
      reasoningActive: true,
    }),
    'streaming content': formatBusyLine({ ...common, compacting: false, liveTokens: 'The answer' }),
  };
  const out: Record<string, readonly string[]> = {};
  for (const [state, line] of Object.entries(cases)) {
    out[state] = [
      line.text,
      `dim=${String(line.dim)}`,
      `abort hint: ${streamingAbortHint(line) ?? '(none)'}`,
    ];
  }
  return out;
};

const reasoningHeader: Recorder = () => {
  const out: Record<string, string> = {};
  for (const visible of [false, true]) {
    out[label({ visible })] = formatReasoningPanel({
      liveReasoning: 'thinking',
      liveReasoningTruncated: false,
      visible,
      columns: 80,
    }).header;
  }
  return out;
};

const inputNotice: Recorder = () => ({
  'a mode change while a turn runs': MODE_CHANGE_RUNNING_NOTICE,
});

const shellDeny: Recorder = () => {
  const cmd = { command: 'npm', args: ['test'] };
  const out: Record<string, string> = {};
  for (const mode of CHAT_MODES)
    out[label({ mode, allowlist: false })] = shellDenyHint(cmd, false, mode);
  out[label({ allowlist: true })] = shellDenyHint(cmd, true, 'ask');
  return out;
};

const attachmentBar: Recorder = () =>
  legendStates(
    'two chips',
    (color) => (
      <AttachmentBar
        color={color}
        attachments={[
          { kind: 'file', path: 'src/a.ts', content: 'x', sizeBytes: 1 },
          {
            kind: 'command',
            cmd: { command: 'npm', args: ['test'] },
            exitCode: 0,
            stdout: '',
            stderr: '',
          },
        ]}
      />
    ),
    { columns: 100 },
  );

// ── sentences elsewhere ──────────────────────────────────────────────────────────────────────────────────────────────────

const replWords: Recorder = () => {
  const out: Record<string, string> = {};
  for (const surface of [
    'home',
    'chat',
    'home-chat',
  ] as const satisfies readonly PaletteSurface[]) {
    for (const command of commandsOf(surface)) {
      const description = placementOf(command.name, surface)?.description ?? '';
      if (isHintShaped(description))
        out[label({ surface, command: command.name, field: 'description' })] = description;
      if (command.rejectHint !== undefined && isHintShaped(command.rejectHint))
        out[label({ surface, command: command.name, field: 'rejectHint' })] = command.rejectHint;
    }
  }
  return out;
};

const AVAILABILITIES: readonly (readonly [string, ProviderKeyAvailability])[] = [
  [
    'present-standard-not-allowed',
    {
      status: 'present-standard-not-allowed',
      source: { kind: 'standard-env', name: 'ANTHROPIC_API_KEY' },
      keychainHealth: 'available',
    },
  ],
  [
    'ineligible-custom-endpoint',
    {
      status: 'ineligible-custom-endpoint',
      source: { kind: 'standard-env', name: 'OPENAI_API_KEY' },
      keychainHealth: 'available',
    },
  ],
  ['unavailable', { status: 'unavailable', keychainHealth: 'unavailable' }],
  ['missing', { status: 'missing', keychainHealth: 'available' }],
  [
    'usable',
    {
      status: 'usable',
      source: { kind: 'keychain', label: 'OS keychain' },
      keychainHealth: 'available',
    },
  ],
];

const providerHints: Recorder = () => {
  const out: Record<string, string> = {};
  for (const [status, availability] of AVAILABILITIES) {
    out[label({ status, text: 'row hint' })] = providerRowHint(availability);
    // A usable key has no remedy to name: one surface says it all.
    const surfaces: readonly CredentialSurface[] =
      status === 'usable' ? ['home'] : ['home', 'home-chat', 'standalone-chat', 'shell'];
    for (const surface of surfaces) {
      out[label({ status, text: 'message', surface })] = providerKeyAvailabilityMessage(
        'anthropic',
        availability,
        surface,
      );
    }
  }
  return out;
};

const effortNote: Recorder = () => ({
  'surface=tui': effortUnavailableNote('some-new-model', 'tui'),
  'surface=shell': effortUnavailableNote('some-new-model', 'shell'),
});

const startingMode: Recorder = () => ({
  'a chat starts in ask mode': sourceLiteral(
    'chat/starting-mode-hint.ts',
    'You started in ask mode',
  ),
});

export const CHAT_MISC_RECORDERS = {
  'chat-view-hints': chatViewHints,
  'chat-idle-hint': idle,
  'chat-busy-line': busyLine,
  'chat-reasoning-header': reasoningHeader,
  'chat-input-notice': inputNotice,
  'shell-deny-hint': shellDeny,
  'attachment-bar': attachmentBar,
  'repl-command-words': replWords,
  'provider-key-hints': providerHints,
  'effort-unavailable-note': effortNote,
  'starting-mode-hint': startingMode,
} as const satisfies Readonly<Record<string, Recorder>>;
