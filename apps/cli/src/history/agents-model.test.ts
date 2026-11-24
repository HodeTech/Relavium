import { describe, expect, it } from 'vitest';

import {
  AGENT_PROMPT_HEAD_CHARS,
  AGENT_TOOLS_MAX,
  agentDetailOf,
  buildAgentsModel,
  type AgentFields,
  type AgentRow,
  type AgentsModelItem,
} from './agents-model.js';
import { MAX_IDENTIFIER_CHARS } from './run-detail-model.js';

/**
 * The agents list's model (MVP-8 step 5): one row per agent file, a read-only detail on a valid one, and the head of the system
 * prompt as the only part of it that appears. An agent file is repository-authored text, so these tests hold that the head is
 * scrubbed WHOLE and cut after, that a refused file stays a row with a reason and no contents, and that no string of a row
 * carries a terminal control.
 */

const ESC = String.fromCharCode(0x1b);
const RLO = String.fromCharCode(0x202e);
const BEL = String.fromCharCode(0x07);

// A key-shaped string: the `sk-` prefix and thirty alphanumerics. Built from parts so no literal credential sits in the source.
const KEY = `sk-${'A1b2C3d4E5'.repeat(3)}`;
const MASK = '[REDACTED]';

const definition = (over: Partial<AgentFields> = {}): AgentFields => ({
  model: 'claude-sonnet-4-6',
  provider: 'anthropic',
  system_prompt: 'You review code.',
  ...over,
});

const ready = (
  slug: string,
  agent: Partial<AgentFields> = {},
  entry: Partial<AgentsModelItem['entry']> = {},
): AgentsModelItem => ({
  entry: {
    slug,
    name: undefined,
    path: `.relavium/agents/${slug}.agent.yaml`,
    valid: true,
    ...entry,
  },
  agent: definition(agent),
});

const refused = (slug: string, error: string | undefined): AgentsModelItem => ({
  entry: {
    slug,
    name: undefined,
    path: `.relavium/agents/${slug}.agent.yaml`,
    valid: false,
    ...(error === undefined ? {} : { error }),
  },
  agent: undefined,
});

/** The one row of a model built from one item. */
function rowOf(item: AgentsModelItem): AgentRow {
  const row = buildAgentsModel([item]).rows[0];
  if (row === undefined) throw new Error('expected one row');
  return row;
}

/** The head of the one ready row built from `prompt`. */
function headOf(prompt: string): string {
  const detail = rowOf(ready('a', { system_prompt: prompt })).detail;
  if (detail === undefined) throw new Error('expected a detail');
  return detail.promptHead;
}

// The characters the terminal floor must have removed: controls (C0, DEL, C1) and format characters (bidi, zero-width).
const UNSAFE = /[\p{Cc}\p{Cf}]/u;

