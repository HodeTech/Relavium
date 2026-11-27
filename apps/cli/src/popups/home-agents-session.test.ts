/**
 * The `/agents` popup on the Home through the opener and a real popup host on a manual clock ([MVP-11 unit 8](../../../../docs/roadmap/phases/mvp-11/unit-8-plan.md)
 * §4 D5): the catalogue is read in the popup's own work; a ready agent is `✓ ready` and an invalid one `✗ invalid` with its reason; `Enter` opens the
 * detail of a ready one; `[c]` closes the popup and hands the host the file the detail showed and the definition it was drawn from; a stored word
 * is the Home's row scrub's.
 */
import { describe, expect, it } from 'vitest';

import { CliError } from '../process/errors.js';
import { AGENTS_STEP } from './home-agents-popup.js';
import {
  DOWN,
  ENTER,
  ESC,
  agentDefinition,
  agentsRead,
  brokenAgent,
  fakeAgents,
  homeRig,
  readyAgent,
  recordingOwner,
  settleWork,
} from './home-popups.test-support.js';

async function opened(fakes = fakeAgents()) {
  const rig = homeRig();
  expect(rig.open('agents', { agents: fakes.port }).opened).toBe(true);
  await settleWork();
  rig.settle();
  return { rig, fakes };
}

describe('the list', () => {
  it('opens loading, reads in its own work, then lists the agents: a heading with the count, a title, `ready` or `invalid` at the end of each row', async () => {
    const rig = homeRig();
    const fakes = fakeAgents([readyAgent('commit-reviewer'), brokenAgent('triage-bot')]);
    expect(rig.open('agents', { agents: fakes.port }).opened).toBe(true);
    expect(rig.content().kind).toBe('loading');
    expect(fakes.read).not.toHaveBeenCalled();
    await settleWork();
    const content = rig.content();
    if (content.kind !== 'list') throw new Error('list');
    expect(content.rows[0]?.label).toBe('This project · 2 agents');
    expect(content.rows[1]).toMatchObject({
      id: 'agent:0',
      tail: { status: 'completed', words: 'ready' },
    });
    expect(content.rows[1]?.label.trim()).toBe('commit-reviewer');
    expect(content.rows[1]?.detail?.trim()).toBe('Commit reviewer');
    expect(content.rows[2]).toMatchObject({
      id: 'agent:1',
      tail: { status: 'failed', words: 'invalid' },
    });
    // Under the list while highlighted: the file, or why the agent cannot be opened.
    expect(content.rows[1]?.effect).toBe('.relavium/agents/commit-reviewer.agent.yaml');
    expect(content.rows[2]?.effect).toBe('Cannot open: agent.model: required');
    expect(rig.highlighted()).toBe('agent:0');
  });

  it('says so when the project has no agent, with the next action inside the TUI', async () => {
    const { rig } = await opened(fakeAgents([]));
    expect(rig.content().kind).toBe('empty');
    expect(rig.words()).toContain('No agents in this project.');
    expect(rig.words()).toContain('.relavium/agents (see /init)');
  });

  it('a catalog the project cannot give is a state in the popup, in its own words; any other fault is the owner’s and says nothing of its message', async () => {
    const failures: unknown[] = [];
    const owner = recordingOwner(failures);
    const rig = homeRig();
    rig.open('agents', {
      agents: {
        ...fakeAgents().port,
        read: () => {
          throw new CliError(
            'invalid_invocation',
            'too many agent files in the catalog (more than 500).',
          );
        },
      },
      workOwner: owner,
    });
    await settleWork();
    expect(rig.content().kind).toBe('error');
    expect(rig.words()).toContain('too many agent files');
    expect(failures).toEqual([]);

    const rig2 = homeRig();
    const boom = new Error('/Users/x/.relavium/agents: EACCES');
    rig2.open('agents', {
      agents: {
        ...fakeAgents().port,
        read: () => {
          throw boom;
        },
      },
      workOwner: owner,
    });
    await settleWork();
    expect(failures).toEqual([boom]);
    expect(rig2.words()).not.toContain('/Users/x');
  });
});

