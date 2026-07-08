/**
 * Console capture for transport suites: swaps console.log/warn/error for recording
 * stubs and restores them, plus the ANSI stripper assertions use on pretty output.
 */

/** Captures every call routed to console.log/warn/error during the test. */
export interface ConsoleCapture {
  log: string[];
  warn: string[];
  error: string[];
  restore(): void;
}

/** Replaces the three console sinks with recorders; call `restore()` in afterEach. */
export function captureConsole(): ConsoleCapture {
  const originalLog = console.log;
  const originalWarn = console.warn;
  const originalError = console.error;
  const cap: ConsoleCapture = {
    log: [],
    warn: [],
    error: [],
    restore(): void {
      console.log = originalLog;
      console.warn = originalWarn;
      console.error = originalError;
    },
  };
  console.log = (msg?: unknown): void => {
    cap.log.push(String(msg));
  };
  console.warn = (msg?: unknown): void => {
    cap.warn.push(String(msg));
  };
  console.error = (msg?: unknown): void => {
    cap.error.push(String(msg));
  };
  return cap;
}

/** Removes ANSI escape sequences so assertions can match visible text. */
export function stripAnsi(value: string): string {
  return value.replace(/\x1b\[[0-9;]*m/g, "");
}
