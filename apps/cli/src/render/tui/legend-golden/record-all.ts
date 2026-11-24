// The first import is what sets chalk's level before ink is loaded (see `frames.tsx`).
import './frames.js';

import { flatten, type Golden, type Recorder } from './golden.js';
import { PRODUCERS } from './producers.js';
import { APPROVAL_RECORDERS } from './recorders/approval.js';
import { CARDS_RECORDERS } from './recorders/cards.js';
import { CHAT_MISC_RECORDERS } from './recorders/chat-misc.js';
import { HOME_HOST_RECORDERS } from './recorders/home-host.js';
import { HOME_RUN_RECORDERS } from './recorders/home-run.js';
import { INPUT_RECORDERS } from './recorders/inputs.js';
import { PROMPTS_RECORDERS } from './recorders/prompts.js';
import { SHEETS_RECORDERS } from './recorders/sheets.js';
import { TAB_HOST_RECORDERS } from './recorders/tab-host.js';

/** One recorder per producer id: the join of every group's. */
export const RECORDERS: Readonly<Record<string, Recorder>> = {
  ...INPUT_RECORDERS,
  ...CHAT_MISC_RECORDERS,
  ...HOME_RUN_RECORDERS,
  ...APPROVAL_RECORDERS,
  ...CARDS_RECORDERS,
  ...TAB_HOST_RECORDERS,
  ...SHEETS_RECORDERS,
  ...PROMPTS_RECORDERS,
  ...HOME_HOST_RECORDERS,
};

/** Every producer driven through every state it has, in registry order: what `legend.golden.json` holds. */
export async function recordAll(): Promise<Golden> {
  const golden: Record<string, Record<string, string>> = {};
  for (const producer of PRODUCERS) {
    const recorder = RECORDERS[producer.id];
    if (recorder === undefined) throw new Error(`the producer ${producer.id} has no recorder`);
    golden[producer.id] = flatten(await recorder());
  }
  return golden;
}

/** The committed file's text: two-space JSON, one key per line, a trailing newline, the way Prettier writes it. */
export function serialize(golden: Golden): string {
  return `${JSON.stringify(golden, null, 2)}\n`;
}
