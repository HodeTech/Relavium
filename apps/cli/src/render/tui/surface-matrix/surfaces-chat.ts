import type { AskUserRequest, ToolApprovalRequest, ToolPreview } from '@relavium/core';

import type { CommandCardFacts } from '../../../chat/command-facts.js';
import { editedFilePreview } from '../fixtures/edit-diff.js';
import type { MentionReader } from '../mention.js';
import type { ChatMount, ChatSetup } from './chat-host.js';
import { openModeFlow } from './home-flows.js';
import { KEYS } from './home-host.js';
import {
  FULL_SCREEN_CHAT_FILLS_THE_TERMINAL,
  HOSTED_CHAT_PALETTE_OVERFLOWS_INLINE,
  STANDALONE_CHAT_PALETTE_FILLS_INLINE,
} from './known-failures.js';
import type { KnownFailure, SurfaceBase } from './registry.js';
import { PALETTE_LEGEND_ROW } from './palette-legend.js';
import {
  recordBaseline,
  TEST_POPUP_LEGEND_ROW,
  TEST_POPUP_TITLE,
  testPopupBox,
  testReportPopup,
} from './popup-fixture.js';
import {
  DOCTOR_LANDMARKS,
  DOCTOR_LEGEND_ROW,
  doctorPopupBox,
  doctorPortFor,
  driveDoctor,
} from './doctor-fixture.js';
import {
  driveReport,
  REPORT_LANDMARKS,
  reportPopupBox,
  reportsPortFor,
  type ReportState,
} from './report-fixture.js';
import { chatExportSurface } from './export-fixture.js';
import {
  driveSettings,
  settingsPopupBox,
  settingsPortFor,
  SETTINGS_LANDMARKS,
  SETTINGS_LEGEND_ROW,
  type SettingsState,
} from './settings-fixture.js';
import {
  driveModels,
  homeModelsPort,
  MODELS_CURRENT,
  MODELS_LANDMARKS,
  MODELS_SELECTED_ROW,
  modelsPopupBox,
  modelsSettingsPortFor,
  type ModelsState,
} from './models-fixture.js';
import {
  drivePermissions,
  PERMISSIONS_LANDMARKS,
  PERMISSIONS_LEGEND_ROW,
  permissionsSettingsPortFor,
  type PermissionsState,
} from './permissions-fixture.js';
import type { ChatSurface } from './surface-types.js';
import type { SessionViewSeed } from '../session-view-model.js';
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
        legendRow: definition.legendRow,
        belowFloor: definition.belowFloor,
        variants: definition.variants,
        knownFailure: [
          ...viewportFailure(definition.viewport, host),
          ...asList(definition.knownFailure?.[host]),
        ],
        notes: definition.notes,
        popup: definition.popup,
        setup: definition.setup,
        open: definition.open,
      }),
    ),
  );
}

const MODEL = 'claude-sonnet-4-5';

/** The session ports of one chat surface, given once and placed where each host takes them. */
interface Ports {
  readonly mentionReader?: MentionReader;
}

function setupWith(ports: Ports): ChatSetup {
  return {
    standalone: {
      ...(ports.mentionReader === undefined ? {} : { mentionReader: ports.mentionReader }),
    },
    hosted: {
      session: {
        ...(ports.mentionReader === undefined ? {} : { mentionReader: ports.mentionReader }),
      },
    },
  };
}

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

/**
 * A conversation long enough to fill the full-screen transcript: the palette is opened over it, as a person opens it in a chat that has a
 * history. With an empty transcript the palette has the room it asks for and a layout that squeezes it (a list region that may shrink) never
 * shows; over a full one, the palette is merged into the rows around it, and the legend row is the first to go.
 */
const LONG_CONVERSATION: SessionViewSeed = {
  transcript: Array.from({ length: 40 }, (_, turn) => [
    { role: 'user' as const, text: `question ${String(turn)} about the thing` },
    {
      role: 'assistant' as const,
      text: `answer ${String(turn)} with a longer sentence so that it wraps over the width of the terminal once or twice, maybe more`,
    },
  ]).flat(),
};

