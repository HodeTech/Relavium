import type { CliIo } from './io.js';

/** Owned resource labels only: native failures may contain paths, credentials or hostile text. */
type ResourceLabel = 'session store' | 'history database' | 'effect journal' | 'persister' | 'MCP';

/** A secondary cleanup failure cannot replace the command result or prevent remaining teardown. */
export function warnTeardown(io: Pick<CliIo, 'writeErr'>, label: ResourceLabel): void {
  try {
    io.writeErr(`warning: ${label} teardown failed\n`);
  } catch {
    // The diagnostic sink has failed too. Preserve the primary outcome; never retry on stdout.
  }
}

/** Synchronous best-effort close, called only after the resource owner's real lifetime joins. */
export function closeQuietly(
  io: Pick<CliIo, 'writeErr'>,
  label: ResourceLabel,
  close: () => void,
): void {
  try {
    close();
  } catch {
    warnTeardown(io, label);
  }
}