describe('the detail and `[c] chat`', () => {
  it('`Enter` on a ready agent opens its detail: the model, the provider, the temperature, the effort, the tools, the head of the prompt, and a pointer to `/resume`', async () => {
    const { rig } = await opened();
    rig.press('', ENTER);
    expect(rig.step()).toBe(AGENTS_STEP.detail);
    const words = rig.words();
    expect(words).toContain('commit-reviewer · Commit reviewer');
    expect(words).toMatch(/Model\s+claude-sonnet-5-5/u);
    expect(words).toMatch(/Provider\s+anthropic/u);
    expect(words).toMatch(/Temperature\s+0\.2/u);
    expect(words).toMatch(/Reasoning effort\s+not set/u);
    expect(words).toMatch(/Tools\s+read_file, run_command/u);
    expect(words).toContain('System prompt (the first characters)');
    expect(words).toContain('You review git commits of the repository.');
    expect(words).toContain('Conversations: /resume lists them');
    expect(rig.controls()).toEqual(['c']);
  });

  it('`Enter` on an invalid agent opens nothing and says why in one notification; `[c]` is not offered on the list', async () => {
    const { rig } = await opened(fakeAgents([brokenAgent('triage-bot', 'agent.model: required')]));
    rig.press('', ENTER);
    expect(rig.step()).toBe(AGENTS_STEP.list);
    expect(rig.notice()).toBe('triage-bot cannot be opened: agent.model: required');
    expect(rig.controls()).toEqual([]);
    rig.press('c');
    expect(rig.isOpen()).toBe(true);
  });

  it('`[c]` closes the popup and hands the host the catalog’s path and the definition the detail was drawn from', async () => {
    const fakes = fakeAgents([readyAgent('doc-writer'), readyAgent('commit-reviewer')]);
    const { rig } = await opened(fakes);
    rig.press('', DOWN);
    rig.press('', ENTER);
    rig.clock.advance(700);
    rig.press('c');
    expect(rig.isOpen()).toBe(false);
    expect(fakes.chats).toHaveLength(1);
    expect(fakes.chats[0]?.path).toBe('.relavium/agents/commit-reviewer.agent.yaml');
    expect(fakes.chats[0]?.listed.id).toBe('commit-reviewer');
  });

  it('a file that is no longer in the read starts nothing and says so; the popup stays', async () => {
    const fakes = fakeAgents();
    const rig = homeRig();
    let calls = 0;
    rig.open('agents', {
      agents: {
        ...fakes.port,
        read: () => {
          calls += 1;
          const read = agentsRead([readyAgent('commit-reviewer')]);
          return { ...read, definitionOf: () => undefined };
        },
      },
    });
    await settleWork();
    rig.settle();
    rig.press('', ENTER);
    rig.clock.advance(700);
    rig.press('c');
    expect(calls).toBe(1);
    expect(rig.isOpen()).toBe(true);
    expect(fakes.chats).toEqual([]);
    expect(rig.notice()).toContain('cannot be started');
  });

  it('`Esc` goes back to the list, then closes; nothing is started by either', async () => {
    const { rig, fakes } = await opened();
    rig.press('', ENTER);
    rig.press('', ESC);
    expect(rig.step()).toBe(AGENTS_STEP.list);
    rig.press('', ESC);
    expect(rig.isOpen()).toBe(false);
    expect(fakes.chats).toEqual([]);
  });

  it('a key held down answers nothing: `Enter` before the popup’s first frame, and inside the half second after it, opens no detail (and `[c]` is no key of the list)', async () => {
    const fakes = fakeAgents();
    const rig = homeRig();
    expect(rig.open('agents', { agents: fakes.port }).opened).toBe(true);
    await settleWork();
    rig.press('', ENTER); // before the first frame was shown
    rig.host.shown(rig.host.getSnapshot());
    rig.clock.advance(100);
    rig.press('', ENTER); // inside the settle
    rig.press('c');
    expect(rig.step()).toBe(AGENTS_STEP.list);
    expect(fakes.chats).toEqual([]);
    expect(rig.isOpen()).toBe(true);
  });
});

describe('what a stored word cannot do', () => {
  it.each([
    `${String.fromCharCode(27)}[31mred`,
    '▼ 9 more',
    '[Enter] open',
    'Press Ctrl+Y now',
    'x'.repeat(500),
  ])('an agent named %j is drawn as text, in every row and in the detail', async (name) => {
    const agent = readyAgent('hostile', {
      name,
      model: name,
      system_prompt: name,
      tools: [name],
    });
    const fakes = fakeAgents([
      { ...agent, entry: { ...agent.entry, path: `.relavium/agents/${name}.yaml` } },
    ]);
    const { rig } = await opened(fakes);
    const list = rig.content();
    if (list.kind !== 'list') throw new Error('list');
    rig.press('', ENTER);
    const detail = rig.content();
    if (detail.kind !== 'report') throw new Error('report');
    const texts = [
      ...list.rows.flatMap((row) => [row.label, row.detail ?? '', row.effect ?? '']),
      ...detail.lines,
    ];
    for (const text of texts) {
      expect(text.includes(String.fromCharCode(27))).toBe(false);
      expect(text).not.toMatch(/▼ \d+ more/u);
      expect(text).not.toMatch(/\[Enter\]/u);
      expect(text).not.toMatch(/Ctrl\+Y/u);
      expect([...text].length).toBeLessThanOrEqual(130);
    }
    void agentDefinition;
  });
});
