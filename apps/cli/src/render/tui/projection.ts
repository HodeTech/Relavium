import { formatDuration, type StatusColor } from './format.js';
import type { NodeView } from './run-view-model.js';

/**
 * Pure projection helpers for the `ink` `RunApp` component (workstream **2.E**) — extracted so the small
 * amount of branching the view does (the trailing suffix per node status; the color-prop omission under
 * `--no-color`) is unit-tested without React (ADR-0047 "framework-free cores").
 */

/**
 * The `color` prop for an `ink` `<Text>` — present only when color output is enabled (else omitted, so no
 * ANSI). Returned as a spreadable object rather than `color={undefined}` to satisfy
 * `exactOptionalPropertyTypes` (an optional prop may be absent, never explicitly `undefined`).
 */
export function colorProps(enabled: boolean, c: StatusColor): { color?: StatusColor } {
  return enabled ? { color: c } : {};
}

/**
 * The `dimColor` prop for an `ink` `<Text>` — `dimColor` is itself an ANSI SGR code (`ESC[2m`), so it is
 * gated on the same `color` flag: under `--no-color` it is omitted, so NO color/dim ANSI is emitted (the
 * documented contract). Spreadable (never explicit `undefined`) for `exactOptionalPropertyTypes`.
 */
export function dimProps(enabled: boolean): { dimColor?: true } {
  return enabled ? { dimColor: true } : {};
}

/** The trailing detail shown after a node's id: duration when completed, the error code when failed, etc. */
export function nodeSuffix(node: NodeView): string {
  if (node.status === 'completed' && node.durationMs !== undefined) {
    return ` (${formatDuration(node.durationMs)})`;
  }
  if (node.status === 'failed' && node.errorCode !== undefined) {
    return ` — ${node.errorCode}`;
  }
  if (node.status === 'retrying' && node.attempt !== undefined) {
    return ` (retry ${node.attempt})`;
  }
  return '';
}
