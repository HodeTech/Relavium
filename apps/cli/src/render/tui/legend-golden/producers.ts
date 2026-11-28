import type { Producer } from './golden.js';
import { APPROVAL_PRODUCERS } from './recorders/approval.js';
import { CARDS_PRODUCERS } from './recorders/cards.js';
import { CHAT_MISC_PRODUCERS } from './recorders/chat-misc.js';
import { HOME_HOST_PRODUCERS } from './recorders/home-host.js';
import { HOME_RUN_PRODUCERS } from './recorders/home-run.js';
import { HOME_POPUPS_PRODUCERS } from './recorders/home-popups.js';
import { INPUT_PRODUCERS } from './recorders/inputs.js';
import { PROMPTS_PRODUCERS } from './recorders/prompts.js';
import { SHEETS_PRODUCERS } from './recorders/sheets.js';
import { TAB_HOST_PRODUCERS } from './recorders/tab-host.js';
import { POPUP_PRODUCERS } from './recorders/popups.js';
import { PROJECT_FLOWS_PRODUCERS } from './recorders/project-flows.js';
import { RESUME_RUN_PRODUCERS } from './recorders/resume-run.js';
import { PROVIDERS_FLOW_PRODUCERS } from './recorders/providers-flow.js';

/**
 * Every producer of a key legend, a hint line, a footer hint or a sentence that names a key
 * ([ADR-0145](../../../../../../docs/decisions/0145-the-cli-has-one-surface-language.md) §3): where it lives and what it says. The
 * list is data; the recorder of each `id` (`record-all.ts`) drives it through the states that change its words, and the completeness
 * guard (`legend-completeness.test.ts`) fails when a production file writes a hint-shaped string that none of these covers.
 */
export const PRODUCERS: readonly Producer[] = [
  ...INPUT_PRODUCERS,
  ...CHAT_MISC_PRODUCERS,
  ...HOME_RUN_PRODUCERS,
  ...APPROVAL_PRODUCERS,
  ...CARDS_PRODUCERS,
  ...TAB_HOST_PRODUCERS,
  ...SHEETS_PRODUCERS,
  ...PROMPTS_PRODUCERS,
  ...HOME_HOST_PRODUCERS,
  ...POPUP_PRODUCERS,
  ...HOME_POPUPS_PRODUCERS,
  ...RESUME_RUN_PRODUCERS,
  ...PROJECT_FLOWS_PRODUCERS,
  ...PROVIDERS_FLOW_PRODUCERS,
];
