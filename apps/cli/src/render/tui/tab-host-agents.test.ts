/**
 * The `/agents` strip of the Home's tab host ([ADR-0140](../../../../../docs/decisions/0140-management-browsers-the-run-drill-down-and-the-durable-run-detail.md)
 * §3 and its 2026-11-23 note, MVP-8 step 5): its own two-tab strip, Defined and Sessions, on the tab host's one model. A pure model test: no
 * ink, no controller, no project or database; the agents and the sessions are values the test hands in through the two ports the tabs read.
 *
 * Every key a legend names is pressed here and does what the legend says, on the list and on the detail page; and the strip's keys are shown
 * not to collide with the workflows strip's (a bare letter of that strip does nothing here, and no key leaves the strip).
 */
import type { AgentDefinition } from '@relavium/core';
import { describe, expect, it, vi } from 'vitest';

import {
  AGENT_PROMPT_HEAD_CHARS,
  AGENT_TOOLS_MAX,
  buildAgentsModel,
  type AgentFields,
  type AgentsModelItem,
} from '../../history/agents-model.js';
import type { AgentsPort } from '../../home/agents-port.js';
import type { ChatKey } from './chat-input.js';
import { usableColumns } from './sheet-frame.js';
import {
  AGENT_TABS,
  TABS,
  TAB_HOST_ROWS,
  TAB_HOST_TOO_SMALL,
  enterTab,
  foldTabHostKey,
  freshTabMemory,
  tabHostLegend,
  tabHostLegendText,
  tabHostLines,
  tabHostMemory,
  type TabHostContext,
  type TabHostState,
  type TabHostStep,
  type TabId,
} from './tab-host.js';
import {
  AGENTS_EMPTY,
  AGENTS_KEYS,
  AGENTS_UNREADABLE,
  AGENT_DETAIL_ROWS,
} from './tab-host-agents.js';
import { SESSIONS_KEYS, type SessionsPort, type SessionRow } from './tab-host-sessions.js';
import { displayWidth } from './viewport.js';

const UP: ChatKey = { upArrow: true };
const DOWN: ChatKey = { downArrow: true };
const LEFT: ChatKey = { leftArrow: true };
const RIGHT: ChatKey = { rightArrow: true };
const ENTER: ChatKey = { return: true };
const ESC: ChatKey = { escape: true };
const BACKSPACE: ChatKey = { backspace: true };
const TAB: ChatKey = { tab: true };
const SHIFT_TAB: ChatKey = { tab: true, shift: true };

// A key-shaped string, built from parts so no literal credential sits in the source.
const KEY = `sk-${'A1b2C3d4E5'.repeat(3)}`;
const MASK = '[REDACTED]';

const fields = (over: Partial<AgentFields> = {}): AgentFields => ({
  model: 'claude-sonnet-4-6',
  provider: 'anthropic',
  system_prompt: 'You review code.',
  ...over,
});

const ready = (
  slug: string,
  over: Partial<AgentFields> = {},
  name: string | undefined = `Agent ${slug}`,
): AgentsModelItem => ({
  entry: { slug, name, path: `.relavium/agents/${slug}.agent.yaml`, valid: true },
  agent: fields(over),
});

/** The whole definition the catalog would hold for an item: what the page was drawn from. */
const definitionOf = (item: AgentsModelItem): AgentDefinition | undefined =>
  item.agent === undefined ? undefined : { id: item.entry.slug, ...item.agent };

const invalid = (slug: string, error: string): AgentsModelItem => ({
  entry: {
    slug,
    name: undefined,
    path: `.relavium/agents/${slug}.agent.yaml`,
    valid: false,
    error,
  },
  agent: undefined,
});

const ITEMS: readonly AgentsModelItem[] = [
  ready('reviewer', {
    tools: ['read_file', 'grep'],
    temperature: 0.3,
    reasoning_effort: 'high',
    model: 'claude-opus-4-8',
    system_prompt: `You review code. The deploy key is ${KEY}, never repeat it.`,
  }),
  invalid('broken-one', 'unknown key "bogus" at the top level'),
  ready('writer', { provider: 'openai', model: 'gpt-5' }),
];

const sessionRow = (id: string, title: string, over: Partial<SessionRow> = {}): SessionRow => ({
  id,
  title,
  agent: 'coder',
  age: '5m ago',
  ...over,
});

const SESSIONS = [
  sessionRow('sess-aaa', 'Fix the flaky test'),
  sessionRow('sess-bbb', 'Untitled', { agent: 'writer', age: '2h ago' }),
];

