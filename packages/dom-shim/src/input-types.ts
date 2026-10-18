// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// Parses, sanitizes, serializes, and steps numeric and date/time input values.

import {
  MS_PER_DAY,
  MS_PER_HOUR,
  MS_PER_MINUTE,
  MS_PER_SECOND,
  MS_PER_WEEK,
  STEP_ALIGNMENT_EPSILON,
} from "./constants.js";

export type SteppableType =
  | "number"
  | "range"
  | "date"
  | "month"
  | "week"
  | "time"
  | "datetime-local";

const MONTH_VALUE_EPOCH_YEAR = 1970;

export function stepDefault(type: string): number {
  switch (type) {
    case "date":
      return MS_PER_DAY;
    case "month":
      return 1;
    case "week":
      return MS_PER_WEEK;
    case "time":
      return MS_PER_MINUTE;
    case "datetime-local":
      return MS_PER_MINUTE;
    case "number":
    case "range":
    default:
      return 1;
  }
}

export function stepScale(type: string): number {
  switch (type) {
    case "date":
      return MS_PER_DAY;
    case "week":
      return MS_PER_WEEK;
    case "time":
      return MS_PER_SECOND;
    case "datetime-local":
      return MS_PER_SECOND;
    case "month":
    case "number":
    case "range":
    default:
      return 1;
  }
}

export function stepBaseDefault(type: string): number {
  if (type === "week") return -3 * MS_PER_DAY;
  return 0;
}

export function isSteppable(type: string): type is SteppableType {
  return (
    type === "number" ||
    type === "range" ||
    type === "date" ||
    type === "month" ||
    type === "week" ||
    type === "time" ||
    type === "datetime-local"
  );
}

export function acceptsValueAsDate(type: string): boolean {
  return type === "date" || type === "month" || type === "week" || type === "time";
}

