// eslint-disable-next-line no-restricted-imports
import { readFileSync } from "node:fs";
import type { LoggerTransportClass } from "../../logger/types";
import type { SingletonExtension } from "../extensions/singleton";
import type { HostRuntimeAdapter } from "../types/adapter";
import { Logger } from "../../logger/logger";
import { ConsoleTransport } from "../../logger/transports/console.js";
import { singletonExtension } from "../extensions/singleton";

/**
 * Placeholder Bun runtime adapter. Reads `flare.json` and exposes `process.env`, but
 * `createApp` and `createTestRequest` throw because the Bun runtime is not yet supported.
 */
// TODO: replace `any` with the concrete FlareAppBun class once the Bun runtime is implemented.
export const bun: HostRuntimeAdapter<any, LoggerTransportClass, "async", SingletonExtension> = {
  runtime: "bun",
  lifecycle: "async",
  get flareJsonFile() {
    const filePath = `${process.cwd()}/flare.json`;
    return JSON.parse(readFileSync(filePath, "utf8"));
  },
  env: process.env,
  defaultLoggerTransports: [ConsoleTransport],
  createApp() {
    throw new Error("Bun runtime is not yet supported");
  },
  createLogger(transports, container) {
    return new Logger(transports, container);
  },
  createTestRequest() {
    throw new Error("Bun runtime is not yet supported");
  },
  extendHost(host) {
    return singletonExtension(host);
  },
};