/**
 * The body a popup is opened over in the richest chat cell of the backdrop check ([ADR-0148](../../../../../../docs/decisions/0148-a-user-started-report-setting-or-flow-is-a-centred-popup.md)
 * §4): your own turn, an answer in markdown that holds a heading, strong text, an inline code span, a quote, a list, a table
 * and a fenced block, a tool-call row, and a draft in the prompt, so bold (strong text, the heading), inverse (the prompt's cursor), coloured, underlined and dimmed spans
 * are all under the popup and every one of them has to be dim. No wide character: the check reads columns, and a row it cannot read soundly is a
 * failure of its own.
 */
const RICH_MARKDOWN = [
  '# The plan',
  '',
  'Here is **strong text**, `inline code`, *emphasis* and a [link](https://example.com/docs).',
  '',
  '> a quoted line of the answer',
  '',
  '- first item',
  '- second item with `code`',
  '',
  '| name | value |',
  '| ---- | ----- |',
  '| alpha | 1 |',
  '| bravo | 2 |',
  '',
  '```ts',
  'const answer = 42;',
  '```',
].join('\n');

const SHORT_CONVERSATION: SessionViewSeed = {
  model: MODEL,
  transcript: [
    { role: 'user', text: 'hello' },
    { role: 'assistant', text: 'Hi, this is **bold**.' },
  ],
};

const RICH_CONVERSATION: SessionViewSeed = {
  model: MODEL,
  transcript: [
    { role: 'user', text: 'show me the plan for the migration' },
    {
      role: 'tools',
      text: '',
      calls: [
        { id: 'call-1', toolId: 'read_file', resolved: true, success: true, outcome: 'success' },
      ],
    },
    { role: 'assistant', text: RICH_MARKDOWN },
    { role: 'user', text: 'and what about the second step' },
    { role: 'assistant', text: 'The **second step** moves the data; see `migrate.ts`.' },
  ],
};

/** A chat's `/doctor` popup in one state: the short exchange behind it, the command typed into the chat and routed by its host. */
function chatDoctorSurface(
  state: 'checks' | 'line' | 'done',
  title: string,
): ChatSurfaceDefinition {
  return {
    name: `doctor-${state}`,
    title,
    exitKey: 'Esc',
    landmark: DOCTOR_LANDMARKS[state],
    ...(DOCTOR_LEGEND_ROW[state] === undefined ? {} : { legendRow: DOCTOR_LEGEND_ROW[state] }),
    ...(state === 'checks' ? { selectedRow: 'OS keychain' } : {}),
    belowFloor: /too small for this popup/iu,
    popup: doctorPopupBox,
    setup: () => ({
      seed: SHORT_CONVERSATION,
      doctor: doctorPortFor('standalone-chat', 'keyed'),
    }),
    notes:
      'the body behind the popup: one short exchange (a strong word in the answer) and the prompt; the popup is opened by typing /doctor, through the chat host’s routing',
    open: async (m) => {
      recordBaseline(m);
      await driveDoctor(m, () => m.typeLine('/doctor'), state);
    },
  };
}

/**
 * The legend row of a report popup's report state, whole on one row of every cell (ADR-0148 §1: every report offers `[c] copy`, and the copy is
 * the control the legend keeps longest; `↑/↓ scroll` is named only where the report overflows its page, which `help` does and the others do not). The states that are not a report (loading, a failure, the release line and its result) name no copy.
 */
const REPORT_LEGEND_ROW: Readonly<Partial<Record<ReportState, string | readonly string[]>>> = {
  // `/agent` fits its page in the alternate screen and overflows the inline form's shorter one, so it may draw either.
  agent: ['[c] copy · Esc close', '↑/↓ scroll · [c] copy · Esc close'],
  cost: '[c] copy · Esc close',
  'cost-held': '[r] release held estimates · [c] copy · Esc close',
  workflows: '[c] copy · Esc close',
  help: '↑/↓ scroll · [c] copy · Esc close',
};

