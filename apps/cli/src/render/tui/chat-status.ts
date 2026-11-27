import type { ReasoningEffort } from '@relavium/shared';

import { MODE_LABEL, type ChatMode } from '../../chat/chat-mode.js';
import { effortRowLabel } from '../../chat/effort-notice.js';
import { chatCostForms, contextFullnessPercent } from './chat-projection.js';
import type { SessionViewState } from './session-view-model.js';
import { statusLine, type StatusLine } from './status-line.js';

/**
 * The chat's status line, as the pure model of {@link statusLine} takes it ([ADR-0146](../../../../../docs/decisions/0146-the-home-and-the-chat-share-one-calm-layout-and-the-first-run-has-no-dead-end.md)
 * §2): `<provider> · <model> · <mode> mode[ · effort <e>] · <n> turns · <cost>[ · ctx <p>% used]`, ONE row in `columns` columns whatever the
 * state (the model gives the turns, then the context, then the cost's reasons up before it cuts a model, and below its floors the provider, the
 * model and finally the cost itself), so long as the mode and the effort fit; a terminal narrower than those two words, which the chat does not
 * support, wraps the row between words. A qualified cost is never cut into a figure without its qualifier. `provider` is the lowercase provider id
 * of the bound agent (absent where the host does not know it: the line then starts at the model). The effort reads as the picker reads it
 * (`on` for a budget model's bound tier). `leftMargin` is where the host draws the row: the chat's grid's margin (MVP-11 unit 9), 0 by default.
 */
export function chatStatusLine(
  state: SessionViewState,
  facts: {
    readonly mode: ChatMode;
    readonly reasoningEffort?: ReasoningEffort | undefined;
    readonly provider?: string | undefined;
  },
  columns: number,
  leftMargin = 0,
): StatusLine {
  const model = state.model ?? '';
  const context = contextFullnessPercent(state);
  return statusLine(
    {
      surface: 'chat',
      provider: facts.provider,
      model,
      mode: MODE_LABEL[facts.mode],
      effort:
        facts.reasoningEffort === undefined
          ? undefined
          : effortRowLabel(model, facts.reasoningEffort).label,
      turns: state.turnCount,
      cost: chatCostForms(state),
      contextPercent: context,
    },
    columns,
    leftMargin,
  );
}
