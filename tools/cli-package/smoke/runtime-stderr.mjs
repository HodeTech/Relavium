/** Keep runtime warnings separate from product diagnostics without suppressing foreign stderr. */
export function projectRuntimeStderr(stderr, { runtime, pid }) {
  const warning = `(node:${pid}) ExperimentalWarning: Importing JSON modules is an experimental feature and might change at any time\n(Use \`node --trace-warnings ...\` to show where the warning was created)\n`;
  const first = stderr.indexOf(warning);
  if (
    runtime !== 'v22.0.0' ||
    !Number.isSafeInteger(pid) ||
    pid <= 0 ||
    first < 0 ||
    (first > 0 && stderr[first - 1] !== '\n') ||
    stderr.includes(warning, first + warning.length)
  )
    return { diagnostics: stderr, runtimeWarnings: [] };
  return {
    diagnostics: stderr.slice(0, first) + stderr.slice(first + warning.length),
    runtimeWarnings: ['node-22.0.0-experimental-json-modules'],
  };
}