/** A chat's report popup (`/agent`, `/cost`, `/workflows`, `/help`) in one state: the short exchange behind it, the command typed and routed by the host. */
function chatReportSurface(state: ReportState, title: string): ChatSurfaceDefinition {
  return {
    name: `report-${state}`,
    title,
    exitKey: 'Esc',
    landmark: REPORT_LANDMARKS[state],
    ...(REPORT_LEGEND_ROW[state] === undefined ? {} : { legendRow: REPORT_LEGEND_ROW[state] }),
    belowFloor: /too small for this popup/iu,
    popup: reportPopupBox,
    setup: () => ({
      seed: SHORT_CONVERSATION,
      reports: reportsPortFor('standalone-chat', state),
    }),
    notes:
      'the body behind the popup: one short exchange (a strong word in the answer) and the prompt; the popup is opened by typing the command, through the chat host’s routing',
    open: async (m) => {
      recordBaseline(m);
      await driveReport(m, (line) => m.typeLine(line), state);
    },
  };
}

/** The legend row of each `/models` step, whole on one row of every cell. */
const MODELS_LEGEND_ROW: Readonly<Record<ModelsState, string>> = {
  list: '↑/↓ select · Enter next · Esc close',
  form: '←/→ effort · ↑/↓ scope · Enter apply · [Ctrl+C] close · Esc back',
};

/**
 * A chat's `/models` popup on one step: the short exchange behind it (the chat bound to the model in force), `/models` typed and routed by the
 * host. The stand-alone chat's member is the session's half with the chat's switch bound (`onReseat`); the chat the Home hosts gets its member
 * from the controller over the Home's catalog port (a reseat builder and the session's tier setter wired, as `driveHome` wires them).
 */
function chatModelsSurface(state: ModelsState, title: string): ChatSurfaceDefinition {
  return {
    name: state === 'list' ? 'settings-models' : 'settings-models-apply',
    title,
    exitKey: 'Esc',
    landmark: MODELS_LANDMARKS[state],
    legendRow: MODELS_LEGEND_ROW[state],
    ...(state === 'list' ? { selectedRow: MODELS_SELECTED_ROW } : {}),
    belowFloor: /too small for this popup/iu,
    popup: modelsPopupBox,
    setup: () => ({
      seed: { ...SHORT_CONVERSATION, model: MODELS_CURRENT },
      settings: modelsSettingsPortFor(),
      standalone: { onReseat: () => {}, onSetEffort: () => {} },
      hosted: { models: homeModelsPort, session: { onSetEffort: () => {} } },
    }),
    notes:
      'the body behind the popup: one short exchange (a strong word in the answer) and the prompt; the popup is opened by typing /models, through the chat host’s routing',
    open: async (m) => {
      recordBaseline(m);
      await driveModels(m, (line) => m.typeLine(line), state);
    },
  };
}

/** The row each settings surface opens highlighted on (the tier in force; the effect list's `auto`); the form has no highlighted row. */
const SETTINGS_SELECTED_ROW: Readonly<Partial<Record<SettingsState, string>>> = {
  effort: 'medium',
  effect: 'auto',
  // `/mode`'s first step opens on the mode in force, `ask` (its row's own words: `ask` alone is also the status line's); its second is a form.
  mode: 'every action asks first · current',
};

/**
 * A chat's settings popup in one state: the short exchange behind it, and `/effort` typed and routed by the host (the product popup), or a popup
 * of the test layer with a body the settings popups use (a form; a list whose rows state their effect) opened on the host's popup host.
 */
