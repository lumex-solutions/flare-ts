import type { TypedPrimitive } from "./index.js";

/**
 * Format key that controls how {@link date} and {@link parseDate} interpret an input string.
 */
type DateFormatKey =
  | "DMY" // DD/MM/YYYY and variants
  | "MDY" // MM/DD/YYYY and variants
  | "YMD" // YYYY/MM/DD and variants
  | "ISO" // Full ISO 8601 with time + timezone
  | "TIMESTAMP"; // Unix seconds (10), milliseconds (13), or microseconds (16)

type DatePrimitive = TypedPrimitive<Date> & {
  format(format: DateFormatKey): DatePrimitive;
  readonly _format: string;
};

function throwBadInput(format: string, raw: string): never {
  throw new Error(`Invalid ${format} date: "${raw}"`);
}

function utcMidnight(year: number, month: number, day: number): Date {
  return new Date(Date.UTC(year, month, day, 0, 0, 0, 0));
}

/** Treats two-digit years as 2000+. Four-digit years pass through. */
function normalizeYear(yy: number): number {
  return yy < 100 ? 2000 + yy : yy;
}

function parseISO(raw: string): Date {
  const ISO_RE = /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})?)?$/;
  if (!ISO_RE.test(raw)) throwBadInput("ISO", raw);
  // Append midnight UTC for date-only inputs so all values are UTC-anchored
  const normalized = raw.includes("T") ? raw : raw + "T00:00:00Z";
  const d = new Date(normalized);
  if (isNaN(d.getTime())) throwBadInput("ISO", raw);
  return d;
}

/** Shared parser for DMY and MDY - only the field order differs. */
function parseDayMonthYear(raw: string, dayFirst: boolean): Date {
  const SEP_RE = /^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})$/;
  const COMPACT_RE = /^(\d{2})(\d{2})(\d{4})$/;
  const m = SEP_RE.exec(raw) ?? COMPACT_RE.exec(raw);
  const label = dayFirst ? "DMY" : "MDY";
  if (!m) throwBadInput(label, raw);
  const a = parseInt(m[1]!, 10);
  const b = parseInt(m[2]!, 10);
  const year = normalizeYear(parseInt(m[3]!, 10));
  const [day, month] = dayFirst ? [a, b - 1] : [b, a - 1];
  const d = utcMidnight(year, month, day);
  if (d.getUTCFullYear() !== year || d.getUTCMonth() !== month || d.getUTCDate() !== day) {
    throwBadInput(label, raw);
  }
  if (isNaN(d.getTime())) throwBadInput(label, raw);
  return d;
}

function parseYMD(raw: string): Date {
  const SEP_RE = /^(\d{4})[\/\-.](\d{1,2})[\/\-.](\d{1,2})$/;
  const COMPACT_RE = /^(\d{4})(\d{2})(\d{2})$/;
  const m = SEP_RE.exec(raw) ?? COMPACT_RE.exec(raw);
  if (!m) throwBadInput("YMD", raw);
  const year = parseInt(m[1]!, 10);
  const month = parseInt(m[2]!, 10) - 1;
  const day = parseInt(m[3]!, 10);
  const d = utcMidnight(year, month, day);
  if (isNaN(d.getTime())) throwBadInput("YMD", raw);
  // Round-trip check: catches out-of-range values (e.g. month 13, day 32) that
  // Date.UTC silently normalizes instead of rejecting.
  if (d.getUTCFullYear() !== year || d.getUTCMonth() !== month || d.getUTCDate() !== day) {
    throwBadInput("YMD", raw);
  }
  return d;
}

function parseTimestamp(raw: string): Date {
  const ts = raw.trim();
  if (!/^\d{10}$|^\d{13}$|^\d{16}$/.test(ts)) throwBadInput("TIMESTAMP", raw);
  const n = parseInt(ts, 10);
  // Normalise all precisions to milliseconds
  const ms = ts.length === 10 ? n * 1000 : ts.length === 13 ? n : Math.floor(n / 1000);
  const d = new Date(ms);
  if (isNaN(d.getTime())) throwBadInput("TIMESTAMP", raw);
  return d;
}

const DATE_JSON_SCHEMA: Record<DateFormatKey, { type: "string"; format?: string; }> = {
  ISO: { type: "string", format: "date-time" },
  YMD: { type: "string", format: "date" },
  DMY: { type: "string" },
  MDY: { type: "string" },
  TIMESTAMP: { type: "string" },
};

/**
 * Parses a date string using the specified {@link DateFormatKey}.
 *
 * @throws {Error} When the input does not match the format's expected pattern or falls outside the calendar range.
 *
 * @example
 * ```ts
 * parseDate("2024-03-22", "ISO");        // Date (UTC midnight)
 * parseDate("22/03/2024", "DMY");        // Date
 * parseDate("1711065600", "TIMESTAMP");  // Date from Unix seconds
 * ```
 */
function parseDate(raw: string, format: DateFormatKey = "ISO"): Date {
  switch (format) {
    case "ISO":
      return parseISO(raw);
    case "DMY":
      return parseDayMonthYear(raw, true);
    case "MDY":
      return parseDayMonthYear(raw, false);
    case "YMD":
      return parseYMD(raw);
    case "TIMESTAMP":
      return parseTimestamp(raw);
  }
}

/** Builds a plain TypedPrimitive<Date> locked to a specific format. */
function makeDatePrimitive(format: DateFormatKey = "ISO"): DatePrimitive {
  const fn = (raw: string): Date => parseDate(raw, format);
  fn._type = "date";
  fn._required = true;
  fn.jsonSchema = DATE_JSON_SCHEMA[format];
  fn._format = format;
  fn.format = (nextFormat: DateFormatKey) => makeDatePrimitive(nextFormat);
  return fn as DatePrimitive;
}

/**
 * Date primitive. Parses a date string and returns a `Date` object.
 * Defaults to ISO 8601. Chain `.format()` to select a different input format.
 *
 * @example
 * ```ts
 * date                       // ISO 8601 (default)
 * date.format("DMY")         // DD/MM/YYYY
 * date.format("TIMESTAMP")   // Unix seconds / ms / μs
 * ```
 */
export const date: DatePrimitive = makeDatePrimitive();
