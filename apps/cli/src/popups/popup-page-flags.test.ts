/**
 * Review round 3: a report that is a PAGE to read (unit 8 fix wave 2, O2-2) is drawn inline in the body's whole height, not windowed to the
 * ten rows of a list. Pinned for the reports the wave marked and no test marked: `/agent`, `/cost`, `/workflows` in a chat, and an agent's
 * detail on the Home. (`/help` on both surfaces is pinned in `help-popup.test.ts` and `home-help-popup.test.ts`.)
 */
import type { Agent } from '@relavium/shared';
import { describe, expect, it } from 'vitest';

import { boundAgentView } from '../chat/bound-agent-view.js';
import { agentContent } from './agent-popup.js';
import { costReportContent } from './cost-popup.js';
import { agentDetailContent } from './home-agents-popup.js';
import { agentsRead, readyAgent } from './home-popups.test-support.js';
import { catalogEntry, costReading } from './report.test-support.js';
import { workflowsContent } from './workflows-popup.js';

const definition = (over: Partial<Agent> = {}): Agent => ({
  id: 'reviewer',
  name: 'Reviewer',
  model: 'claude-sonnet-5-5',
  provider: 'anthropic',
  system_prompt: 'You review commits.',
  tools: [],
  ...over,
});

describe('a report that is a page to read says so', () => {
  it('`/agent`', () => {
    const view = boundAgentView(definition(), 'high');
    expect(agentContent(view)).toMatchObject({ kind: 'report', page: true });
  });

  it('`/cost`', () => {
    expect(costReportContent(costReading())).toMatchObject({ kind: 'report', page: true });
  });

  it('`/workflows` in a chat', () => {
    const workflows = Array.from({ length: 16 }, (_, at) => catalogEntry(`flow-${String(at)}`));
    expect(workflowsContent({ kind: 'catalog', workflows, agents: [] })).toMatchObject({
      kind: 'report',
      page: true,
    });
  });

  it('an agent’s detail on the Home', () => {
    const item = readyAgent('commit-reviewer');
    const row = agentsRead([item]).model.rows.find((entry) => entry.state === 'ready');
    if (row === undefined) throw new Error('no ready row');
    expect(agentDetailContent(row)).toMatchObject({ kind: 'report', page: true });
  });
});
