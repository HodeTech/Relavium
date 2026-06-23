import { formatCostUsd, formatDuration, formatTokens, statusGlyph } from './format.js';
import { nodeSuffix } from './projection.js';
import type { RunViewState } from './run-view-model.js';

/**
 * Render the **persistent** final summary the `ink` renderer writes after it unmounts (workstream **2.E**).
 * The live `ink` frames are ephemeral (re-painted in place); this plain-text block is written once to
 * stdout after unmount so it survives in the terminal scrollback. Pure (no `ink`/React) so it is unit-tested
 * directly. Plain text by design — no ANSI — so it reads correctly under `--no-color` and in a captured log.
 */
export function renderFinalSummary(state: RunViewState): string {
  const summary = state.summary;
  const lines: string[] = [];

  const headline = ((): string => {
    switch (summary?.outcome) {
      case 'completed':
        return 'run completed';
      case 'failed': {
        const code = summary.errorCode === undefined ? '' : ` (${summary.errorCode})`;
        return `run failed${code}`;
      }
      case 'cancelled':
        return 'run cancelled';
      case 'paused': {
        const gates =
          summary.pausedGateIds === undefined || summary.pausedGateIds.length === 0
            ? ''
            : ` at gate ${summary.pausedGateIds.join(', ')}`;
        return `run paused${gates}`;
      }
      default:
        return 'run ended';
    }
  })();

  const meta = [headline];
  if (summary?.durationMs !== undefined) {
    meta.push(formatDuration(summary.durationMs));
  }
  meta.push(
    `cost ${formatCostUsd(summary?.totalCostMicrocents ?? state.cumulativeCostMicrocents)}`,
  );
  if (summary?.totalTokens !== undefined) {
    meta.push(formatTokens(summary.totalTokens));
  }
  lines.push(meta.join(' · '));

  if (summary?.errorMessage !== undefined) {
    lines.push(`  ${summary.errorMessage}`);
  }

  for (const id of state.nodeOrder) {
    const node = state.nodes[id];
    if (node === undefined) {
      continue;
    }
    // Reuse the live view's suffix logic (one source of truth) — completed→duration, failed→error code, etc.
    lines.push(`  ${statusGlyph(node.status)} ${id}${nodeSuffix(node)}`);
  }

  return `${lines.join('\n')}\n`;
}