describe('buildAgentsModel', () => {
  describe('the detail of a ready agent', () => {
    it('carries the model, the provider, the tool grant as declared, the temperature and the reasoning effort', () => {
      const row = rowOf(
        ready('reviewer', {
          model: 'claude-opus-4-8',
          provider: 'anthropic',
          tools: ['read_file', 'grep', 'mcp__github__create_pull_request'],
          temperature: 0.25,
          reasoning_effort: 'high',
        }),
      );
      expect(row.state).toBe('ready');
      expect(row.detail).toEqual({
        model: 'claude-opus-4-8',
        provider: 'anthropic',
        tools: ['read_file', 'grep', 'mcp__github__create_pull_request'],
        toolsMore: 0,
        temperature: 0.25,
        reasoningEffort: 'high',
        promptHead: 'You review code.',
      });
    });

    it('says nothing about a temperature or a reasoning effort the definition leaves out, and an agent with no tools grants none', () => {
      const detail = rowOf(ready('plain')).detail;
      expect(detail).toBeDefined();
      expect(detail).not.toHaveProperty('temperature');
      expect(detail).not.toHaveProperty('reasoningEffort');
      expect(detail?.tools).toEqual([]);
      expect(detail?.toolsMore).toBe(0);
      // A temperature of zero is a value, not an absence.
      expect(rowOf(ready('cold', { temperature: 0 })).detail?.temperature).toBe(0);
    });

    it('lists the tools in the order declared, up to a bound, and counts the rest', () => {
      const tools = Array.from({ length: AGENT_TOOLS_MAX + 5 }, (_, index) => `tool_${index}`);
      const detail = rowOf(ready('many', { tools })).detail;
      expect(detail?.tools).toEqual(tools.slice(0, AGENT_TOOLS_MAX));
      expect(detail?.toolsMore).toBe(5);
    });

    it('holds exactly the fixed list of fields: no other part of the definition, and no more of the prompt, is in the detail', () => {
      const detail = rowOf(ready('a')).detail;
      expect(Object.keys(detail ?? {}).sort()).toEqual(
        ['model', 'promptHead', 'provider', 'tools', 'toolsMore'].sort(),
      );
    });
  });

  describe('the head of the system prompt', () => {
    it('is the first 240 code points, and a short prompt is shown whole with no cut marker', () => {
      expect(AGENT_PROMPT_HEAD_CHARS).toBe(240);
      const exact = 'x'.repeat(AGENT_PROMPT_HEAD_CHARS);
      expect(headOf(exact)).toBe(exact);
      expect(headOf('Short prompt.')).toBe('Short prompt.');
      expect(headOf(`${exact}y`)).toBe(`${exact}…`);
    });

    it('shows nothing of the prompt past the head, in any field of the row or the model', () => {
      const tail = 'TAIL-MARKER-past-the-head';
      const prompt = `${'You review code. '.repeat(20)}${tail}`;
      expect(prompt.indexOf(tail)).toBeGreaterThan(AGENT_PROMPT_HEAD_CHARS);
      const model = buildAgentsModel([ready('a', { system_prompt: prompt })]);
      expect(JSON.stringify(model)).not.toContain(tail);
      expect(model.rows[0]?.detail?.promptHead.length).toBeLessThanOrEqual(
        AGENT_PROMPT_HEAD_CHARS + 1,
      );
    });

    it('masks a key-shaped string inside the head', () => {
      const head = headOf(`Call the service with the key ${KEY} for every request.`);
      expect(head).toContain(MASK);
      expect(head).not.toContain(KEY);
      expect(head).not.toContain(KEY.slice(3));
    });

    it('masks an environment-style API_KEY= line, on one line and across several', () => {
      const oneLine = headOf(`Export OPENAI_API_KEY=${KEY} before you start.`);
      expect(oneLine).toContain(MASK);
      expect(oneLine).not.toContain(KEY);

      const several = headOf(`You are a deployer.\nAPI_KEY=${KEY}\nThen run the release.`);
      expect(several).toContain(MASK);
      expect(several).not.toContain(KEY);
      expect(several).not.toContain(KEY.slice(3));
    });

    it('leaves no fragment of a credential that the 240-character cut would have split', () => {
      // `sk-` and seven characters fall before the cut and twenty-three after it: cut first, those ten characters are too short a
      // shape for the scrubber to know, and they would be shown as the start of a key. Scrubbed whole, the key is one mask.
      const prefix = 'word '.repeat(46);
      const prompt = `${prefix}${KEY} and then some closing text.`;
      expect(prefix).toHaveLength(230);
      expect(prompt.indexOf(KEY)).toBeLessThan(AGENT_PROMPT_HEAD_CHARS);
      expect(prompt.indexOf(KEY) + KEY.length).toBeGreaterThan(AGENT_PROMPT_HEAD_CHARS);

      const head = headOf(prompt);
      expect(head).toContain(MASK);
      expect(head).not.toContain('sk-');
      expect(head).not.toContain(KEY.slice(0, 10));
      expect(head.startsWith(prefix)).toBe(true);
    });

    it('cuts by code point: an emoji across the 240 cut is kept whole or left out, never split into a lone surrogate', () => {
      const emoji = String.fromCodePoint(0x1f600);
      const loneSurrogate =
        /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;
      // The emoji is the 240th code point but takes UTF-16 units 239 and 240: a cut by code unit at 240 would keep only its first half.
      const lastKept = `${'a'.repeat(AGENT_PROMPT_HEAD_CHARS - 1)}${emoji}${' tail'}`;
      expect(lastKept.slice(0, AGENT_PROMPT_HEAD_CHARS).slice(-1)).toMatch(loneSurrogate);
      const kept = headOf(lastKept);
      expect(kept).toBe(`${'a'.repeat(AGENT_PROMPT_HEAD_CHARS - 1)}${emoji}…`);
      expect(kept).not.toMatch(loneSurrogate);

      // The emoji is the 241st code point: it is left out whole.
      const firstCut = headOf(`${'a'.repeat(AGENT_PROMPT_HEAD_CHARS)}${emoji}${' tail'}`);
      expect(firstCut).toBe(`${'a'.repeat(AGENT_PROMPT_HEAD_CHARS)}…`);
      expect(firstCut).not.toMatch(loneSurrogate);
    });

    it('is on one line with no terminal control in it, whatever the prompt holds', () => {
      const head = headOf(`Line one.\n\n${ESC}[2J${RLO}Line two.${BEL}\tend`);
      expect(head).toContain('Line one.');
      expect(head).toContain('Line two.');
      expect(head).not.toMatch(UNSAFE);
    });

    it('is a fixed sentence that says only a size for a prompt too large to scrub whole, never a cut of it', () => {
      const secretFirst = `${KEY} ${'a'.repeat(70_000)}`;
      const head = headOf(secretFirst);
      expect(head).toMatch(/^text too large to show \(\d+ bytes\)$/);
      expect(head).not.toContain('sk-');
    });
  });

  describe('a file that is not a ready agent', () => {
    it('stays a row, invalid, with the reason the catalog gave and no detail', () => {
      const row = rowOf(refused('torn', 'bogus: unknown key: `bogus`'));
      expect(row).toMatchObject({
        state: 'invalid',
        slug: 'torn',
        entryIndex: 0,
        note: 'bogus: unknown key: `bogus`',
        path: '.relavium/agents/torn.agent.yaml',
      });
      expect(row).not.toHaveProperty('detail');
    });

    it('is never shown as ready for lack of a definition, and a definition handed with a refused entry is not shown', () => {
      const noDefinition: AgentsModelItem = { ...ready('ghost'), agent: undefined };
      expect(rowOf(noDefinition)).toMatchObject({ state: 'invalid', note: 'could not be read' });
      expect(rowOf(noDefinition)).not.toHaveProperty('detail');

      const refusedWithDefinition: AgentsModelItem = {
        entry: refused('half', 'could not parse the file').entry,
        agent: definition({ system_prompt: 'LEAKED-PROMPT' }),
      };
      const row = rowOf(refusedWithDefinition);
      expect(row.state).toBe('invalid');
      expect(JSON.stringify(row)).not.toContain('LEAKED-PROMPT');
    });

    it('says "could not be read" for a refusal with no reason, and bounds a long one', () => {
      expect(rowOf(refused('mute', undefined)).note).toBe('could not be read');
      const note = rowOf(refused('wordy', 'x'.repeat(5000))).note ?? '';
      expect(note.length).toBeLessThanOrEqual(257);
      expect(note.endsWith('…')).toBe(true);
    });
  });

  describe('the rows', () => {
    it('are one per file, in the order given, each naming its entry by index', () => {
      const model = buildAgentsModel([
        ready('alpha', {}, { name: 'Alpha' }),
        refused('beta', 'bad'),
        ready('gamma'),
      ]);
      expect(model.total).toBe(3);
      expect(model.rows.map((row) => [row.slug, row.state, row.entryIndex, row.name])).toEqual([
        ['alpha', 'ready', 0, 'Alpha'],
        ['beta', 'invalid', 1, undefined],
        ['gamma', 'ready', 2, undefined],
      ]);
    });

    it('is empty for no files', () => {
      expect(buildAgentsModel([])).toEqual({ rows: [], total: 0 });
    });

    it('puts every string of a row through the terminal floor and a bound: a name, a slug, a path, a model, a tool', () => {
      const dirty = `${ESC}[31mred${ESC}[0m${RLO}x${BEL}`;
      const row = rowOf(
        ready(
          dirty,
          { model: dirty, provider: 'openai', tools: [dirty, 'z'.repeat(500)] },
          { name: dirty, path: `.relavium/agents/${dirty}.agent.yaml` },
        ),
      );
      const strings = [
        row.slug,
        row.name ?? '',
        row.path,
        row.detail?.model ?? '',
        ...(row.detail?.tools ?? []),
      ];
      for (const text of strings) expect(text).not.toMatch(UNSAFE);
      expect(row.detail?.tools[1]?.length).toBeLessThanOrEqual(MAX_IDENTIFIER_CHARS + 1);
    });

    it('bounds a slug to 128 code points and a path to 256, each with the cut marker', () => {
      const slug = 'long-name-'.repeat(20);
      const path = `.relavium/agents/${'nested-directory/'.repeat(30)}file.agent.yaml`;
      expect([...slug].length).toBeGreaterThan(MAX_IDENTIFIER_CHARS);
      expect([...path].length).toBeGreaterThan(256);

      const row = rowOf(ready(slug, {}, { path }));
      expect(row.slug).toBe(`${slug.slice(0, MAX_IDENTIFIER_CHARS)}…`);
      expect([...row.slug]).toHaveLength(MAX_IDENTIFIER_CHARS + 1);
      expect(row.path).toBe(`${path.slice(0, 256)}…`);
      expect([...row.path]).toHaveLength(257);

      // At the bound, neither is cut and neither carries the marker.
      const exact = rowOf(
        ready('s'.repeat(MAX_IDENTIFIER_CHARS), {}, { path: `${'p'.repeat(256)}` }),
      );
      expect(exact.slug).toBe('s'.repeat(MAX_IDENTIFIER_CHARS));
      expect(exact.path).toBe('p'.repeat(256));
    });

    it('masks a key-shaped string in a name, a refusal reason or a tool name', () => {
      const row = rowOf(ready('a', { tools: [`tool-${KEY}`] }, { name: `Agent ${KEY}` }));
      expect(JSON.stringify(row)).not.toContain(KEY);
      const refusal = rowOf(refused('b', `bogus: unknown key: ${KEY}`));
      expect(JSON.stringify(refusal)).not.toContain(KEY);
    });
  });
});

