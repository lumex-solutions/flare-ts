import type { LoggerTransportClass } from "../../logger/types.js";

/**
 * Registers additional logger transports. Registered classes fire in registration order
 * alongside the runtime defaults supplied by the host adapter.
 */
export class Logging<TTransportClass extends LoggerTransportClass = LoggerTransportClass> {
  #loggerTransports: TTransportClass[] = [];

  /** Registered transport classes in registration order. */
  get loggerTransports(): readonly TTransportClass[] {
    return this.#loggerTransports;
  }

  /**
   * Registers a transport with the active logger. Multiple transports may be registered.
   * Transports receive records in registration order.
   */
  transport(transportClass: TTransportClass): void {
    this.#loggerTransports.push(transportClass);
  }
}
