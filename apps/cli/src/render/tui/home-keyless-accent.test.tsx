import './force-color.js';

import { render } from 'ink-testing-library';
import { describe, expect, it } from 'vitest';

import { HomeView } from './home-view.js';

/**
 * The keyless call to action is the accent colour and not dim (MVP-11 Step 2.4, ADR-0146 §5): it must not read like a footnote. The hint
 * under the prompt stays dim. `./force-color.js` comes first so that chalk emits the sequences the frame is read from.
 */
const CYAN = '\x1b[36m';
const DIM = '\x1b[2m';
const LINE = 'No provider key yet · Enter to connect · /providers';

function rowOf(color: boolean, needle: string): string {
  const view = render(
    <HomeView
      snapshot={{
        attention: { gates: [], failedRuns: [] },
        recentSessions: [],
        recentRuns: [],
        recentAgents: [],
        unreadableRunIds: [],
        isEmpty: true,
      }}
      editor={{ text: '', cursor: 0 }}
      nowMs={0}
      cols={80}
      rows={24}
      color={color}
      keyless
    />,
  );
  const frame = view.lastFrame() ?? '';
  view.unmount();
  const row = frame.split('\n').find((line) => line.includes(needle));
  if (row === undefined) throw new Error(`no row with "${needle}" in:\n${frame}`);
  return row;
}

describe('the keyless line colour', () => {
  it('is cyan, the accent, and not dim, with colour on', () => {
    const row = rowOf(true, LINE);
    expect(row).toContain(`${CYAN}${LINE}`);
    expect(row).not.toContain(DIM);
  });

  it('is plain words with colour off: no colour and no dim sequence', () => {
    const row = rowOf(false, LINE);
    expect(row).toContain(LINE);
    expect(row).not.toContain(CYAN);
    expect(row).not.toContain(DIM);
  });

  it('leaves the hint under the prompt dim, so the call to action is the louder of the two', () => {
    const hint = rowOf(true, 'Enter to connect a provider');
    expect(hint).toContain(DIM);
    expect(hint).not.toContain(CYAN);
  });
});
