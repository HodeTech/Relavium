/**
 * Every stored word of the Home's `/workflows` and `/agents` popups goes through the Home's one row scrub (`home-text.ts`; review round 1, M-4): a
 * workflow's or an agent's name, the root another project pinned it under, a node id, a refusal's reason. A removed scrub at any site is caught here:
 * the words are the forgeries the scrub exists for (a `▼ N more` marker, a `[Enter]` key hint, an escape character), drawn in the place each reaches.
 *
 * Sites this file cannot reach, because the value is a closed set the schema validates before it gets here: an agent's `provider` and its
 * `reasoning_effort` (an enum each, so no forgery can be the value), which the popup scrubs all the same.
 */
import { describe, expect, it } from 'vitest';

import {
  ENTER,
  fakeAgents,
  fakeWorkflows,
  detailOf,
  homeRig,
  readyAgent,
  settleWork,
  workflowEntry,
} from './home-popups.test-support.js';
import type { PopupContent } from './frame-model.js';

const FORGERIES = [
  { name: 'a marker', word: '▼ 9 more', gone: /[▲▼]/u },
  { name: 'a key hint', word: '[Enter] open', gone: /\[Enter\]/u },
  {
    name: 'an escape',
    word: `${String.fromCharCode(27)}[31mred`,
    gone: new RegExp(String.fromCharCode(27), 'u'),
  },
] as const;

/** Every string a step draws, raw. */
const drawn = (content: PopupContent): string => {
  if (content.kind === 'list')
    return content.rows
      .map(
        (row) => `${row.label}\n${row.detail ?? ''}\n${row.effect ?? ''}\n${row.tail?.words ?? ''}`,
      )
      .join('\n');
  return content.kind === 'report' ? content.lines.join('\n') : '';
};

describe.each(FORGERIES)('a workflow whose words are $name', ({ word, gone }) => {
  const slug = `w-${word}`;

  it('is a line of text in its detail’s title and its chain, without a note on the node', async () => {
    const fakes = fakeWorkflows([workflowEntry(slug)]);
    fakes.describe.mockReturnValue(detailOf({ nodes: [{ id: word }] }));
    const rig = homeRig();
    rig.open('workflows', { workflows: fakes.port });
    await settleWork();
    rig.settle();
    rig.press('', ENTER);
    await settleWork();
    const text = drawn(rig.content());
    expect(text).toContain('Nodes');
    expect(text).not.toMatch(gone);
  });

  it('is plain in the notification of `[r]` when its file is not in the read any more, in the words that fit (a slug of seven columns leaves room for it)', async () => {
    const shortSlug = word.length <= 7 ? word : word.slice(0, 7);
    // The sentence is 54 columns with a slug of seven: a longer one makes the notification give up the name (and then there is no stored word in it).
    const fakes = fakeWorkflows([workflowEntry(shortSlug)]);
    const forgotten = {
      ...fakes.port,
      read: () => ({ ...fakes.port.read(), slugOf: () => undefined }),
    };
    const rig = homeRig();
    rig.open('workflows', { workflows: forgotten });
    await settleWork();
    rig.settle();
    rig.press('r');
    expect(rig.notice()).toContain('not in the catalog any more');
    expect(rig.notice() ?? '').not.toMatch(gone);
  });

  it('is plain in the notification of `[r]` when its file is not in the read any more, and in `[p]`’s', async () => {
    const fakes = fakeWorkflows([workflowEntry(slug)]);
    // A read that no longer knows the entry: what `requestOf` says of it must be a scrubbed word too.
    const forgotten = {
      ...fakes.port,
      read: () => ({ ...fakes.port.read(), slugOf: () => undefined }),
    };
    const rig = homeRig();
    rig.open('workflows', { workflows: forgotten });
    await settleWork();
    rig.settle();
    rig.press('r');
    expect(rig.notice()).toContain('not in the catalog any more');
    expect(rig.notice() ?? '').not.toMatch(gone);
    expect(rig.isOpen()).toBe(true);
  });

  it('is plain in the notification of a pin', async () => {
    const fakes = fakeWorkflows([workflowEntry(slug)]);
    const rig = homeRig();
    rig.open('workflows', { workflows: fakes.port });
    await settleWork();
    rig.settle();
    rig.press('', ENTER);
    await settleWork();
    rig.clock.advance(700);
    rig.press('p');
    expect(rig.notice()).toMatch(/^Pinned/u);
    expect(rig.notice() ?? '').not.toMatch(gone);
  });

  it('pinned under another project, its root is plain in the row’s effect and in its short report', async () => {
    const fakes = fakeWorkflows([workflowEntry('local')], {
      otherPins: [{ ref: 'elsewhere', projectRoot: `/work/${word}/app` }],
    });
    const rig = homeRig();
    rig.open('workflows', { workflows: fakes.port });
    await settleWork();
    rig.settle();
    // The pinned row of the other project leads the catalogue.
    const list = rig.content();
    if (list.kind !== 'list') throw new Error('a list');
    const row = list.rows.find((entry) => entry.id.startsWith('pin:'));
    expect(row).toBeDefined();
    expect(row?.effect ?? '').toContain('another project');
    expect(row?.effect ?? '').not.toMatch(gone);
    rig.press('', ENTER);
    await settleWork();
    const report = drawn(rig.content());
    expect(report).toContain('another project');
    expect(report).not.toMatch(gone);
  });
});

describe.each(FORGERIES)('an agent whose words are $name', ({ word, gone }) => {
  it('is a line of text in its detail’s title', async () => {
    const rig = homeRig();
    rig.open('agents', { agents: fakeAgents([readyAgent(`a-${word}`)]).port });
    await settleWork();
    rig.settle();
    rig.press('', ENTER);
    const content = rig.content();
    if (content.kind !== 'report') throw new Error('a report');
    expect(content.lines[0] ?? '').toContain('a-');
    expect(content.lines[0] ?? '').not.toMatch(gone);
  });
});
