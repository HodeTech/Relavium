/**
 * The one answer to "where is the CLI running?" ([ADR-0145](../../../../docs/decisions/0145-the-cli-has-one-surface-language.md) §7, MVP-11
 * Step 3). Seven parallel vocabularies grew up beside each other (a credential message's, the setup flow's, the `/clear` notice's, the
 * palette's, the command list's, the notice wording's, a permissions sheet's), each with its own spelling of the same places and an ad hoc
 * mapping between them; the palette's `chat` even meant the stand-alone chat while every other module said `standalone-chat`. This type
 * is the one spelling, and a module whose contract is narrower writes `Extract<Surface, …>` or `Exclude<Surface, …>` of it, so no second
 * union of these literals is spelled anywhere (`surface.test.ts` holds the source to that).
 *
 * A data module: it imports nothing from `ink`, `react` or `node:` (ADR-0145 §10), so the later extraction to a shared package is mechanical.
 */

import type { NoticeSurface } from './notice-surface.js';

/**
 * Where a piece of the CLI is running, and so which words and which remedies exist there.
 *
 * - `shell`: a scripted or plain command line, whether the output is for a person or a machine (`relavium run`, `gate`, `list`, a plain or
 *   `--json` chat). A subcommand can be named there, because the reader is at a shell.
 * - `home`: the Home, the full-screen interactive product (`relavium` with no arguments), including its landing and its setup.
 * - `home-chat`: a chat the Home hosts. It is read inside the Home, so its remedies name a way back to the Home.
 * - `standalone-chat`: `relavium chat`, a chat started on its own, with no Home around it.
 */
export type Surface = 'shell' | 'home' | 'home-chat' | 'standalone-chat';

/**
 * Whether the surface is an interactive terminal screen (the Home, either chat) rather than the shell. A remedy on such a surface names an
 * action it has (`/models`, `/providers`, `/import`), never a shell command.
 */
export function isTuiSurface(surface: Surface): surface is Exclude<Surface, 'shell'> {
  return surface !== 'shell';
}

/**
 * The wording class a notice uses on this surface ({@link NoticeSurface}): the shell's for a scripted surface, the TUI's for the Home and for
 * either chat. The one place a surface becomes a notice class, so a host never spells `'tui'` or `'shell'` for it by hand.
 */
export function noticeSurfaceOf(surface: Surface): NoticeSurface {
  return isTuiSurface(surface) ? 'tui' : 'shell';
}

/** Whether the surface is a chat: the one the Home hosts, or a stand-alone `relavium chat`. */
export function isChatSurface(
  surface: Surface,
): surface is Extract<Surface, 'home-chat' | 'standalone-chat'> {
  return surface === 'home-chat' || surface === 'standalone-chat';
}

/**
 * The surface a chat reads when it was started from `surface`. The Home's own resolver and setup speak for the Home's landing (`home`), but
 * a chat the Home hosts is `home-chat`, whose remedies name the way back to the Home; every other surface is already what its chat reads.
 */
export function chatSurfaceOf(surface: Surface): Exclude<Surface, 'home'> {
  return surface === 'home' ? 'home-chat' : surface;
}