function chatSettingsSurface(state: SettingsState, title: string): ChatSurfaceDefinition {
  const selected = SETTINGS_SELECTED_ROW[state];
  return {
    name: `settings-${state}`,
    title,
    exitKey: 'Esc',
    landmark: SETTINGS_LANDMARKS[state],
    legendRow: SETTINGS_LEGEND_ROW[state],
    ...(selected === undefined ? {} : { selectedRow: selected }),
    belowFloor: /too small for this popup/iu,
    popup: settingsPopupBox,
    setup: () => ({
      seed: SHORT_CONVERSATION,
      settings: settingsPortFor('standalone-chat'),
    }),
    notes:
      state === 'effort'
        ? 'the body behind the popup: one short exchange (a strong word in the answer) and the prompt; the popup is opened by typing /effort, through the chat host’s routing'
        : state === 'mode' || state === 'mode-apply'
          ? 'the body behind the popup: one short exchange (a strong word in the answer) and the prompt; the popup is opened by typing /mode, through the chat host’s routing (its second step: auto chosen, Enter)'
          : 'the body behind the popup: one short exchange (a strong word in the answer) and the prompt; the test layer opens the popup on the host’s popup host',
    open: async (m) => {
      recordBaseline(m);
      await driveSettings(m, (line) => m.typeLine(line), state, 'chat');
    },
  };
}

/**
 * The chat's `/permissions` popup in one state (ADR-0137 §2 as a popup): the short exchange behind it and `/permissions` typed and routed by
 * the host; its lists (the first row highlighted), the withdrawal's line `[d]` armed, or nothing to withdraw.
 */
function chatPermissionsSurface(state: PermissionsState, title: string): ChatSurfaceDefinition {
  return {
    name: `permissions-${state}`,
    title,
    exitKey: 'Esc',
    landmark: PERMISSIONS_LANDMARKS[state],
    legendRow: PERMISSIONS_LEGEND_ROW[state],
    ...(state === 'list' ? { selectedRow: 'npm, 1 argument' } : {}),
    belowFloor: /too small for this popup/iu,
    popup: settingsPopupBox,
    setup: () => ({
      seed: SHORT_CONVERSATION,
      settings: permissionsSettingsPortFor('standalone-chat', state),
    }),
    notes:
      state === 'armed'
        ? 'the body behind the popup: one short exchange and the prompt; the popup is opened by typing /permissions through the chat host’s routing, then [d] after its settle'
        : 'the body behind the popup: one short exchange and the prompt; the popup is opened by typing /permissions, through the chat host’s routing',
    open: async (m) => {
      recordBaseline(m);
      await drivePermissions(m, (line) => m.typeLine(line), state);
    },
  };
}

