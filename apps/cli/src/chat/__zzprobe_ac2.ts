import type { SessionStore } from '@relavium/db';
export type Turn = Parameters<SessionStore['writeTurn']>[0];
export const build = (t: Turn): Turn => t;
