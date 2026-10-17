import { CliError } from '../process/cli-error.js';
import type { InvocationRegistry, OwnerRetirement } from '../process/invocation-registry.js';
import type { CliIo } from '../process/io.js';
import { SHOW_CURSOR } from '../render/alt-screen.js';
import type { RunJobControl } from '../render/run-job-control.js';
import type { RunRenderer } from '../render/renderer.js';

/** An acquisition declaration belongs to the trusted constructor, never to a thrown error. */
export interface RendererCreationOwner {
  readonly acknowledgeNoAcquisition: () => void;
  readonly adopt: (owner: Pick<RunRenderer, 'seal' | 'releaseInput'>) => void;
}

/** Reserved before preparation: a late handle never needs new authority after invocation stop. */
export class WorkflowTerminal {
  readonly #registry: InvocationRegistry;
  readonly #io: CliIo;
  readonly #fail: (cause: unknown) => void;
  readonly #assertEntering: () => void;
  readonly #prompts = new Set<Promise<void>>();
  readonly #viewOperations = new Set<Promise<void>>();
  #inputWork: Promise<void> | undefined;
  readonly #retired: Promise<OwnerRetirement>;
  #resolveRetired: (value: OwnerRetirement) => void = () => undefined;
  #sealed = false;
  #promptUnacknowledged = false;
  #viewUnacknowledged = false;
  #jobUnacknowledged = false;
  #view: Pick<RunRenderer, 'seal' | 'releaseInput'> | undefined;
  #disposeJobControl: (() => void) | undefined;
  #jobReleased: Promise<void> | undefined;
  #restoring: Promise<void> | undefined;
  #cursorOwned = false;

