import type { AskUserRequest, ToolApprovalRequest, ToolPreview } from '@relavium/core';

import { boundAgentView, type BoundAgentView } from '../../../chat/bound-agent-view.js';
import type { CommandCardFacts } from '../../../chat/command-facts.js';
import { buildDefaultChatAgent } from '../../../chat/default-agent.js';
import type { PermissionsPort } from '../../../permissions/chat-permissions.js';
import { editedFilePreview } from '../fixtures/edit-diff.js';
import type { MentionReader } from '../mention.js';
import {
  homeModelsPort,
  standaloneModelsPort,
  type ChatMount,
  type ChatSetup,
} from './chat-host.js';
import { openModeFlow } from './home-flows.js';
import { KEYS } from './home-host.js';
import {
  FULL_SCREEN_CHAT_FILLS_THE_TERMINAL,
  HOSTED_CHAT_PALETTE_OVERFLOWS_INLINE,
  STANDALONE_CHAT_PALETTE_FILLS_INLINE,
} from './known-failures.js';
import type { KnownFailure, SurfaceBase } from './registry.js';
import type { ChatSurface } from './surface-types.js';
import { isBelowFloor, type Variant } from './variants.js';

/**
 * The chat's surfaces. A chat surface is registered once and mounted in both hosts: `chat.<name>` (the chat the Home hosts) and
 * `standalone-chat.<name>` (`relavium chat`), because the same `ChatView`, cards and sheets are under two input owners and the matrix
 * is what shows that they still look the same under both.
 */
export interface ChatSurfaceDefinition extends Omit<SurfaceBase, 'id' | 'knownFailure'> {
  readonly name: string;
  readonly setup?: ChatSurface['setup'];
  readonly open: ChatSurface['open'];
  /** The hosts that have this surface (default both). */
  readonly hosts?: readonly ChatSurface['host'][];
  /**
   * Where the full-screen chat's viewport fills the terminal (its known height failure), per host: `false` for a screen that takes the
   * whole terminal in place of the conversation (the review's full view and lists, and a native card of the stand-alone chat), which is not
   * that viewport; a predicate for a surface that fills it in some cells only. Default: every full-screen cell.
   */
  readonly viewport?:
    | boolean
    | Partial<Record<ChatSurface['host'], boolean | ((variant: Variant) => boolean)>>;
  /** What is known to fail, per host (a failure of the Home-hosted chat is not a failure of the stand-alone one). */
  readonly knownFailure?: Partial<
    Record<ChatSurface['host'], KnownFailure | readonly KnownFailure[]>
  >;
}

const asList = (
  known: KnownFailure | readonly KnownFailure[] | undefined,
): readonly KnownFailure[] => (known === undefined ? [] : 'property' in known ? [known] : known);

function viewportFailure(
  viewport: ChatSurfaceDefinition['viewport'],
  host: ChatSurface['host'],
): readonly KnownFailure[] {
  const here = typeof viewport === 'object' ? viewport[host] : viewport;
  if (here === false) return [];
  if (typeof here === 'function') {
    return [{ ...FULL_SCREEN_CHAT_FILLS_THE_TERMINAL, where: here }];
  }
  return [FULL_SCREEN_CHAT_FILLS_THE_TERMINAL];
}

export function chatSurfaces(definitions: readonly ChatSurfaceDefinition[]): ChatSurface[] {
  return definitions.flatMap((definition) =>
    (definition.hosts ?? ['chat', 'standalone-chat']).map(
      (host): ChatSurface => ({
        host,
        id: `${host}.${definition.name}`,
        title: `${definition.title} (${host === 'chat' ? 'in the Home' : 'stand-alone chat'})`,
        exitKey: definition.exitKey,
        landmark: definition.landmark,
        selectedRow: definition.selectedRow,
        belowFloor: definition.belowFloor,
        variants: definition.variants,
        knownFailure: [
          ...viewportFailure(definition.viewport, host),
          ...asList(definition.knownFailure?.[host]),
        ],
        notes: definition.notes,
        setup: definition.setup,
        open: definition.open,
      }),
    ),
  );
}

const MODEL = 'claude-sonnet-4-5';

/** The session ports of one chat surface, given once and placed where each host takes them. */
interface Ports {
  readonly permissions?: PermissionsPort;
  readonly boundAgent?: () => BoundAgentView;
  readonly mentionReader?: MentionReader;
  readonly models?: boolean;
  readonly effort?: boolean;
  readonly seedModel?: boolean;
}