/** An agents port over items the test can change; it counts its reads. */
function agentsPortOver(items: readonly AgentsModelItem[]) {
  let current = items;
  const reads = vi.fn();
  const port: AgentsPort = {
    read: () => {
      reads();
      const listed = current;
      return {
        model: buildAgentsModel(listed),
        slugOf: (index) => listed[index]?.entry.slug,
        pathOf: (index) => listed[index]?.entry.path,
        definitionOf: (index) => {
          const item = listed[index];
          return item === undefined ? undefined : definitionOf(item);
        },
      };
    },
  };
  return {
    port,
    reads,
    set: (next: readonly AgentsModelItem[]) => {
      current = next;
    },
  };
}

function sessionsPortOver(rows: readonly SessionRow[], more = false) {
  const reads = vi.fn();
  const port: SessionsPort = {
    read: () => {
      reads();
      return { rows, more };
    },
  };
  return { port, reads };
}

interface RigOptions {
  readonly items?: readonly AgentsModelItem[];
  readonly sessions?: readonly SessionRow[];
  readonly more?: boolean;
  readonly agents?: AgentsPort | undefined;
  readonly sessionsPort?: SessionsPort | undefined;
  readonly tab?: TabId;
}

/** The agents strip entered over ports, with the keys going through the tab host's own fold. */
function rig(options: RigOptions = {}) {
  const fakeAgents = agentsPortOver(options.items ?? ITEMS);
  const fakeSessions = sessionsPortOver(options.sessions ?? SESSIONS, options.more ?? false);
  const context = (): TabHostContext => ({
    port: undefined,
    agents: 'agents' in options ? options.agents : fakeAgents.port,
    sessions: 'sessionsPort' in options ? options.sessionsPort : fakeSessions.port,
    now: 10_000,
    canArm: true,
  });
  const tab = options.tab ?? 'agents';
  let state: TabHostState = enterTab(freshTabMemory(tab), tab, context());
  const press = (input: string, key: ChatKey = {}): TabHostStep => {
    const step = foldTabHostKey(state, input, key, context());
    if (step.kind !== 'close') state = step.state;
    return step;
  };
  return {
    press,
    context,
    agentReads: fakeAgents.reads,
    sessionReads: fakeSessions.reads,
    setItems: fakeAgents.set,
    get state(): TabHostState {
      return state;
    },
    set state(next: TabHostState) {
      state = next;
    },
    lines: (columns = 80, rows = 24) =>
      tabHostLines(state, { columns, terminalRows: rows }).map((line) => line.text),
    text: (columns = 80, rows = 24) =>
      tabHostLines(state, { columns, terminalRows: rows })
        .map((line) => line.text)
        .join('\n'),
    legendText: () => tabHostLegendText(state),
  };
}

/** Every key the legend of `state` names, the key that leaves last (a list of keys is one entry). */
const legendKeys = (state: TabHostState): readonly (string | readonly string[])[] => {
  const { items, exit } = tabHostLegend(state);
  return [...items, exit].map((item) => ('keys' in item ? item.keys : item.text));
};

