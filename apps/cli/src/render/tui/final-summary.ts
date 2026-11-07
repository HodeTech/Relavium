import {
  formatReportedCost,
  formatDuration,
  formatProducedMedia,
  formatTokens,
  statusGlyph,
} from './format.js';
import { nodeSuffix } from './projection.js';
import type { RunViewState } from './run-view-model.js';
import { resumeCommandBase } from '../../gate/budget.js';
import { formatRunOutputs } from '../run-outputs.js';
import { sanitizeInline, sanitizeUntrustedInline } from '../sanitize.js';

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
        const code =
          summary.errorCode === undefined ? '' : ` (${sanitizeInline(summary.errorCode)})`;
        return `run failed${code}`;
      }
      case 'cancelled':
        return 'run cancelled';
      case 'paused': {
        const gates =
          summary.pausedGateIds === undefined || summary.pausedGateIds.length === 0
            ? ''
            : ` at gate ${summary.pausedGateIds.map(sanitizeInline).join(', ')}`;
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
    `cost ${formatReportedCost(summary?.totalCostMicrocents ?? state.cumulativeCostMicrocents, state.usageCoverage, state.unpricedCalls)}`,
  );
  if (summary?.totalTokens !== undefined) {
    meta.push(formatTokens(summary.totalTokens));
  }
  lines.push(meta.join(' · '));

  // The run id `logs`, `status` and `gate` accept (MVP-A2), with the command that continues from here.
  if (state.runId !== undefined) {
    lines.push(...continuationLines(state, state.runId));
  }

  if (summary?.errorMessage !== undefined) {
    // A summary error occupies ONE structural row. Collapse line/column separators as well as terminal
    // controls, so provider/model text cannot forge a believable node-status row beneath the headline.
    // It is untrusted text (a provider or tool diagnostic), so its secret shapes are masked first.
    lines.push(`  ${sanitizeUntrustedInline(summary.errorMessage)}`);
  }

  for (const id of state.nodeOrder) {
    const node = state.nodes[id];
    if (node === undefined) {
      continue;
    }
    // Reuse the live view's suffix logic (one source of truth) — completed→duration, failed→error code, etc.
    lines.push(
      `  ${statusGlyph(node.status)} ${sanitizeInline(id)}${sanitizeInline(nodeSuffix(node))}`,
    );
  }

  // The run's media deliverables — the durable handle per produced artifact (never bytes), attributed to its
  // node, so they survive in the scrollback after the live frames clear (the cross-surface handle acceptance).
  if (state.producedMedia.length > 0) {
    lines.push('  produced media:');
    for (const media of state.producedMedia) {
      lines.push(
        `    ${sanitizeInline(formatProducedMedia(media))} (${sanitizeInline(media.nodeId)})`,
      );
    }
  }

  // The workflow's outputs (MVP-A1) — bounded and sanitized by the shared formatter, last so they read as the
  // run's result rather than as one more node row.
  if (summary?.outcome === 'completed' && summary.outputs !== undefined) {
    lines.push(...formatRunOutputs(summary.outputs, '  ', state.runId));
  }

  return `${lines.join('\n')}\n`;
}

/**
 * The run id line, with the command that continues from the outcome: `relavium logs` for a run that ended, and for a
 * paused run the command for what it is parked on — `relavium gate` for a human gate, `relavium budget resume` for a
 * budget gate (which `gate` declines), and `relavium status` for a run parked on a media job only.
 *
 * A gate is classified only from what THIS stream announced. A resumed run (`relavium gate`, `budget resume`) re-parks
 * on the gates its engine restored from the checkpoint without announcing them again, so such a gate could be either
 * kind; `relavium status` reads the whole log and prints the command for each one.
 */
function continuationLines(state: RunViewState, runId: string): string[] {
  const id = sanitizeInline(runId);
  if (state.summary?.outcome !== 'paused') {
    return [`  run id ${id} — replay with \`relavium logs ${id}\``];
  }
  const parked = state.summary.pausedGateIds ?? [];
  const budgetGates = new Set(
    state.pendingBudgetNotices.filter((gate) => gate.runId === runId).map((gate) => gate.gateId),
  );
  const humanGates = new Set(
    state.pendingHumanGates.filter((gate) => gate.runId === runId).map((gate) => gate.gateId),
  );
  const lines: string[] = [];
  if (parked.some((gateId) => humanGates.has(gateId))) {
    lines.push(`  run id ${id} — resume with \`relavium gate ${id}\``);
  }
  for (const gateId of parked.filter((parkedId) => budgetGates.has(parkedId))) {
    // The same shell-inert check the plain renderer and `status` apply before printing a copyable command.
    const command = resumeCommandBase('budget', runId, gateId);
    lines.push(
      command === undefined
        ? `  run id ${id} — a budget gate is waiting: \`relavium status ${id}\` shows how to approve or abort it`
        : `  run id ${id} — approve or abort the budget gate with \`${command}\` (\`relavium status ${id}\` shows the amount)`,
    );
  }
  if (parked.some((gateId) => !humanGates.has(gateId) && !budgetGates.has(gateId))) {
    lines.push(
      `  run id ${id} — \`relavium status ${id}\` shows each gate it is parked on and the command that continues it`,
    );
  } else if (lines.length === 0) {
    lines.push(`  run id ${id} — check it with \`relavium status ${id}\``);
  }
  return lines;
}