function setupWith(ports: Ports): ChatSetup {
  const effort = ports.effort === true;
  return {
    ...(ports.seedModel === true || effort ? { seed: { model: MODEL, transcript: [] } } : {}),
    standalone: {
      ...(ports.permissions === undefined ? {} : { permissions: ports.permissions }),
      ...(ports.boundAgent === undefined ? {} : { boundAgent: ports.boundAgent }),
      ...(ports.mentionReader === undefined ? {} : { mentionReader: ports.mentionReader }),
      ...(ports.models === true ? { modelPicker: standaloneModelsPort } : {}),
      ...(effort ? { onSetEffort: () => {} } : {}),
    },
    hosted: {
      ...(ports.models === true ? { models: homeModelsPort } : {}),
      session: {
        ...(ports.permissions === undefined ? {} : { permissions: ports.permissions }),
        ...(ports.boundAgent === undefined ? {} : { boundAgent: ports.boundAgent }),
        ...(ports.mentionReader === undefined ? {} : { mentionReader: ports.mentionReader }),
        ...(effort ? { onSetEffort: () => {} } : {}),
      },
    },
  };
}

const CHAT_PERMISSIONS: PermissionsPort = {
  surface: 'chat',
  load: () => ({
    project: {
      ok: true,
      rows: [{ id: 'a', label: 'npm, 1 argument', remembered: '2026-11-19 12:00Z' }],
    },
    session: [],
  }),
  withdraw: () => ({ tone: 'done', text: 'Withdrawn. Auto mode asks about it again.' }),
};

const MENTION_READER: MentionReader = {
  list: () =>
    Promise.resolve([
      { name: 'src', type: 'directory' as const, path: 'src' },
      { name: 'app.ts', type: 'file' as const, path: 'app.ts' },
      { name: 'README.md', type: 'file' as const, path: 'README.md' },
    ]),
  read: () => Promise.resolve({ content: 'x', sizeBytes: 1 }),
};

const FILE_WRITE: ToolApprovalRequest = {
  toolId: 'edit_file',
  action: 'fs_write',
  preview: { path: 'src/app.ts' },
  unredactedPreview: { path: 'src/app.ts' },
};
const EDIT_PREVIEW: ToolPreview = editedFilePreview(12, {
  4: 'const answer = 42;',
  9: 'return answer;',
});

const COMMAND_ARGV = ['npm', 'test'] as const;
const COMMAND_REQUEST: ToolApprovalRequest = {
  toolId: 'run_command',
  action: 'process',
  preview: { command: COMMAND_ARGV.join(' ') },
  unredactedPreview: { command: COMMAND_ARGV.join(' ') },
  argv: COMMAND_ARGV,
  commandAdmitted: false,
};
const COMMAND_PREVIEW: ToolPreview = {
  kind: 'operation',
  target: COMMAND_ARGV.join(' '),
  fields: COMMAND_ARGV.map((value) => ({ name: '', value })),
};
const COMMAND_FACTS: CommandCardFacts = {
  standing: 'not-pre-approved',
  runsCode: false,
  protectedPath: false,
  cwd: '/work/project',
  offers: { session: true, remember: true },
};

const QUESTION: AskUserRequest = {
  questions: [
    {
      header: 'Pick',
      question: 'Which file should I change?',
      multiSelect: false,
      options: [
        { label: 'alpha.ts', description: 'The first file' },
        { label: 'beta.ts', description: 'The second file' },
      ],
    },
  ],
};

/** An approval for a file edit, left unanswered (the matrix never answers: a card still open at the end is cancelled, which is not an answer). */
function askFileEdit(m: ChatMount): void {
  m.store
    .requestApproval(FILE_WRITE, true, undefined, { callId: 'call-1', preview: EDIT_PREVIEW })
    .catch(() => undefined);
}

/** A finished tool call, so the details list has one row. */
function finishToolCall(m: ChatMount): void {
  m.store.applyToolLiveEvent({ phase: 'started', callId: 'call-1', toolId: 'edit_file' });
  m.store.applyToolLiveEvent({
    phase: 'preview',
    callId: 'call-1',
    toolId: 'edit_file',
    preview: EDIT_PREVIEW,
  });
  m.store.applyToolLiveEvent({
    phase: 'completed',
    callId: 'call-1',
    toolId: 'edit_file',
    outcome: 'success',
    summary: 'Edited src/app.ts',
  });
}

