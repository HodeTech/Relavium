import type { ToolHostCallOptions } from '@relavium/core';
import type {
  Transport,
  TransportSendOptions,
} from '@modelcontextprotocol/sdk/shared/transport.js';
import {
  JSONRPCMessageSchema,
  CancelledNotificationSchema,
  isJSONRPCRequest,
  isJSONRPCNotification,
  isJSONRPCResultResponse,
  isJSONRPCErrorResponse,
  type JSONRPCMessage,
  type JSONRPCResponse,
  type RequestId,
} from '@modelcontextprotocol/sdk/types.js';
import { McpLifetimeError, McpWorkScope } from './work-scope.js';
import type { McpFetch } from './sdk-http.js';

/** SDK-fenced delegation only: the actual transport and protocol remain the installed SDK's. */
type Target = Omit<Transport, 'sessionId'> & { readonly sessionId?: string | undefined };

/** Preserve the runtime target and receiver while narrowing the SDK's optional getter type. */
function sdkTransportView(value: Pick<Transport, 'start' | 'send' | 'close'>): Transport {
  return value;
}
export interface SdkLaneLifetime {
  readonly work: McpWorkScope;
  readonly signal: AbortSignal;
  readonly retired: boolean;
  assertActive(): void;
}
export type SdkLaneFactory = (lifetime: SdkLaneLifetime) => Target;

/** Only stdio/WebSocket SDK callbacks denote the actual native resource close. */
export interface SdkNativeClose {
  readonly onStartEntered?: () => void;
  readonly onAcknowledged?: () => void;
}

class RequestLane implements SdkLaneLifetime {
  readonly work: McpWorkScope;
  readonly #controller = new AbortController();
  readonly #target: Target;
  readonly #started: Promise<void>;
  readonly #onCleanupError: (error: unknown) => void;
  #retired = false;

  constructor(
    parent: McpWorkScope,
    factory: SdkLaneFactory,
    protocolVersion: string | undefined,
    onmessage: NonNullable<Transport['onmessage']>,
    onerror: NonNullable<Transport['onerror']>,
    onCleanupError: (error: unknown) => void,
  ) {
    this.work = parent.fork();
    this.#onCleanupError = onCleanupError;
    let target: Target | undefined;
    try {
      this.#target = target = factory(this);
      if (protocolVersion !== undefined) this.#target.setProtocolVersion?.(protocolVersion);
      this.#target.onmessage = (message, extra) => {
        if (!this.#retired) onmessage(message, extra);
      };
      this.#target.onerror = (error) => {
        if (!this.#retired) onerror(error);
      };
      // A lane's close never closes the shared SDK Client or other requests.
      this.#started = this.work.retainWork(() => this.#target.start());
    } catch (error) {
      this.#retired = true;
      this.#controller.abort();
      // Factory success already transfers the target, even if configuration/start entry fails.
      // Keep its exact cleanup owed without replacing the original entry refusal.
      if (target !== undefined) this.#closeTarget(target);
      this.work.seal();
      throw error;
    }
  }