describe('the /agents strip is its own: Defined │ Sessions', () => {
  it('draws two tabs, the current one with a glyph, and none of the workflows strip’s', () => {
    const r = rig();
    expect(r.lines()[0]).toBe('› Defined  │  Sessions');
    expect(AGENT_TABS.map((tab) => tab.title)).toEqual(['Defined', 'Sessions']);
    r.press('', RIGHT);
    expect(r.lines()[0]).toBe('Defined  │  › Sessions');
    for (const word of ['Active', 'History', 'Permissions'])
      expect(r.lines()[0], word).not.toContain(word);
  });

  it('leaves the workflows strip as it was: four tabs, none of them the agents strip’s', () => {
    const r = rig({ tab: 'defined' });
    expect(r.lines()[0]).toBe('› Defined  │  Active  │  History  │  Permissions');
    expect(TABS.map((tab) => tab.id)).toEqual(['defined', 'active', 'history', 'permissions']);
  });

  it('keeps every key inside the strip: ←/→ stop at the ends and Tab goes around, and no key reaches another strip’s tab', () => {
    const r = rig();
    expect(r.state.tab).toBe('agents');
    r.press('', LEFT);
    expect(r.state.tab, '← stops at the first tab').toBe('agents');
    r.press('', RIGHT);
    expect(r.state.tab).toBe('sessions');
    r.press('', RIGHT);
    expect(r.state.tab, '→ stops at the last tab').toBe('sessions');
    r.press('', TAB);
    expect(r.state.tab, 'Tab goes around').toBe('agents');
    r.press('', SHIFT_TAB);
    expect(r.state.tab, 'Shift+Tab goes around the other way').toBe('sessions');
    r.press('', SHIFT_TAB);
    expect(r.state.tab).toBe('agents');
    const seen = new Set<TabId>();
    for (let i = 0; i < 12; i += 1) {
      r.press('', i % 2 === 0 ? TAB : RIGHT);
      seen.add(r.state.tab);
    }
    expect([...seen].sort()).toEqual(['agents', 'sessions']);
  });

  it('answers no bare letter of the workflows strip, on either tab’s list: r x p a f n and c do nothing there (c is the detail’s only letter)', () => {
    const r = rig();
    for (const tab of ['agents', 'sessions'] as const) {
      if (r.state.tab !== tab) r.press('', RIGHT);
      expect(r.state.tab).toBe(tab);
      const before = tabHostMemory(r.state);
      for (const letter of ['r', 'x', 'p', 'a', 'f', 'n', 'c', 'R', 'C']) {
        const step = r.press(letter);
        expect(step.kind, `${letter} on ${tab} asks nothing`).toBe('state');
      }
      expect(tabHostMemory(r.state), `the ${tab} tab stayed where it was`).toEqual(before);
      expect(r.state.agents?.detail, 'no detail opened by a letter').toBeUndefined();
    }
  });

  it('reads a tab again every time it is entered, and keeps the cursor where it was', () => {
    const r = rig();
    r.press('', DOWN);
    r.press('', DOWN);
    expect(r.agentReads).toHaveBeenCalledTimes(1);
    r.press('', RIGHT);
    expect(r.sessionReads).toHaveBeenCalledTimes(1);
    r.press('', LEFT);
    expect(r.agentReads).toHaveBeenCalledTimes(2);
    expect(r.state.agents?.cursor).toBe(2);
    // The catalog shrank while the person was away: the cursor lands on a row that exists.
    r.setItems(ITEMS.slice(0, 1));
    r.press('', RIGHT);
    r.press('', LEFT);
    expect(r.state.agents?.cursor).toBe(0);
    expect(tabHostMemory(r.state).positions.agents).toBe(0);
  });
});

describe('the Defined tab lists the project’s agents, one row per file', () => {
  it('draws a ready agent and an invalid one as two rows, each with a glyph and a word', () => {
    const r = rig();
    const rows = r.lines().slice(2, 5);
    expect(rows[0]).toMatch(/^› reviewer {2}Agent reviewer\s+✓ ready$/u);
    expect(rows[1]).toMatch(/^ {2}broken-one\s+✗ invalid$/u);
    expect(rows[2]).toMatch(/^ {2}writer {2}Agent writer\s+✓ ready$/u);
    expect(r.state.agents?.read.model.rows.map((row) => row.state)).toEqual([
      'ready',
      'invalid',
      'ready',
    ]);
  });

  it('shows the invalid row’s reason when it is selected, and none of its contents; Enter opens no detail and says why', () => {
    const r = rig();
    r.press('', DOWN);
    expect(r.state.agents?.read.model.rows[1]).not.toHaveProperty('detail');
    expect(r.text()).toContain('Cannot open: unknown key "bogus" at the top level');
    expect(r.text(), 'nothing of another agent’s definition is on the page').not.toContain(
      'You review code.',
    );
    expect(r.press('', ENTER).kind).toBe('state');
    expect(r.state.agents?.detail, 'an invalid agent has no detail').toBeUndefined();
    expect(r.text()).toContain(
      'broken-one cannot be opened: unknown key "bogus" at the top level.',
    );
    // The next key drops the sentence.
    r.press('', DOWN);
    expect(r.text()).not.toContain('cannot be opened');
  });

  it('draws a label that looks like a path as text, and opens the page of the row it listed even if the catalog changed since', () => {
    // The tab holds the read it was entered with: a row names its entry by the model's index, and nothing re-resolves it by its label.
    // (The id of a valid agent is kebab-case and an invalid file's is its file stem, so a real label never holds a `/`; the label here
    // is the worst a drawn string can be, and `agents-port.test.ts` owns the real port's `slugOf` and `pathOf`.)
    const r = rig({ items: [ready('../../x'), ready('ok')] });
    expect(r.lines()[2]).toMatch(/^› \.\.\/\.\.\/x {2}Agent \.\.\/\.\.\/x\s+✓ ready$/u);
    expect(r.state.agents?.read.model.rows.map((row) => row.entryIndex)).toEqual([0, 1]);
    r.setItems([ready('other')]); // the catalog changes under the open tab
    r.press('', ENTER);
    expect(r.state.agents?.detail?.slug).toBe('../../x');
    expect(r.lines()[2]).toBe('../../x  Agent ../../x');
  });

  it('says there are no agents, and names no row key, when the catalog is empty', () => {
    const r = rig({ items: [] });
    expect(r.text()).toContain(AGENTS_EMPTY);
    expect(r.legendText()).toBe('←/→ tab · Tab cycle · [Ctrl+C] close · Esc close');
    expect(r.press('', ENTER).kind).toBe('state');
    expect(r.press('', DOWN).kind).toBe('state');
  });

  it('says it cannot list when no port is wired or the port cannot be read, never a crash and never the cause', () => {
    for (const agents of [
      undefined,
      {
        read: () => {
          throw new Error('PRIVATE_FAULT_TEXT');
        },
      } satisfies AgentsPort,
    ]) {
      const r = rig({ agents });
      expect(r.state.unreadable).toBe(true);
      expect(r.state.agents).toBeUndefined();
      expect(r.text()).toContain(AGENTS_UNREADABLE);
      expect(r.text()).not.toContain('PRIVATE_FAULT_TEXT');
      expect(r.legendText()).toBe('←/→ tab · Tab cycle · [Ctrl+C] close · Esc close');
      expect(r.press('', ESC).kind, 'Esc still closes it').toBe('close');
    }
  });
});