const typeLineAndWait =
  (command: string, landmark: string) =>
  async (m: ChatMount): Promise<void> => {
    await m.typeLine(command);
    await m.until(() => m.text().includes(landmark));
  };

export const CHAT_SURFACES: readonly ChatSurface[] = chatSurfaces([
  {
    name: 'idle',
    title: 'The idle chat prompt',
    exitKey: 'Ctrl+C',
    landmark: 'for commands',
    belowFloor: 'renders',
    open: async () => {},
  },
  {
    name: 'palette',
    title: 'The / palette, laid out upwards from the prompt',
    exitKey: 'Esc',
    landmark: 'select · Enter run',
    selectedRow: '/models  ',
    belowFloor: 'renders',
    knownFailure: {
      chat: HOSTED_CHAT_PALETTE_OVERFLOWS_INLINE,
      'standalone-chat': STANDALONE_CHAT_PALETTE_FILLS_INLINE,
    },
    open: async (m) => {
      m.key('/');
      await m.until(() => m.text().includes('Enter run'));
    },
  },
  {
    name: 'model-picker',
    title: 'The /models picker',
    exitKey: 'Esc',
    landmark: 'Claude Sonnet 4.5',
    selectedRow: 'Claude Sonnet 4.5 · ',
    belowFloor: 'renders',
    setup: setupWith({ models: true, seedModel: true }),
    open: typeLineAndWait('/models', 'Claude Sonnet 4.5'),
  },
  {
    name: 'effort-picker',
    title: 'The /effort picker',
    exitKey: 'Esc',
    landmark: 'Reasoning effort',
    selectedRow: 'on · ',
    belowFloor: 'renders',
    setup: setupWith({ effort: true }),
    open: typeLineAndWait('/effort', 'Reasoning effort'),
  },
  {
    name: 'sheet-permissions',
    title: 'The docked /permissions sheet',
    exitKey: 'Esc',
    landmark: 'Permissions · ask mode',
    selectedRow: 'npm, 1 argument',
    setup: setupWith({ permissions: CHAT_PERMISSIONS }),
    open: typeLineAndWait('/permissions', 'Permissions · ask mode'),
  },
  {
    name: 'sheet-agent',
    title: 'The docked /agent sheet',
    exitKey: 'Esc',
    landmark: 'Agent · relavium-chat',
    setup: setupWith({
      boundAgent: () =>
        boundAgentView(buildDefaultChatAgent('claude-opus-4-8', 'high', 'anthropic'), 'high'),
    }),
    open: typeLineAndWait('/agent', 'Agent · relavium-chat'),
  },
  {
    name: 'mode-prompt',
    title: 'The /mode flow’s native card (the startup default)',
    exitKey: 'Esc',
    landmark: 'Choose a global startup default',
    viewport: {
      // The stand-alone chat's card takes the whole screen; the Home's chat keeps its prompt under the card (and says "too small" below the floor).
      'standalone-chat': false,
      chat: (variant) => variant.renderer === 'alt' && !isBelowFloor(variant),
    },
    setup: { nativePrompt: true },
    open: async (m) => {
      openModeFlow(m);
      await m.until(() => m.text().includes('Choose a global startup default'));
    },
  },
  {
    name: 'approval-file-edit',
    title: 'The approval card of a file edit (with its diff)',
    exitKey: 'Esc',
    landmark: 'Esc stops the turn',
    open: async (m) => {
      askFileEdit(m);
      await m.until(() => m.text().includes('Esc stops the turn'));
    },
  },
  {
    name: 'approval-command',
    title: 'The approval card of a command',
    exitKey: 'Esc',
    landmark: 'Standing:',
    open: async (m) => {
      m.store
        .requestApproval(
          COMMAND_REQUEST,
          COMMAND_FACTS.offers.session,
          undefined,
          { callId: 'call-2', preview: COMMAND_PREVIEW },
          COMMAND_FACTS,
        )
        .catch(() => undefined);
      await m.until(() => m.text().includes('Standing:'));
    },
  },
  {
    name: 'question-card',
    title: 'The agent’s question card (ask_user)',
    exitKey: 'Esc',
    landmark: 'Which file should I change?',
    selectedRow: 'alpha.ts',
    open: async (m) => {
      m.store.requestQuestion(QUESTION).catch(() => undefined);
      await m.until(() => m.text().includes('Which file should I change?'));
    },
  },
  {
    name: 'continue-checkpoint',
    title: 'The continue checkpoint card',
    exitKey: 'Esc',
    landmark: 'Continue for 32 more?',
    open: async (m) => {
      m.store.requestCheckpoint({ rounds: 32, interval: 32 }).catch(() => undefined);
      await m.until(() => m.text().includes('Continue for 32 more?'));
    },
  },
  {
    name: 'full-view',
    viewport: false,
    title: 'The approval card’s full view ([v])',
    exitKey: 'Esc',
    landmark: 'Review · tool edit_file',
    open: async (m) => {
      askFileEdit(m);
      await m.until(() => m.text().includes('[v]'));
      await m.settle();
      m.key('v');
      await m.until(() => m.store.getSnapshot().review?.screen !== 'card');
    },
  },
  {
    name: 'details-list',
    viewport: false,
    title: 'The /details list of the tool calls',
    exitKey: 'Esc',
    landmark: 'edit_file',
    selectedRow: 'src/app.ts',
    open: async (m) => {
      finishToolCall(m);
      m.store.openDetails();
      await m.until(() => m.store.getSnapshot().review?.screen === 'list');
    },
  },
  {
    name: 'details-view',
    viewport: false,
    title: 'One tool call in the details view (Enter on the list)',
    exitKey: 'Esc',
    landmark: 'Edited src/app.ts',
    open: async (m) => {
      finishToolCall(m);
      m.store.openDetails();
      await m.until(() => m.store.getSnapshot().review?.screen === 'list');
      await m.settle();
      m.key(KEYS.enter);
      await m.until(() => m.store.getSnapshot().review?.screen === 'full');
    },
  },
  {
    name: 'mention',
    belowFloor: 'renders',
    title: 'The @-mention file completion',
    exitKey: 'Esc',
    landmark: 'README.md',
    selectedRow: 'src/',
    setup: setupWith({ mentionReader: MENTION_READER }),
    open: async (m) => {
      m.key('@');
      await m.until(() => m.text().includes('README.md'));
    },
  },
  {
    name: 'reverse-search',
    belowFloor: 'renders',
    title: 'The Ctrl+R reverse search of the input history',
    exitKey: 'Esc',
    landmark: /search|Search/u,
    open: async (m) => {
      m.key(KEYS.ctrlR);
      await m.until(() => /search|Search/u.test(m.text()));
    },
  },
  {
    name: 'running-turn',
    title: 'A running turn: the streamed answer and the live line',
    exitKey: 'Esc',
    landmark: 'streaming answer',
    belowFloor: 'renders',
    open: async (m) => {
      m.store.apply({
        type: 'session:turn_started',
        sessionId: 'matrix-session',
        sequenceNumber: 1,
        timestamp: '2026-11-24T00:00:00.000Z',
      });
      m.store.apply({
        type: 'agent:token',
        sessionId: 'matrix-session',
        sequenceNumber: 2,
        timestamp: '2026-11-24T00:00:01.000Z',
        nodeId: 'relavium-chat',
        token: 'a streaming answer in progress',
        model: MODEL,
      });
      m.store.tick();
      await m.until(() => m.text().includes('streaming answer'));
    },
  },
  {
    name: 'reasoning-panel',
    belowFloor: 'renders',
    title: 'The expanded reasoning ("thinking") panel of a running turn',
    exitKey: 'Esc',
    landmark: 'let me think',
    open: async (m) => {
      m.store.apply({
        type: 'session:turn_started',
        sessionId: 'matrix-session',
        sequenceNumber: 1,
        timestamp: '2026-11-24T00:00:00.000Z',
      });
      m.store.apply({
        type: 'agent:reasoning',
        sessionId: 'matrix-session',
        sequenceNumber: 2,
        timestamp: '2026-11-24T00:00:01.000Z',
        nodeId: 'relavium-chat',
        text: 'let me think about the files',
        model: MODEL,
      });
      m.store.tick();
      m.store.toggleReasoning();
      await m.until(() => m.text().includes('let me think'));
    },
  },
]);
