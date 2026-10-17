// Fixed inventory shared with CI aggregation. A missing case is never a skipped pass.
export const REQUIRED_SMOKE_CASES = Object.freeze([
  'native-addon-load-only',
  'installed-version',
  'workflow-gate-budget-effects',
  'real-sdk-chat-persistence-resume',
  'actual-mcp-initialize-version',
  'actual-media-cas-iterator-cleanup',
  'actual-native-process-owner',
  'actual-native-bootstrap-lifecycle',
]);