describe('the agent detail page is read-only, sanitized, and nothing else', () => {
  it('shows the model, provider, tool grant, temperature and reasoning effort of a ready agent, and the head of its prompt', () => {
    const r = rig();
    expect(r.press('', ENTER).kind).toBe('state');
    const lines = r.lines();
    const page = lines.slice(2, -1).join('\n');
    expect(lines[2]).toBe('reviewer  Agent reviewer');
    expect(page).toMatch(/Model\s+claude-opus-4-8/u);
    expect(page).toMatch(/Provider\s+anthropic/u);
    expect(page).toMatch(/Temperature\s+0\.3/u);
    expect(page).toMatch(/Reasoning effort\s+high/u);
    expect(page).toMatch(/Tools\s+read_file, grep/u);
    expect(page).toContain('System prompt');
    expect(page).toContain('You review code. The deploy key is');
    // Nothing else of the file: not its path, and no key that is not on the legend.
    expect(page).not.toContain('.relavium/agents');
    expect(page).not.toContain('agent.yaml');
  });

  it('masks a key-shaped string in the prompt: the head is scrubbed, whole, before it is cut', () => {
    const r = rig();
    r.press('', ENTER);
    const text = r.text();
    expect(text).not.toContain(KEY);
    expect(text).not.toContain(KEY.slice(0, 12));
    expect(text).toContain(MASK);
  });

  it('says `not set` for a temperature and an effort the definition does not set, and `none declared` for no tools', () => {
    const r = rig();
    r.press('', DOWN);
    r.press('', DOWN); // writer: no temperature, no effort, no tools
    r.press('', ENTER);
    const page = r.lines().slice(2, -1).join('\n');
    expect(page).toMatch(/Temperature\s+not set/u);
    expect(page).toMatch(/Reasoning effort\s+not set/u);
    expect(page).toMatch(/Tools\s+none declared/u);
    expect(page).toMatch(/Provider\s+openai/u);
  });

  it('bounds the tool grant: the names the model keeps, then how many it left out', () => {
    const tools = Array.from(
      { length: AGENT_TOOLS_MAX + 6 },
      (_, index) => `tool_${String(index).padStart(2, '0')}`,
    );
    const r = rig({ items: [ready('many', { tools })] });
    r.press('', ENTER);
    const page = r.lines().slice(2, -1).join('\n');
    expect(page).toContain('tool_00');
    expect(page).not.toContain(`tool_${String(AGENT_TOOLS_MAX + 1)}`);
    // The grant takes three lines at most; the cut says so.
    const toolLines = r.lines().filter((line) => /tool_\d\d/u.test(line));
    expect(toolLines.length).toBeLessThanOrEqual(3);
    expect(toolLines.at(-1)).toMatch(/…$/u);
  });

  it('cuts a head longer than the model keeps with an ellipsis, and draws no more than the page’s rows', () => {
    const r = rig({ items: [ready('long', { system_prompt: 'word '.repeat(400) })] });
    r.press('', ENTER);
    const lines = r.lines();
    const prompt = lines.slice(lines.indexOf('System prompt (the first characters)') + 1, -1);
    expect(prompt.join(' ').replace(/\s+/gu, ' ').trim().length).toBeLessThanOrEqual(
      AGENT_PROMPT_HEAD_CHARS + 2,
    );
    expect(prompt.join('')).toContain('…');
    expect(
      lines.length - 3,
      'the page, without the strip, the rule and the legend',
    ).toBeLessThanOrEqual(AGENT_DETAIL_ROWS);
  });

  it('is a page of its own: the list is not drawn behind it', () => {
    const r = rig();
    r.press('', ENTER);
    expect(r.text()).not.toContain('✓ ready');
    expect(r.text()).not.toContain('broken-one');
  });
});

