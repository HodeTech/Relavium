import type { CliInvocation } from '../process/invocation.js';
import type { SessionOwner } from '../process/invocation-registry.js';
import {
  InvocationWorkOwner,
  type InvocationWorkOwnerPorts,
} from '../process/invocation-work-owner.js';

export type SessionWorkOwnerPorts = InvocationWorkOwnerPorts;

/** Each real host retains its own instance identity, independently of UI pointers or durable IDs. */
export class SessionWorkOwner extends InvocationWorkOwner {
  constructor(
    invocation: CliInvocation,
    surface: SessionOwner['surface'],
    ports: SessionWorkOwnerPorts,
  ) {
    super(invocation, { kind: 'session', surface }, ports);
  }
}