  get signal(): AbortSignal {
    return this.#controller.signal;
  }
  get retired(): boolean {
    return this.#retired;
  }
  assertActive(): void {
    if (this.#retired) throw new McpLifetimeError('retired');
    this.work.assertActive();
  }
  send(message: JSONRPCMessage, options?: TransportSendOptions): Promise<void> {
    this.assertActive();
    return this.work.retainWork(async () => {
      await this.#started;
      this.assertActive();
      return this.work.retainWork(() => this.#target.send(message, options));
    });
  }
  retire(): void {
    if (this.#retired) return;
    this.#retired = true;
    this.#controller.abort();
    try {
      this.#closeTarget(this.#target);
    } finally {
      this.work.seal();
    }
  }
  #closeTarget(target: Target): void {
    try {
      const raw = this.work.retainWork(() => target.close());
      void raw.catch(this.#onCleanupError);
    } catch (error) {
      this.#onCleanupError(error);
    }
  }
}

/** One base-transport send; its fetch closure survives public request settlement. */
class BaseSendWork implements SdkLaneLifetime {
  readonly work: McpWorkScope;
  readonly #controller = new AbortController();
  #retired = false;
  constructor(parent: McpWorkScope) {
    this.work = parent.fork();
  }
  get signal(): AbortSignal {
    return this.#controller.signal;
  }
  get retired(): boolean {
    return this.#retired;
  }
  assertActive(): void {
    if (this.#retired) throw new McpLifetimeError('retired');
    this.work.assertActive();
  }
  retire(): void {
    if (this.#retired) return;
    this.#retired = true;
    this.#controller.abort();
    this.work.seal();
  }
}

/** One already-admitted request; ordinary entry retires before independent control cleanup. */
class RequestWork {
  readonly work: McpWorkScope;
  readonly ids = new Set<RequestId>();
  readonly controls = new Set<RequestLane>();
  readonly baseSends = new Set<BaseSendWork>();
  readonly ordinaryBaseSends = new Set<BaseSendWork>();
  lane: RequestLane | undefined;
  retired = false;

  constructor(options: ToolHostCallOptions | undefined) {
    this.work = new McpWorkScope(options);
  }
  retire(): void {
    if (this.retired) return;
    this.retired = true;
    this.lane?.retire();
    for (const send of this.ordinaryBaseSends) send.retire();
  }
  finish(): void {
    this.retire();
    this.work.seal();
  }
  close(): void {
    this.retire();
    for (const lane of this.controls) lane.retire();
    for (const send of this.baseSends) send.retire();
  }
}

class ServerReplyWork {
  readonly work: McpWorkScope;
  readonly state: RequestWork | undefined;
  #activate: () => void = () => {};
  #stop: () => void = () => {};
  #entered = false;
  #responseEntered = false;
  #retired = false;

  constructor(parent: McpWorkScope, state: RequestWork | undefined) {
    this.work = parent.fork();
    this.state = state;
    // The SDK queues the handler after delivery. Reserve its future entry before
    // exposing the message; cancellation may revoke an entry that never begins.
    const activation = new Promise<void>((resolve) => {
      this.#activate = resolve;
    });
    void this.work.retainWork(() => activation);
  }

  run<T>(signal: AbortSignal, factory: () => Promise<T>): Promise<T> {
    if (this.#entered) return Promise.reject(new McpLifetimeError('duplicate_entry'));
    this.#entered = true;
    if (this.#retired || signal.aborted) {
      this.retire();
      this.#activate();
      this.work.seal();
      return Promise.reject(new McpLifetimeError('retired'));
    }
    const onAbort = (): void => this.retire();
    signal.addEventListener('abort', onAbort, { once: true });
    this.#stop = () => signal.removeEventListener('abort', onAbort);
    try {
      return this.work.retainWork(factory);
    } catch (error) {
      // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- preserve an opaque original refusal without reflection
      return Promise.reject(error);
    } finally {
      this.#activate();
    }
  }

  claimResponse(): void {
    if (this.#responseEntered) throw new McpLifetimeError('duplicate_entry');
    this.#responseEntered = true;
  }

  responded(): void {
    // The SDK can reject schema/task admission before calling a registered handler.
    // Its actual response entry proves that no handler factory remains to enter.
    this.#activate();
    this.#stop();
    this.work.seal();
  }

  cancelQueued(): void {
    // An entered handler already observes the SDK's actual signal. Retiring it before
    // that queued abort could release its ID before the SDK aborts the old controller.
    if (!this.#entered && !this.#responseEntered) this.retire();
  }

  retire(): void {
    if (this.#retired) return;
    this.#retired = true;
    // Revoke future factory entry. SDK task/schema refusal can bypass run(), and
    // cancellation then suppresses its response. No actual producer exists in this
    // empty reservation; already-entered handlers/sends retain independent slots.
    if (!this.#entered) this.#activate();
    this.#stop();
    this.work.seal();
  }
}

export interface SdkRequestInvocation<T> {
  readonly raw: Promise<T>;
  retire(): void;
}

/**
 * One initialized SDK Client/session with synchronous local request construction frames.
 * Frames NEVER survive an await; incoming server IDs cannot mint outgoing request authority.
 */
export class SdkTransportOwner {
  onclose?: Transport['onclose'];
  onerror?: Transport['onerror'];
  onmessage?: Transport['onmessage'];
  readonly work: McpWorkScope;
  readonly #base: Target;
  readonly #laneFactory: SdkLaneFactory | undefined;
  readonly #requests = new Map<RequestId, RequestWork>();
  readonly #live = new Set<RequestWork>();
  readonly #baseSends = new Map<string, BaseSendWork>();
  readonly #serverReplies = new Map<RequestId, ServerReplyWork>();
  #frame: RequestWork | undefined;
  #protocolVersion: string | undefined;
  #closed = false;
  #closing: Promise<void> | undefined;
  #startEntered = false;
  #nativeErrorSeen = false;
  #nativeAcknowledge: (() => void) | undefined;
  #cleanupFault: { readonly error: unknown } | undefined;
  readonly #nativeClose: SdkNativeClose | undefined;

  constructor(
    base: Target,
    work = new McpWorkScope(),
    laneFactory?: SdkLaneFactory,
    nativeClose?: SdkNativeClose,
  ) {
    this.#base = base;
    this.work = work;
    this.#laneFactory = laneFactory;
    this.#nativeClose = nativeClose;
    if (nativeClose !== undefined) {
      const closed = new Promise<void>((resolve) => {
        this.#nativeAcknowledge = resolve;
      });
      void this.work.retainWork(() => closed);
    }
    const previousClose = base.onclose;
    const previousError = base.onerror;
    const previousMessage = base.onmessage;
    base.onclose = () => {
      for (const reply of this.#serverReplies.values()) reply.retire();
      this.#acknowledgeNativeClose();
      previousClose?.();
      this.onclose?.();
    };
    base.onerror = (error) => {
      this.#nativeErrorSeen = true;
      if (this.#closed) return;
      previousError?.(error);
      this.onerror?.(error);
    };
    base.onmessage = (message, extra) => {
      if (this.#closed) return;
      previousMessage?.(message, extra);
      if (!this.#observeServerMessage(message, 'infrastructure')) return;
      this.onmessage?.(message, extra);
    };
  }

  /** Same runtime object, narrowed only to bypass the SDK optional-session getter inconsistency. */
  get transport(): Transport {
    return sdkTransportView(this);
  }
  get sessionId(): string | undefined {
    return this.#base.sessionId;
  }
  get retired(): boolean {
    return this.#closed;
  }
  get nativeCloseAcknowledged(): boolean {
    return this.#nativeClose !== undefined && this.#nativeAcknowledge === undefined;
  }
  setProtocolVersion(version: string): void {
    this.#protocolVersion = version;
    this.#base.setProtocolVersion?.(version);
  }
  start(): Promise<void> {
    this.#assertOpen();
    this.#startEntered = true;
    let raw: Promise<void>;
    try {
      raw = this.work.retainWork(() => this.#base.start());
    } catch (error) {
      // The installed native transports throw synchronously only before native construction.
      this.#acknowledgeNativeClose();
      throw error;
    }
    this.#nativeClose?.onStartEntered?.();
    void raw.catch(() => {
      // In SDK 1.29, async spawn/socket failure invokes onerror before rejecting start.
      // Rejection with no native error callback instead proves constructor/start entry failed
      // before a native resource existed. A native error always still owes actual onclose.
      if (!this.#nativeErrorSeen) this.#acknowledgeNativeClose();
    });
    return raw;
  }

  invoke<T>(
    options: ToolHostCallOptions | undefined,
    send: () => Promise<T>,
  ): SdkRequestInvocation<T> {
    this.#assertOpen();
    const state = new RequestWork(options);
    // A synchronous host transfer may itself retire the manager. Close the still-empty
    // transferred scope on refusal rather than leaving an unentered lifetime owed forever.
    try {
      this.#assertOpen();
      // A manager also retains standalone discovery/calls without an optional engine owner.
      void this.work.retainWork(() => state.work.done);
    } catch (error) {
      state.finish();
      throw error;
    }
    this.#live.add(state);
    void state.work.done.then(() => {
      this.#live.delete(state);
      for (const id of state.ids) this.#requests.delete(id);
      for (const [id, owner] of this.#serverReplies) {
        if (owner.state === state) {
          this.#serverReplies.delete(id);
        }
      }
    });
    let raw: Promise<T>;
    try {
      raw = state.work.retainWork(() => {
        const previous = this.#frame;
        this.#frame = state;
        try {
          return send();
        } finally {
          this.#frame = previous;
        }
      });
    } catch (error) {
      state.finish();
      throw error;
    }
    void raw.then(
      () => state.finish(),
      () => state.finish(),
    );
    return { raw, retire: () => state.retire() };
  }

  send(message: JSONRPCMessage, options?: TransportSendOptions): Promise<void> {
    try {
      if (this.#closed) this.#acknowledgeLateResponse(message);
      this.#assertOpen();
      if (isJSONRPCRequest(message) && this.#frame !== undefined) {
        return this.#sendRequest(this.#frame, message, options);
      }
      if (isJSONRPCNotification(message) && message.method === 'notifications/cancelled') {
        const id = message.params?.['requestId'];
        if (typeof id !== 'string' && typeof id !== 'number') throw new McpLifetimeError('unowned');
        const state = this.#requests.get(id);
        if (state === undefined) throw new McpLifetimeError('unowned');
        return this.#sendControl(state, message, options);
      }
      if (isJSONRPCResultResponse(message) || isJSONRPCErrorResponse(message)) {
        return this.#sendResponse(message, options);
      }
      // Only the initial SDK handshake is unscoped manager infrastructure.
      if (
        (isJSONRPCRequest(message) && message.method === 'initialize') ||
        (isJSONRPCNotification(message) && message.method === 'notifications/initialized')
      )
        return this.#sendBase(this.work, message, options);
      throw new McpLifetimeError('unowned');
    } catch (error) {
      // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- preserve an opaque original refusal without reflection
      return Promise.reject(error);
    }
  }

  #acknowledgeLateResponse(message: JSONRPCMessage): void {
    if (
      (isJSONRPCResultResponse(message) || isJSONRPCErrorResponse(message)) &&
      (typeof message.id === 'string' || typeof message.id === 'number')
    ) {
      this.#serverReplies.get(message.id)?.responded();
    }
  }

  #sendResponse(message: JSONRPCResponse, options?: TransportSendOptions): Promise<void> {
    const id = message.id;
    if (typeof id !== 'string' && typeof id !== 'number') throw new McpLifetimeError('unreadable');
    const owner = this.#serverReplies.get(id);
    if (owner === undefined) throw new McpLifetimeError('unowned');
    owner.claimResponse();
    try {
      return owner.state === undefined || this.#laneFactory === undefined
        ? this.#sendBase(owner.work, message, options, owner.state)
        : this.#sendLaneControl(owner.state, owner.work, message, options);
    } finally {
      owner.responded();
    }
  }

  #sendRequest(
    state: RequestWork,
    message: JSONRPCMessage & { id: RequestId },
    options?: TransportSendOptions,
  ): Promise<void> {
    if (state.retired || this.#requests.has(message.id)) throw new McpLifetimeError('retired');
    this.#requests.set(message.id, state);
    state.ids.add(message.id);
    if (this.#laneFactory === undefined)
      return this.#sendBase(state.work, message, options, state, true);
    state.lane = this.#newLane(state);
    return state.lane.send(message, options);
  }

  #sendControl(
    state: RequestWork,
    message: JSONRPCMessage,
    options?: TransportSendOptions,
  ): Promise<void> {
    if (this.#laneFactory === undefined) return this.#sendBase(state.work, message, options, state);
    return this.#sendLaneControl(state, state.work, message, options);
  }

  /** Bind legacy SDK POSTs by trusted SDK envelope IDs, never by nested tool arguments. */
  legacyFetch(fetcher: McpFetch, url: string | URL, init?: RequestInit): Promise<Response> {
    this.#assertOpen();
    if (init?.method?.toUpperCase() !== 'POST') {
      return this.work.retainWork(() => fetcher(url, init, { retainWork: this.work.retainWork }));
    }
    if (typeof init.body !== 'string') throw new McpLifetimeError('unreadable');
    let message: JSONRPCMessage;
    try {
      message = JSONRPCMessageSchema.parse(JSON.parse(init.body));
    } catch {
      throw new McpLifetimeError('unreadable');
    }
    const send = this.#baseSends.get(this.#sendKey(message));
    if (send === undefined) throw new McpLifetimeError('unowned');
    send.assertActive();
    return send.work.retainWork(() =>
      fetcher(url, init, {
        retainWork: send.work.retainWork,
        signal: send.signal,
      }),
    );
  }

  #sendBase(
    parent: McpWorkScope,
    message: JSONRPCMessage,
    options?: TransportSendOptions,
    state?: RequestWork,
    ordinary = false,
  ): Promise<void> {
    const key = this.#sendKey(message);
    if (this.#baseSends.has(key)) throw new McpLifetimeError('ambiguous');
    const send = new BaseSendWork(parent);
    this.#baseSends.set(key, send);
    state?.baseSends.add(send);
    if (ordinary) state?.ordinaryBaseSends.add(send);
    void send.work.done.then(() => {
      if (this.#baseSends.get(key) === send) this.#baseSends.delete(key);
      state?.baseSends.delete(send);
      state?.ordinaryBaseSends.delete(send);
    });
    let raw: Promise<void>;
    try {
      raw = send.work.retainWork(() => this.#base.send(message, options));
    } catch (error) {
      send.retire();
      throw error;
    }
    void raw.then(
      () => send.retire(),
      () => send.retire(),
    );
    return raw;
  }

  #sendKey(message: JSONRPCMessage): string {
    if (isJSONRPCRequest(message)) return JSON.stringify(['request', message.id]);
    if (isJSONRPCResultResponse(message) || isJSONRPCErrorResponse(message))
      return JSON.stringify(['response', message.id]);
    if (message.method === 'notifications/cancelled') {
      const id = message.params?.['requestId'];
      if (typeof id === 'string' || typeof id === 'number') return JSON.stringify(['cancel', id]);
    }
    if (message.method === 'notifications/initialized') return 'initialized';
    throw new McpLifetimeError('unowned');
  }

  #sendLaneControl(
    state: RequestWork,
    parent: McpWorkScope,
    message: JSONRPCMessage,
    options?: TransportSendOptions,
  ): Promise<void> {
    const lane = this.#newLane(state, parent);
    state.controls.add(lane);
    let raw: Promise<void>;
    try {
      raw = lane.send(message, options);
    } catch (error) {
      lane.retire();
      throw error;
    }
    void raw.then(
      () => lane.retire(),
      () => lane.retire(),
    );
    return raw;
  }

  #newLane(state: RequestWork, parent = state.work): RequestLane {
    const factory = this.#laneFactory;
    if (factory === undefined) throw new McpLifetimeError('unavailable');
    return new RequestLane(
      parent,
      factory,
      this.#protocolVersion,
      (message, extra) => {
        if (this.#closed || state.retired) return;
        if (!this.#observeServerMessage(message, state)) return;
        this.onmessage?.(message, extra);
      },
      (error) => this.onerror?.(error),
      (error) => {
        this.#cleanupFault ??= { error };
      },
    );
  }
  #observeServerMessage(message: JSONRPCMessage, owner: RequestWork | 'infrastructure'): boolean {
    if (isJSONRPCRequest(message)) {
      return this.#associateServerRequest(message.id, owner);
    }
    if (!isJSONRPCNotification(message) || message.method !== 'notifications/cancelled')
      return true;
    const cancellation = CancelledNotificationSchema.safeParse(message);
    if (!cancellation.success) return true;
    const id = cancellation.data.params.requestId;
    // SDK 1.29 ignores zero/empty IDs in _oncancel; its parser rejects malformed
    // notifications. Never revoke an entry that the installed protocol will continue.
    if (id === undefined || id === 0 || id === '') return true;
    this.#serverReplies.get(id)?.cancelQueued();
    return true;
  }

  #associateServerRequest(id: RequestId, owner: RequestWork | 'infrastructure'): boolean {
    if (this.#serverReplies.has(id)) {
      // Native WebSocket callbacks do not catch delivery errors. Refuse this message through the
      // normal protocol error channel without escaping its callback or replacing the live owner.
      this.onerror?.(new McpLifetimeError('ambiguous'));
      return false;
    }
    const state = owner === 'infrastructure' ? undefined : owner;
    // Admit the protocol handler BEFORE exposing an incoming request to the SDK.
    // Its reply can still owe work after the original tools/call has settled.
    const reply = new ServerReplyWork(state?.work ?? this.work, state);
    this.#serverReplies.set(id, reply);
    void reply.work.done.then(() => {
      if (this.#serverReplies.get(id) === reply) this.#serverReplies.delete(id);
    });
    return true;
  }
  handleServerRequest<T>(
    id: RequestId,
    signal: AbortSignal,
    factory: () => Promise<T>,
  ): Promise<T> {
    // A queued callback from an already-cancelled request must not claim or retire
    // a later reservation which legitimately reuses that peer ID.
    if (signal.aborted) return Promise.reject(new McpLifetimeError('retired'));
    const reply = this.#serverReplies.get(id);
    if (reply === undefined) return Promise.reject(new McpLifetimeError('unowned'));
    return reply.run(signal, factory);
  }
  #assertOpen(): void {
    if (this.#closed) throw new McpLifetimeError('closed');
  }
  #acknowledgeNativeClose(): void {
    const acknowledge = this.#nativeAcknowledge;
    if (acknowledge === undefined) return;
    this.#nativeAcknowledge = undefined;
    acknowledge();
    this.#nativeClose?.onAcknowledged?.();
  }
  close(): Promise<void> {
    if (this.#closing !== undefined) return this.#closing;
    let complete: () => void = () => {};
    let fail: (error: unknown) => void = () => {};
    const closing = new Promise<void>((resolve, reject) => {
      complete = resolve;
      fail = reject;
    });
    // Publish the exact join before any transport callback can reenter close.
    this.#closing = closing;
    void this.#closeOnce().then(complete, fail);
    return closing;
  }

  async #closeOnce(): Promise<void> {
    this.#closed = true;
    if (!this.#startEntered) this.#acknowledgeNativeClose();
    for (const state of this.#live) state.close();
    for (const send of this.#baseSends.values()) send.retire();
    for (const reply of this.#serverReplies.values()) reply.retire();
    let raw: Promise<void>;
    try {
      raw = this.work.retainWork(() => this.#base.close());
    } catch (error) {
      // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- close faults are opaque and must retain their original identity
      raw = Promise.reject(error);
    } finally {
      this.work.seal();
    }
    let fault: { readonly error: unknown } | undefined;
    try {
      await raw;
    } catch (error) {
      fault = { error };
    }
    await this.work.done;
    if (fault !== undefined) throw fault.error;
    if (this.#cleanupFault !== undefined) throw this.#cleanupFault.error;
  }
}