describe('the detail of a row is built when it is read, not when the list is built', () => {
  /** An agent whose prompt counts how many times the model looked at it: the scrub of a prompt starts with that read. */
  function counted(slug: string, reads: string[]): AgentsModelItem {
    const item = ready(slug);
    const agent = definition();
    Object.defineProperty(agent, 'system_prompt', {
      enumerable: true,
      get: (): string => {
        reads.push(slug);
        return 'You review code.';
      },
    });
    return { ...item, agent };
  }

  it('reads no prompt for a list of 500 agents, reads one when its detail is read, and reads it once however often it is asked for', () => {
    const reads: string[] = [];
    const items = Array.from({ length: 500 }, (_, index) => counted(`agent-${index}`, reads));
    const model = buildAgentsModel(items);
    expect(model.rows).toHaveLength(500);
    expect(reads, 'the list is built without scrubbing a single prompt').toEqual([]);
    const row = model.rows[7];
    expect(row?.detail?.promptHead).toBe('You review code.');
    expect(row?.detail).toBe(row?.detail);
    expect(reads, 'one prompt, once').toEqual(['agent-7']);
  });

  it('shows the same detail an eager build would: the one function the chat sheet also uses, enumerable like any field', () => {
    const agent = definition({ tools: ['read_file'], temperature: 0.2 });
    const row = rowOf({ ...ready('a'), agent });
    expect(row.detail).toEqual(agentDetailOf(agent));
    expect(Object.keys(row)).toContain('detail');
    expect(JSON.parse(JSON.stringify(row))).toMatchObject({ detail: { provider: 'anthropic' } });
  });

  it('gives a refused file no detail at all, and reads nothing of it', () => {
    const row = rowOf(refused('bad', 'a workflow must declare at least one node'));
    expect(row.detail).toBeUndefined();
    expect('detail' in row).toBe(false);
  });
});