describe('the legends name exactly the keys each page answers to, and every one is pressed', () => {
  it('Defined list: select and open with the tab keys and Esc last, each doing what it says', () => {
    const r = rig();
    expect(legendKeys(r.state)).toEqual(['←/→', 'Tab', '↑/↓', 'Enter', 'Ctrl+C', 'Esc']);
    expect(r.legendText()).toBe(
      '←/→ tab · Tab cycle · ↑/↓ select · Enter open · [Ctrl+C] close · Esc close',
    );
    expect(AGENTS_KEYS.select.keys).toBe('↑/↓');
    expect(AGENTS_KEYS.open.keys).toBe('Enter');
    // ↑/↓ select, and stop at the ends.
    r.press('', DOWN);
    expect(r.state.agents?.cursor).toBe(1);
    r.press('', DOWN);
    r.press('', DOWN);
    expect(r.state.agents?.cursor, '↓ stops at the last row').toBe(2);
    r.press('', UP);
    r.press('', UP);
    r.press('', UP);
    expect(r.state.agents?.cursor, '↑ stops at the first row').toBe(0);
    // Enter opens the detail.
    r.press('', ENTER);
    expect(r.state.agents?.detail?.slug).toBe('reviewer');
    // Tab and ←/→ move between the strip’s tabs, and Esc closes.
    r.press('', BACKSPACE); // back to the list
    r.press('', RIGHT);
    expect(r.state.tab).toBe('sessions');
    r.press('', TAB);
    expect(r.state.tab).toBe('agents');
    expect(r.press('', ESC).kind, 'Esc on the list closes the screen').toBe('close');
  });

  it('Defined detail: the tab keys, [c] chat and Esc back; the list’s legend names no `c`', () => {
    const r = rig();
    // The list names no chat key: the chat is started from an agent's page, which is where its tool grant is read.
    for (const keys of legendKeys(r.state)) expect(keys, 'the list').not.toBe('c');
    expect(r.legendText()).not.toContain('chat');
    r.press('', ENTER);
    expect(legendKeys(r.state)).toEqual(['←/→', 'Tab', 'c', 'Ctrl+C', 'Esc']);
    expect(r.legendText()).toBe('←/→ tab · Tab cycle · [c] chat · [Ctrl+C] close · Esc back');
    expect(AGENTS_KEYS.chat).toEqual({ keys: 'c', verb: 'chat' });
    // the way back is the detail's own `Esc`: one level, the Step class
    expect(tabHostLegend(r.state).exit).toBe(AGENTS_KEYS.back);
    expect(AGENTS_KEYS.back.class).toBe('step');
    // Esc backs out to the list on the row it came from, and a second Esc closes the screen.
    expect(r.press('', ESC).kind).toBe('state');
    expect(r.state.agents?.detail).toBeUndefined();
    expect(r.state.agents?.cursor).toBe(0);
    expect(r.press('', ESC).kind).toBe('close');
  });

  it('`c` on a detail asks the host to start a chat bound to that agent, by the catalog’s own path and never by a label; `C` is the same key', () => {
    // The listed file is NOT named after the agent's id, and the id looks like a path: neither is what the request carries.
    const item: AgentsModelItem = {
      entry: {
        slug: '../../x',
        name: 'Agent x',
        path: '.relavium/agents/a-file-of-another-name.agent.yaml',
        valid: true,
      },
      agent: fields({ tools: ['read_file'] }),
    };
    const items = [item];
    for (const letter of ['c', 'C']) {
      const r = rig({ items });
      r.press('', ENTER);
      expect(r.state.agents?.detail?.slug).toBe('../../x');
      const step = r.press(letter);
      expect(step.kind, `${letter} asks for a chat`).toBe('chat');
      expect(step.kind === 'chat' ? step.agent : undefined).toEqual({
        path: '.relavium/agents/a-file-of-another-name.agent.yaml',
        // The definition the page was drawn from rides with the request, so the host can tell whether the file is still it.
        listed: definitionOf(item),
      });
      // The tab is carried with the request exactly as the key left it: the detail is still the agent that was asked about.
      expect(step.kind === 'chat' ? step.state.agents?.detail?.slug : undefined).toBe('../../x');
    }
  });

  it('`c` is the detail’s key only: Ctrl+C closes (it is not a chat), Meta+C is nothing, and the list, an invalid agent and Sessions have no `c`', () => {
    const r = rig();
    r.press('', ENTER);
    expect(r.press('c', { ctrl: true }).kind, 'Ctrl+C closes the screen').toBe('close');
    expect(r.press('C', { ctrl: true }).kind, 'Ctrl+C with Caps Lock closes too').toBe('close');
    expect(r.press('c', { meta: true }).kind, 'a meta chord is not the key').toBe('state');
    expect(r.press('cc').kind, 'a paste of letters is not the key').toBe('state');
    expect(r.press('x').kind, 'another letter does nothing on the detail').toBe('state');
    expect(r.state.agents?.detail?.slug).toBe('reviewer');
    // The list: a letter does nothing there, and an invalid agent has no detail to press it on.
    r.press('', BACKSPACE);
    expect(r.press('c').kind).toBe('state');
    r.press('', DOWN); // broken-one: invalid
    expect(r.press('', ENTER).kind).toBe('state');
    expect(r.state.agents?.detail, 'an invalid agent opens no detail').toBeUndefined();
    expect(r.press('c').kind, 'so there is no chat for it').toBe('state');
    expect(r.press('C').kind).toBe('state');
    // Sessions has no `c` either.
    r.press('', RIGHT);
    expect(r.state.tab).toBe('sessions');
    expect(r.press('c').kind).toBe('state');
    expect(r.legendText()).not.toContain('chat');
  });

  it('`c` on a detail whose file is no longer in the read it was opened from starts nothing and says so on the list', () => {
    const r = rig();
    r.press('', ENTER);
    const agents = r.state.agents;
    if (agents === undefined) throw new Error('no agents tab');
    // A port whose entry went away between the row being listed and the key (it answers nothing for the row's index).
    r.state = {
      ...r.state,
      agents: { ...agents, read: { ...agents.read, pathOf: () => undefined } },
    };
    expect(r.press('c').kind).toBe('state');
    expect(r.state.agents?.detail, 'back at the list').toBeUndefined();
    expect(r.text()).toContain('reviewer cannot be started: its file is not in the catalog.');
  });

  it('`c` on a detail with no definition to compare with starts nothing either: a chat is bound only to what the person read', () => {
    const r = rig();
    r.press('', ENTER);
    const agents = r.state.agents;
    if (agents === undefined) throw new Error('no agents tab');
    r.state = {
      ...r.state,
      agents: { ...agents, read: { ...agents.read, definitionOf: () => undefined } },
    };
    expect(r.press('c').kind).toBe('state');
    expect(r.state.agents?.detail, 'back at the list').toBeUndefined();
    expect(r.text()).toContain('reviewer cannot be started: its file is not in the catalog.');
  });

  it('Backspace backs out of the detail too, the tab keys leave it, and a chord closes the whole screen', () => {
    const r = rig();
    r.press('', DOWN);
    r.press('', DOWN);
    r.press('', ENTER);
    expect(r.state.agents?.detail?.slug).toBe('writer');
    r.press('', BACKSPACE);
    expect(r.state.agents?.detail).toBeUndefined();
    expect(r.state.agents?.cursor, 'the list is where it was').toBe(2);
    r.press('', ENTER);
    r.press('', RIGHT);
    expect(r.state.tab, '→ leaves the detail for the next tab').toBe('sessions');
    r.press('', LEFT);
    expect(r.state.agents?.detail, 'the tab is entered at its list').toBeUndefined();
    r.press('', ENTER);
    expect(r.press('c', { ctrl: true }).kind, 'Ctrl+C closes from the detail').toBe('close');
  });

  it('Sessions: select and resume with the tab keys and Esc last, each doing what it says', () => {
    const r = rig({ tab: 'sessions' });
    expect(legendKeys(r.state)).toEqual(['←/→', 'Tab', '↑/↓', 'Enter', 'Ctrl+C', 'Esc']);
    expect(r.legendText()).toBe(
      '←/→ tab · Tab cycle · ↑/↓ select · Enter resume · [Ctrl+C] close · Esc close',
    );
    expect(SESSIONS_KEYS.select.keys).toBe('↑/↓');
    expect(SESSIONS_KEYS.resume.keys).toBe('Enter');
    r.press('', DOWN);
    expect(r.state.sessions?.cursor).toBe(1);
    r.press('', DOWN);
    expect(r.state.sessions?.cursor, '↓ stops at the last row').toBe(1);
    r.press('', UP);
    r.press('', UP);
    expect(r.state.sessions?.cursor, '↑ stops at the first row').toBe(0);
    r.press('', DOWN);
    const step = r.press('', ENTER);
    expect(step.kind).toBe('resume');
    expect(step.kind === 'resume' ? step.sessionId : undefined).toBe('sess-bbb');
    r.press('', LEFT);
    expect(r.state.tab).toBe('agents');
    r.press('', RIGHT);
    expect(r.press('', ESC).kind).toBe('close');
  });

  it('fits every legend in the 78 columns an 80-column terminal gives', () => {
    const r = rig();
    const width = usableColumns(80);
    const check = (): void => {
      expect(displayWidth(r.legendText()), r.legendText()).toBeLessThanOrEqual(width);
    };
    check();
    r.press('', ENTER);
    check();
    r.press('', ESC);
    r.press('', RIGHT);
    check();
    const empty = rig({ items: [], sessions: [] });
    expect(displayWidth(empty.legendText())).toBeLessThanOrEqual(width);
  });
});