export const CHAT_SURFACES: readonly ChatSurface[] = chatSurfaces([
  chatDoctorSurface('checks', 'The /doctor popup over the chat: the quick tier’s checks'),
  chatDoctorSurface('line', 'The /doctor popup over the chat: the deep tier’s confirmation line'),
  chatDoctorSurface('done', 'The /doctor popup over the chat: the deep result with MCP rows'),
  chatReportSurface('agent', 'The /agent popup over the chat: the bound agent’s fields'),
  chatReportSurface('cost', 'The /cost popup over the chat: the report with nothing held'),
  chatReportSurface(
    'cost-held',
    'The /cost popup over the chat: a held estimate and the release control',
  ),
  chatReportSurface(
    'cost-release',
    'The /cost popup over the chat: the release’s confirmation line (a typed --release)',
  ),
  chatReportSurface('cost-done', 'The /cost popup over the chat: the release’s result'),
  chatReportSurface('cost-loading', 'The /cost popup over the chat: the session cost being read'),
  chatReportSurface(
    'cost-error',
    'The /cost popup over the chat: the session cost could not be read',
  ),
  chatReportSurface('workflows', 'The /workflows popup over the chat: the project’s catalog'),
  chatReportSurface('workflows-empty', 'The /workflows popup over the chat: an empty project'),
  chatReportSurface(
    'workflows-loading',
    'The /workflows popup over the chat: the catalog being read',
  ),
  chatReportSurface(
    'workflows-error',
    'The /workflows popup over the chat: the catalog could not be listed',
  ),
  chatReportSurface('help', 'The /help popup over the chat: its commands and keys'),
  chatExportSurface(SHORT_CONVERSATION),
  chatSettingsSurface('effort', 'The /effort popup over the chat: the tiers of the bound model'),
  chatSettingsSurface(
    'form',
    'A form popup over the chat (the test layer’s): tabs, a radio group and a warning',
  ),
  chatSettingsSurface(
    'effect',
    'A list popup over the chat (the test layer’s) whose highlighted row states its effect',
  ),
  chatSettingsSurface(
    'mode',
    'The /mode popup over the chat: the modes, the one in force marked, its effect stated',
  ),
  chatSettingsSurface(
    'mode-apply',
    'The /mode popup over the chat: where auto applies, its effect stated before Enter',
  ),
  {
    name: 'popup',
    title: 'A popup over the chat (the test layer’s report popup)',
    exitKey: 'Esc',
    landmark: TEST_POPUP_TITLE,
    selectedRow: 'alpha check',
    legendRow: TEST_POPUP_LEGEND_ROW,
    belowFloor: /too small for this popup/iu,
    popup: testPopupBox('chat'),
    // The body is one short exchange with a strong word in it: a chat with an empty transcript has no bold at all, and the backdrop check
    // refuses a body it could pass on without a bold, an inverse and a coloured cell.
    setup: { seed: SHORT_CONVERSATION },
    notes:
      'the body behind the popup: one short exchange (a strong word in the answer) and the prompt with its cursor',
    open: async (m) => {
      recordBaseline(m);
      m.popups.openForUser(testReportPopup('chat'));
      await m.until(() => m.text().includes(TEST_POPUP_TITLE));
    },
  },
  {
    name: 'popup-rich',
    title: 'A popup over a chat with markdown, a tool row and a draft in the prompt',
    exitKey: 'Esc',
    landmark: TEST_POPUP_TITLE,
    selectedRow: 'alpha check',
    belowFloor: /too small for this popup/iu,
    popup: testPopupBox('chat'),
    setup: { seed: RICH_CONVERSATION },
    notes:
      'the body behind the popup: a user turn, a tool row, a markdown answer (heading, strong, code, quote, list, table, fenced block) and a draft in the prompt (the cursor is its inverse cell)',
    open: async (m) => {
      m.key('a draft in the prompt');
      await m.until(() => m.text().includes('a draft in the prompt'));
      recordBaseline(m);
      m.popups.openForUser(testReportPopup('chat'));
      await m.until(() => m.text().includes(TEST_POPUP_TITLE));
    },
  },
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
    legendRow: PALETTE_LEGEND_ROW,
    selectedRow: '/models  ',
    belowFloor: 'renders',
    setup: { seed: LONG_CONVERSATION },
    knownFailure: {
      chat: HOSTED_CHAT_PALETTE_OVERFLOWS_INLINE,
      'standalone-chat': STANDALONE_CHAT_PALETTE_FILLS_INLINE,
    },
    open: async (m) => {
      m.key('/');
      await m.until(() => m.text().includes('Enter run'));
    },
  },
  chatModelsSurface('list', 'The /models popup over the chat: the catalog, the bound model marked'),
  chatModelsSurface(
    'form',
    'The /models popup’s second step over the chat: the effort, where it applies, where the conversation goes',
  ),
  chatPermissionsSurface(
    'list',
    'The /permissions popup over the chat: the remembered commands and the session’s approvals',
  ),
  chatPermissionsSurface(
    'armed',
    'The /permissions popup over the chat: a withdrawal’s line, answered by Enter',
  ),
  chatPermissionsSurface(
    'empty',
    'The /permissions popup over the chat: nothing remembered and nothing approved',
  ),
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