  constructor(
    registry: InvocationRegistry,
    io: CliIo,
    assertEntering: () => void,
    fail: (cause: unknown) => void,
  ) {
    this.#registry = registry;
    this.#io = io;
    this.#fail = fail;
    this.#assertEntering = assertEntering;
    this.#retired = new Promise((resolve) => {
      this.#resolveRetired = resolve;
    });
    registry.register({
      kind: 'terminal',
      retired: this.#retired,
      stop: () => this.seal(),
      join: () => this.#retired.then(() => undefined),
      restore: () => this.#restore(),
      classifyFailure: () => 'cli_internal',
    });
  }
  get sealed(): boolean {
    return this.#sealed;
  }
  #enter(): void {
    this.#assertEntering();
    if (this.#sealed) throw new CliError('cli_internal', '');
  }

  /** Fulfillment is the prompt's release contract. Rejection/abort alone never supplies that ACK. */
  runPrompt<T>(factory: () => Promise<T>): Promise<T> {
    this.#enter();
    this.#cursorOwned ||= this.#io.stdoutIsTty;
    let settle: () => void = () => undefined;
    const settled = new Promise<void>((resolve) => {
      settle = resolve;
    });
    this.#prompts.add(settled); // Reservation precedes factory entry, including synchronous reentry.
    const failed = (cause: unknown): never => {
      this.#promptUnacknowledged = true;
      this.#prompts.delete(settled);
      settle();
      this.#fail(cause);
      throw cause;
    };
    let raw: Promise<T>;
    try {
      raw = factory();
    } catch (cause) {
      this.#promptUnacknowledged = true;
      this.#prompts.delete(settled);
      settle();
      this.#fail(cause);
      // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- Preserve the opaque constructor failure without forging terminal release.
      return Promise.reject<T>(cause);
    }
    return raw.then((value) => {
      this.#prompts.delete(settled);
      settle();
      return value;
    }, failed);
  }

  /** Track suspend/remount/finalize entry separately from an early input-release attempt. */
  runViewOperation<T>(factory: () => T | Promise<T>, mayAcquire = true): Promise<T> {
    if (mayAcquire) this.#enter();
    else if (this.#sealed) throw new CliError('cli_internal', '');
    let settle: () => void = () => undefined;
    const settled = new Promise<void>((resolve) => {
      settle = resolve;
    });
    this.#viewOperations.add(settled);
    const finish = (): void => {
      if (mayAcquire) this.#inputWork = undefined;
      this.#viewOperations.delete(settled);
      settle();
    };
    let raw: T | Promise<T>;
    try {
      raw = factory();
    } catch (cause) {
      finish();
      return Promise.resolve().then(() => {
        throw cause;
      });
    }
    return Promise.resolve(raw).then(
      (value) => {
        finish();
        return value;
      },
      (cause: unknown) => {
        finish();
        throw cause;
      },
    );
  }

  /** Reuse the same already-entered release; only a later entered view operation invalidates its ACK. */
  releaseInput(): Promise<void> {
    if (this.#inputWork !== undefined) return this.#inputWork;
    const pending = Promise.resolve().then(() => {
      if (!this.#canRestore()) return this.#retired.then(() => undefined);
      return this.#view?.releaseInput?.();
    });
    this.#inputWork = pending;
    void pending.catch(() => {
      if (this.#inputWork === pending) this.#inputWork = undefined;
    });
    return pending;
  }

  createRenderer(factory: (creation: RendererCreationOwner) => RunRenderer): RunRenderer {
    this.#enter();
    this.#viewUnacknowledged = true;
    let declared = false;
    const creation: RendererCreationOwner = Object.freeze({
      acknowledgeNoAcquisition: () => {
        if (declared) throw new CliError('cli_internal', '');
        declared = true;
        this.#viewUnacknowledged = false;
      },
      adopt: (owner: Pick<RunRenderer, 'seal' | 'releaseInput'>) => {
        if (declared) throw new CliError('cli_internal', '');
        declared = true;
        this.#view = owner;
        this.#viewUnacknowledged = false;
        if (owner.releaseInput !== undefined) this.#cursorOwned ||= this.#io.stdoutIsTty;
        if (this.#sealed) owner.seal?.();
      },
    });
    try {
      const renderer = factory(creation);
      if (!declared) creation.adopt(renderer);
      // A native-free constructor can still return a view that acquires input on a later resume.
      if (this.#view === undefined) this.#view = renderer;
      if (renderer.releaseInput !== undefined) this.#cursorOwned ||= this.#io.stdoutIsTty;
      if (this.#sealed) renderer.seal?.();
      return renderer;
    } catch (cause) {
      this.#fail(cause);
      throw cause;
    }
  }

  createJobControl(
    factory: (adopt: (control: RunJobControl) => void) => RunJobControl,
  ): RunJobControl {
    this.#enter();
    this.#jobUnacknowledged = true;
    let adopted: RunJobControl | undefined;
    const adopt = (control: RunJobControl): void => {
      if (adopted !== undefined && adopted !== control) throw new CliError('cli_internal', '');
      if (adopted === control) return;
      adopted = control;
      this.#cursorOwned ||= this.#io.stdoutIsTty;
      this.#disposeJobControl = control.dispose;
      this.#jobReleased = control.released;
      this.#jobUnacknowledged = false;
      if (control.released !== undefined)
        void control.released.then(() => {
          if (this.#disposeJobControl === control.dispose) this.#disposeJobControl = undefined;
        }, this.#fail);
      if (this.#sealed) this.#releaseJobControl();
    };
    try {
      const control = factory(adopt);
      adopt(control);
      return control;
    } catch (cause) {
      this.#fail(cause);
      throw cause;
    }
  }
  #releaseJobControl(): void {
    const dispose = this.#disposeJobControl;
    if (dispose === undefined) return;
    dispose();
    if (this.#jobReleased === undefined && this.#disposeJobControl === dispose)
      this.#disposeJobControl = undefined;
  }

  /** Finite stop only; asynchronous restoration is separately deadline-gated by the registry. */
  seal(): void {
    if (this.#sealed) return;
    this.#sealed = true; // Publish before entering the native renderer callback.
    try {
      this.#view?.seal?.();
    } catch (cause) {
      this.#fail(cause);
    }
    try {
      this.#releaseJobControl();
    } catch (cause) {
      this.#fail(cause);
    }
  }

  #canRestore(): boolean {
    return this.#registry.budget.remainingMs() !== 0;
  }

  #restore(): Promise<void> {
    if (this.#restoring !== undefined) return this.#restoring;
    if (!this.#canRestore()) return this.#retired.then(() => undefined);
    // Publish before invoking any native callback. Reentrant seal/finish cannot start another restoration.
    const pending = Promise.resolve().then(async () => {
      if (!this.#canRestore()) return await this.#retired.then(() => undefined);
      const job = Promise.resolve().then(() => {
        this.#releaseJobControl();
        return this.#jobReleased;
      });
      const earlyCursor = Promise.resolve().then(() => {
        if (!this.#cursorOwned) return;
        if (!this.#canRestore()) return this.#retired.then(() => undefined);
        return this.#io.writeOutAcknowledged(SHOW_CURSOR);
      });
      const enteredViewOperations = [...this.#viewOperations];
      const view = this.releaseInput();
      // Attempt and observe independent operations before awaiting a held prompt/view/stdout callback.
      const guarded = [earlyCursor, view, job].map((work) =>
        work.catch((cause: unknown) => {
          this.#fail(cause);
          throw cause;
        }),
      );
      for (const work of guarded) void work.catch(() => undefined);
      await Promise.all([...this.#prompts, ...enteredViewOperations, ...guarded]);
      if (enteredViewOperations.length > 0) {
        // An entered async remount can finish after the early release; acknowledge its final native state.
        if (!this.#canRestore()) return await this.#retired.then(() => undefined);
        this.#inputWork = undefined;
        await this.releaseInput();
      }
      if (this.#promptUnacknowledged || this.#viewUnacknowledged || this.#jobUnacknowledged)
        return await new Promise<never>(() => {});
      // A late prompt/Ink write can hide the cursor after the early attempt.
      if (this.#cursorOwned) {
        if (!this.#canRestore()) return await this.#retired.then(() => undefined);
        await this.#io.writeOutAcknowledged(SHOW_CURSOR);
      }
      this.#resolveRetired({ kind: 'settled' });
    });
    this.#restoring = pending;
    void pending.catch(() => {
      if (this.#restoring === pending) this.#restoring = undefined;
    });
    return pending;
  }
  /** Seal only at the last preparation/driver boundary, then join actual restoration. */
  async finish(): Promise<void> {
    this.seal();
    void this.#restore().catch(this.#fail);
    await this.#retired;
  }
}