const RX_DATE = /^(\d{4,})-(\d{2})-(\d{2})$/;
const RX_MONTH = /^(\d{4,})-(\d{2})$/;
const RX_WEEK = /^(\d{4,})-W(\d{2})$/;
const RX_TIME = /^(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?$/;
const RX_DATETIME_LOCAL =
  /^(\d{4,})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?$/;
const RX_NUMBER = /^-?(?:\d+(?:\.\d+)?|\.\d+)(?:[eE][+-]?\d+)?$/;

function utcMs(y: number, mo0: number, d: number, h = 0, mi = 0, s = 0, ms = 0): number {
  const dt = new Date(0);
  dt.setUTCFullYear(y, mo0, d);
  dt.setUTCHours(h, mi, s, ms);
  return dt.getTime();
}
function daysInMonth(year: number, month1: number): number {
  return new Date(utcMs(year, month1, 0)).getUTCDate();
}

function isValidYMD(y: number, m: number, d: number): boolean {
  if (y < 1) return false;
  if (m < 1 || m > 12) return false;
  if (d < 1 || d > daysInMonth(y, m)) return false;
  return true;
}

export function parseDate(value: string): number | null {
  const m = RX_DATE.exec(value);
  if (!m) return null;
  const y = +m[1],
    mo = +m[2],
    d = +m[3];
  if (m[1].length < 4 || !isValidYMD(y, mo, d)) return null;
  return utcMs(y, mo - 1, d);
}

export function parseMonth(value: string): number | null {
  const m = RX_MONTH.exec(value);
  if (!m) return null;
  const y = +m[1],
    mo = +m[2];
  if (m[1].length < 4 || y < 1 || mo < 1 || mo > 12) return null;
  return (y - MONTH_VALUE_EPOCH_YEAR) * 12 + (mo - 1);
}

function weeksInISOYear(year: number): number {
  const jan1 = new Date(utcMs(year, 0, 1)).getUTCDay();
  const isLeap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  if (jan1 === 4 || (isLeap && jan1 === 3)) return 53;
  return 52;
}

function isoWeekMondayUTC(year: number, week: number): number {
  const jan4 = utcMs(year, 0, 4);
  const jan4Day = new Date(jan4).getUTCDay();
  const isoDay = jan4Day === 0 ? 7 : jan4Day;
  const week1Monday = jan4 - (isoDay - 1) * MS_PER_DAY;
  return week1Monday + (week - 1) * MS_PER_WEEK;
}

export function parseWeek(value: string): number | null {
  const m = RX_WEEK.exec(value);
  if (!m) return null;
  const y = +m[1],
    w = +m[2];
  if (m[1].length < 4 || y < 1) return null;
  if (w < 1 || w > weeksInISOYear(y)) return null;
  return isoWeekMondayUTC(y, w);
}

export function parseTime(value: string): number | null {
  const m = RX_TIME.exec(value);
  if (!m) return null;
  const h = +m[1],
    mi = +m[2],
    s = m[3] ? +m[3] : 0;
  const ms = m[4] ? +m[4].padEnd(3, "0") : 0;
  if (h > 23 || mi > 59 || s > 59) return null;
  return h * MS_PER_HOUR + mi * MS_PER_MINUTE + s * MS_PER_SECOND + ms;
}

export function parseDateTimeLocal(value: string): number | null {
  const m = RX_DATETIME_LOCAL.exec(value);
  if (!m) return null;
  const y = +m[1],
    mo = +m[2],
    d = +m[3],
    h = +m[4],
    mi = +m[5];
  const s = m[6] ? +m[6] : 0;
  const ms = m[7] ? +m[7].padEnd(3, "0") : 0;
  if (m[1].length < 4 || !isValidYMD(y, mo, d)) return null;
  if (h > 23 || mi > 59 || s > 59) return null;
  return utcMs(y, mo - 1, d, h, mi, s, ms);
}

export function parseNumber(value: string): number | null {
  if (!RX_NUMBER.test(value)) return null;
  const n = +value;
  return Number.isFinite(n) ? n : null;
}

export function parseByType(type: string, value: string): number | null {
  if (value === "") return null;
  switch (type) {
    case "date":
      return parseDate(value);
    case "month":
      return parseMonth(value);
    case "week":
      return parseWeek(value);
    case "time":
      return parseTime(value);
    case "datetime-local":
      return parseDateTimeLocal(value);
    case "number":
    case "range":
      return parseNumber(value);
    default:
      return null;
  }
}

function pad(n: number, w: number): string {
  const s = String(Math.abs(Math.trunc(n)));
  return (n < 0 ? "-" : "") + (s.length >= w ? s : "0".repeat(w - s.length) + s);
}

function ymdFromMs(ms: number): [number, number, number] {
  const d = new Date(ms);
  return [d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate()];
}

export function serializeDate(ms: number): string {
  const [y, m, d] = ymdFromMs(Math.floor(ms / MS_PER_DAY) * MS_PER_DAY);
  return `${pad(y, 4)}-${pad(m, 2)}-${pad(d, 2)}`;
}

export function serializeMonth(nMonths: number): string {
  const total = Math.floor(nMonths);
  const y = MONTH_VALUE_EPOCH_YEAR + Math.floor(total / 12);
  const m = (((total % 12) + 12) % 12) + 1;
  return `${pad(y, 4)}-${pad(m, 2)}`;
}

export function serializeWeek(ms: number): string {
  const d = new Date(ms);
  const day = d.getUTCDay() || 7;
  const thursday = new Date(d);
  thursday.setUTCDate(d.getUTCDate() + (4 - day));
  const y = thursday.getUTCFullYear();
  const yStart = utcMs(y, 0, 4);
  const yStartDay = new Date(yStart).getUTCDay() || 7;
  const week1Monday = yStart - (yStartDay - 1) * MS_PER_DAY;
  const w = Math.round((thursday.getTime() - week1Monday) / MS_PER_WEEK) + 1;
  return `${pad(y, 4)}-W${pad(w, 2)}`;
}

export function serializeTime(ms: number): string {
  if (!Number.isFinite(ms)) return "";
  const norm = ((ms % MS_PER_DAY) + MS_PER_DAY) % MS_PER_DAY;
  const h = Math.floor(norm / MS_PER_HOUR);
  const mi = Math.floor((norm % MS_PER_HOUR) / MS_PER_MINUTE);
  const s = Math.floor((norm % MS_PER_MINUTE) / MS_PER_SECOND);
  const frac = norm % MS_PER_SECOND;
  let out = `${pad(h, 2)}:${pad(mi, 2)}`;
  if (s || frac) out += `:${pad(s, 2)}`;
  if (frac) out += `.${pad(frac, 3)}`;
  return out;
}

export function serializeDateTimeLocal(ms: number): string {
  const d = new Date(ms);
  const y = d.getUTCFullYear();
  const mo = d.getUTCMonth() + 1;
  const day = d.getUTCDate();
  const h = d.getUTCHours();
  const mi = d.getUTCMinutes();
  const s = d.getUTCSeconds();
  const frac = d.getUTCMilliseconds();
  let out = `${pad(y, 4)}-${pad(mo, 2)}-${pad(day, 2)}T${pad(h, 2)}:${pad(mi, 2)}`;
  if (s || frac) out += `:${pad(s, 2)}`;
  if (frac) out += `.${pad(frac, 3)}`;
  return out;
}

export function serializeNumber(n: number): string {
  return String(n);
}

export function serializeByType(type: string, n: number): string {
  switch (type) {
    case "date":
      return serializeDate(n);
    case "month":
      return serializeMonth(n);
    case "week":
      return serializeWeek(n);
    case "time":
      return serializeTime(n);
    case "datetime-local":
      return serializeDateTimeLocal(n);
    case "number":
    case "range":
      return serializeNumber(n);
    default:
      return String(n);
  }
}

export function valueAsDateFromString(type: string, value: string): Date | null {
  if (!acceptsValueAsDate(type)) return null;
  const n = parseByType(type, value);
  if (n == null) return null;
  if (type === "month") return new Date(utcMs(MONTH_VALUE_EPOCH_YEAR, n, 1));
  return new Date(n);
}

export function valueAsDateToString(type: string, d: Date | null): string | null {
  if (!acceptsValueAsDate(type)) return null;
  if (d === null) return "";
  if (!(d instanceof Date) || isNaN(d.getTime())) return "";
  const out =
    type === "month"
      ? serializeMonth((d.getUTCFullYear() - MONTH_VALUE_EPOCH_YEAR) * 12 + d.getUTCMonth())
      : serializeByType(type, d.getTime());
  return parseByType(type, out) == null ? "" : out;
}

export function resolvedStep(type: string, stepAttr: string | null): number | null {
  if (stepAttr === "any") return null;
  if (stepAttr == null || stepAttr === "") return stepDefault(type);
  const n = +stepAttr;
  if (!Number.isFinite(n) || n <= 0) return stepDefault(type);
  return n * stepScale(type);
}

export function resolvedStepBase(
  type: string,
  minAttr: string | null,
  valueAttr?: string | null,
): number {
  if (minAttr != null && minAttr !== "") {
    const m = parseByType(type, minAttr);
    if (m != null) return m;
  }
  if (valueAttr != null && valueAttr !== "") {
    const v = parseByType(type, valueAttr);
    if (v != null) return v;
  }
  return stepBaseDefault(type);
}

export function rangeDefaults(type: string): { min: number; max: number } | null {
  if (type !== "range") return null;
  return { min: 0, max: 100 };
}

export interface StepResult {
  value?: string;
  error?: "InvalidStateError";
  noop?: boolean;
}

function stripNewlines(s: string): string {
  return s.indexOf("\n") === -1 && s.indexOf("\r") === -1 ? s : s.replace(/[\n\r]+/g, "");
}
function stripHtmlWhitespace(s: string): string {
  return s.replace(/^[ \t\n\f\r]+|[ \t\n\f\r]+$/g, "");
}

export interface SanitizeOpts {
  multiple?: boolean;
  minAttr?: string | null;
  maxAttr?: string | null;
  stepAttr?: string | null;
}

export function sanitizeValue(type: string, value: string, opts?: SanitizeOpts): string {
  switch (type) {
    case "text":
    case "search":
    case "tel":
    case "password":
      return stripNewlines(value);
    case "url":
      return stripHtmlWhitespace(stripNewlines(value));
    case "email":
      if (opts?.multiple) {
        return value.split(",").map(stripHtmlWhitespace).join(",");
      }
      return stripHtmlWhitespace(stripNewlines(value));
    case "number":
      return parseNumber(value) == null ? "" : value;
    case "date":
    case "month":
    case "week":
    case "time":
    case "datetime-local":
      return parseByType(type, value) == null ? "" : value;
    case "range": {
      let min = 0,
        max = 100;
      if (opts?.minAttr != null && opts.minAttr !== "") {
        const m = parseNumber(opts.minAttr);
        if (m != null) min = m;
      }
      if (opts?.maxAttr != null && opts.maxAttr !== "") {
        const m = parseNumber(opts.maxAttr);
        if (m != null) max = m;
      }
      let n = parseNumber(value);
      if (n == null) n = max < min ? min : min + (max - min) / 2;
      if (n > max) n = max;
      if (n < min) n = min;
      const step = resolvedStep(type, opts?.stepAttr ?? null);
      if (step != null && max >= min) {
        const base = resolvedStepBase(type, opts?.minAttr ?? null);
        const off = (n - base) / step;
        if (Math.abs(off - Math.round(off)) > STEP_ALIGNMENT_EPSILON) {
          const low = base + Math.floor(off) * step;
          const high = base + Math.ceil(off) * step;
          let cand = n - low < high - n ? low : high;
          if (cand > max) cand = low;
          if (cand < min) cand = high;
          if (cand >= min && cand <= max) {
            n = Number(cand.toPrecision(15));
          }
        }
      }
      return serializeNumber(n);
    }
    case "color": {
      const s = stripNewlines(value);
      return /^#[0-9a-fA-F]{6}$/.test(s) ? s.toLowerCase() : "#000000";
    }
    default:
      return value;
  }
}

export function computeStep(
  type: string,
  currentValue: string,
  minAttr: string | null,
  maxAttr: string | null,
  stepAttr: string | null,
  n: number,
  valueAttr?: string | null,
): StepResult {
  if (!isSteppable(type)) return { error: "InvalidStateError" };
  const step = resolvedStep(type, stepAttr);
  if (step == null) return { error: "InvalidStateError" };
  const base = resolvedStepBase(type, minAttr, valueAttr);
  const defaults = rangeDefaults(type);
  let min: number | null = null;
  let max: number | null = null;
  if (minAttr != null && minAttr !== "") min = parseByType(type, minAttr);
  if (maxAttr != null && maxAttr !== "") max = parseByType(type, maxAttr);
  if (min == null && defaults) min = defaults.min;
  if (max == null && defaults) max = defaults.max;

  let current = parseByType(type, currentValue);
  if (current == null) {
    current = 0;
    if (min != null && current < min) current = min;
    if (max != null && current > max) current = max;
  }

  const offset = (current - base) / step;
  let next;
  if (Math.abs(offset - Math.round(offset)) > STEP_ALIGNMENT_EPSILON) {
    next =
      base +
      (n >= 0
        ? Math.ceil(offset - STEP_ALIGNMENT_EPSILON)
        : Math.floor(offset + STEP_ALIGNMENT_EPSILON)) *
        step;
  } else {
    next = current + n * step;
  }

  if (max != null && next > max) {
    const overshoot = Math.ceil((next - max) / step);
    next = next - overshoot * step;
  }
  if (min != null && next < min) {
    const undershoot = Math.ceil((min - next) / step);
    next = next + undershoot * step;
  }

  if (type !== "number" && type !== "range") {
    next = Math.round(next);
  }
  if ((min != null && next < min) || (max != null && next > max)) {
    return { noop: true };
  }
  if (n > 0 && next < current) return { noop: true };
  if (n < 0 && next > current) return { noop: true };
  return { value: serializeByType(type, next) };
}