describe('the Esc ladder is the other tabs’: the detail first, then the screen', () => {
  it('Esc at the list closes the screen, with no detail to go back from, and Ctrl+C closes from anywhere', () => {
    const r = rig();
    expect(r.press('', ESC).kind).toBe('close');
    expect(r.press('c', { ctrl: true }).kind).toBe('close');
    const s = rig({ tab: 'sessions' });
    expect(s.press('', ESC).kind).toBe('close');
    expect(s.press('c', { ctrl: true }).kind).toBe('close');
  });

  it('below 80×24 it is two lines, and Esc says what it does: back from a detail, close from a list', () => {
    const r = rig();
    const small = r.lines(79, 24);
    expect(small).toHaveLength(2);
    expect(small[0]).toBe(TAB_HOST_TOO_SMALL);
    expect(small[1]).toBe('Esc close');
    r.press('', ENTER);
    expect(r.lines(80, 23)[1]).toBe('Esc back to the list');
  });
});

describe('the Sessions tab lists this project’s conversations', () => {
  it('draws the title, the agent and the age, and the selected row with a pointer', () => {
    const r = rig({ tab: 'sessions' });
    const rows = r.lines().slice(2, 4);
    expect(rows[0]).toMatch(/^› Fix the flaky test {2}coder\s+5m ago$/u);
    expect(rows[1]).toMatch(/^ {2}Untitled {2}writer\s+2h ago$/u);
  });

  it('asks the host to resume the selected row’s own id, which it never draws', () => {
    const r = rig({ tab: 'sessions' });
    expect(r.text()).not.toContain('sess-aaa');
    const step = r.press('', ENTER);
    expect(step.kind).toBe('resume');
    expect(step.kind === 'resume' ? step.sessionId : undefined).toBe('sess-aaa');
    // The state it carries is the tab as the key left it, so a host that does not close it keeps a working tab.
    expect(step.kind === 'resume' ? step.state.sessions?.cursor : undefined).toBe(0);
  });

  it('draws a title that looks like a command or a path as text, and resumes by id, never by title', () => {
    const r = rig({
      tab: 'sessions',
      sessions: [sessionRow('real-id-1', '/exit --now ../../etc/passwd')],
    });
    expect(r.lines()[2]).toContain('/exit --now ../../etc/passwd');
    const step = r.press('', ENTER);
    expect(step.kind === 'resume' ? step.sessionId : undefined).toBe('real-id-1');
  });

  it('says when older conversations exist and /resume searches them', () => {
    const r = rig({ tab: 'sessions', more: true });
    expect(r.text()).toContain('older conversations are not listed; /resume searches them');
    expect(rig({ tab: 'sessions' }).text()).not.toContain('older conversations');
  });

  it('says there is none, names no row key and resumes nothing when the project has no conversation', () => {
    const r = rig({ tab: 'sessions', sessions: [] });
    expect(r.text()).toContain('No saved conversations in this project yet.');
    expect(r.legendText()).toBe('←/→ tab · Tab cycle · [Ctrl+C] close · Esc close');
    expect(r.press('', ENTER).kind).toBe('state');
  });

  it('says it cannot list when no port is wired or the port cannot be read, never the cause', () => {
    for (const sessionsPort of [
      undefined,
      {
        read: () => {
          throw new Error('PRIVATE_FAULT_TEXT');
        },
      } satisfies SessionsPort,
    ]) {
      const r = rig({ tab: 'sessions', sessionsPort });
      expect(r.state.unreadable).toBe(true);
      expect(r.text()).toContain('The conversations of this project could not be listed.');
      expect(r.text()).not.toContain('PRIVATE_FAULT_TEXT');
      expect(r.press('', ENTER).kind).toBe('state');
      expect(r.press('', ESC).kind).toBe('close');
    }
  });
});

