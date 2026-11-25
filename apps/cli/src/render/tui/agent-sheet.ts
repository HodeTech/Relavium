// A shim, and only that: `commands/chat.test.ts` (frozen) imports `NOT_WIRED_MARK` from here and `commands/chat.ts` imports `agentNotice`. Delete it when those pins allow; the module is `chat/agent-notice.ts`.
export { agentNotice, NOT_WIRED_MARK } from '../../chat/agent-notice.js';
