// A shim, and only that: `commands/chat.test.ts` (frozen) imports `NOT_WIRED_MARK` from here, and `agent-sheet-retired.test.ts` pins this file. No production module imports it. Delete it when the frozen pin allows; the module is `chat/agent-notice.ts`.
export { NOT_WIRED_MARK } from '../../chat/agent-notice.js';