describe('both tabs fit the 23-row budget at the sizes a terminal has', () => {
  const many = Array.from({ length: 300 }, (_, index) =>
    index % 7 === 3
      ? invalid(`agent-${String(index).padStart(3, '0')}`, 'a'.repeat(400))
      : ready(`agent-${String(index).padStart(3, '0')}`, {}, `Agent number ${String(index)}`),
  );
  const manySessions = Array.from({ length: 300 }, (_, index) =>
    sessionRow(`s-${String(index)}`, `Conversation number ${String(index)} ${'long '.repeat(40)}`),
  );
  const checks: readonly (readonly [string, number, number])[] = [
    ['80x24', 80, 24],
    ['120x40', 120, 40],
    ['80x30', 80, 30],
  ];

  it.each(checks)(
    'at %s, with 300 rows: at most 23 rows, none wider than the margin allows, the cursor in view, the strip first and the legend last',
    (_name, columns, terminalRows) => {
      for (const tab of ['agents', 'sessions'] as const) {
        const r = rig({ tab, items: many, sessions: manySessions });
        for (const at of [0, 1, 7, 150, 299]) {
          if (tab === 'agents' && r.state.agents !== undefined)
            r.state = { ...r.state, agents: { ...r.state.agents, cursor: at } };
          if (tab === 'sessions' && r.state.sessions !== undefined)
            r.state = { ...r.state, sessions: { ...r.state.sessions, cursor: at } };
          const lines = r.lines(columns, terminalRows);
          expect(lines.length, `${tab} cursor ${String(at)}`).toBeLessThanOrEqual(TAB_HOST_ROWS);
          expect(lines[0]).toContain('› ');
          expect(lines.at(-1)).toContain('Esc close');
          for (const line of lines)
            expect(displayWidth(line), line).toBeLessThanOrEqual(usableColumns(columns));
          expect(lines.slice(1).filter((line) => line.startsWith('› '))).toHaveLength(1);
        }
      }
    },
  );

  it.each(checks)(
    'at %s, the detail page of the largest agent fits: 64 long tool names, a wide prompt, nothing past the budget',
    (_name, columns, terminalRows) => {
      const tools = Array.from(
        { length: AGENT_TOOLS_MAX + 3 },
        (_, index) => `${'t'.repeat(120)}_${String(index)}`,
      );
      for (const prompt of [
        'x'.repeat(5000),
        '界'.repeat(500),
        `${'word '.repeat(80)}\n\n${'line\n'.repeat(80)}`,
      ]) {
        const r = rig({
          items: [
            ready('big', {
              tools,
              system_prompt: prompt,
              temperature: 1.5,
              reasoning_effort: 'high',
            }),
          ],
        });
        r.press('', ENTER);
        expect(r.state.agents?.detail).toBeDefined();
        const lines = r.lines(columns, terminalRows);
        expect(lines.length).toBeLessThanOrEqual(TAB_HOST_ROWS);
        expect(lines.length).toBeLessThanOrEqual(AGENT_DETAIL_ROWS + 3);
        expect(lines[0]).toContain('› Defined');
        expect(lines.at(-1)).toContain('Esc back');
        for (const line of lines)
          expect(displayWidth(line), line).toBeLessThanOrEqual(usableColumns(columns));
      }
    },
  );
});
