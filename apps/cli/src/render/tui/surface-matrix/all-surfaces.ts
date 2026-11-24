import type { Surface } from './surface-types.js';
import { CHAT_SURFACES } from './surfaces-chat.js';
import { HOME_SURFACES } from './surfaces-home.js';

export const ALL_SURFACES: readonly Surface[] = [...HOME_SURFACES, ...CHAT_SURFACES];
