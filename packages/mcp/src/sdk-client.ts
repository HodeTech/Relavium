import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { RequestHandlerExtra } from '@modelcontextprotocol/sdk/shared/protocol.js';
import type { AnyObjectSchema, SchemaOutput } from '@modelcontextprotocol/sdk/server/zod-compat.js';
import {
  ErrorCode,
  McpError,
  type Notification,
  type Request,
  type Result,
  type Implementation,
} from '@modelcontextprotocol/sdk/types.js';
import type { SdkTransportOwner } from './sdk-work.js';

/** Wrap public SDK handler registration; the SDK still owns parsing and protocol dispatch. */
export class OwnedSdkClient extends Client {
  readonly #owner: SdkTransportOwner;

  constructor(info: Implementation, owner: SdkTransportOwner) {
    super(info, { capabilities: {} });
    this.#owner = owner;
    // The same SDK MethodNotFound response, through its public fallback handler, gives
    // unsupported requests an observable handler lifetime instead of an unowned callback.
    this.fallbackRequestHandler = (_request, extra) =>
      this.#owner.handleServerRequest(extra.requestId, extra.signal, () =>
        Promise.reject(new McpError(ErrorCode.MethodNotFound, 'Method not found')),
      );
  }

  override setRequestHandler<T extends AnyObjectSchema>(
    requestSchema: T,
    handler: (
      request: SchemaOutput<T>,
      extra: RequestHandlerExtra<Request, Notification>,
    ) => Result | Promise<Result>,
  ): void {
    // Protocol's constructor registers its own ping handler through this public method.
    // The closure reads #owner only when the handler runs, after construction completes.
    super.setRequestHandler(requestSchema, (request, extra) =>
      this.#owner.handleServerRequest(extra.requestId, extra.signal, () =>
        Promise.resolve(handler(request, extra)),
      ),
    );
  }
}
