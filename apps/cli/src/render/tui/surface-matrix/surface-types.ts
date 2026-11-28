import type { ChatMount, ChatSetup } from './chat-host.js';
import type { HomeMount, HomeSetup } from './home-host.js';
import type { SurfaceBase } from './registry.js';
import type { Variant } from './variants.js';

/**
 * The entry of a surface, by the host that mounts it. The three hosts of the product:
 *
 * - `home`: the bare Home and everything it shows itself (the landing, its palette, the screens of the slot, the native cards, the pickers);
 * - `chat`: the chat the Home hosts (`relavium` then a first message), the same `ChatView` under the Home's one input owner;
 * - `standalone-chat`: `relavium chat`, `ChatApp` on its own.
 */
export interface HomeSurface extends SurfaceBase {
  readonly host: 'home';
  /** The Home this surface needs (its ports and its data). Absent ⇒ the bare, keyed, empty Home. */
  readonly setup?: HomeSetup | ((variant: Variant) => HomeSetup | Promise<HomeSetup>) | undefined;
  /** Drive keys and state until the surface is on screen. It never asserts; the matrix reads the frame afterwards. */
  readonly open: (mount: HomeMount) => Promise<void>;
}

export interface ChatSurface extends SurfaceBase {
  readonly host: 'chat' | 'standalone-chat';
  /** The session behind the chat (its ports and its store). Absent ⇒ a plain, idle chat. */
  readonly setup?: ChatSetup | ((variant: Variant) => ChatSetup | Promise<ChatSetup>) | undefined;
  readonly open: (mount: ChatMount) => Promise<void>;
}

export type Surface = HomeSurface | ChatSurface;
