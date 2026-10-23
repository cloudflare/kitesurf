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
const STEPPABLE_TYPES = new Set([
  "number",
  "range",
  "date",
  "month",
  "week",
  "time",
  "datetime-local",
]);

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
  return STEPPABLE_TYPES.has(type);
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
  if (!isValidMonth(m)) return false;
  if (!isValidDay(y, m, d)) return false;
  return true;
}

function isValidMonth(month: number): boolean {
  return month >= 1 && month <= 12;
}

function isValidDay(year: number, month: number, day: number): boolean {
  return day >= 1 && day <= daysInMonth(year, month);
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
  if (!isValidMonthParts(m[1].length, y, mo)) return null;
  return (y - MONTH_VALUE_EPOCH_YEAR) * 12 + (mo - 1);
}

function isValidMonthParts(yearLength: number, year: number, month: number): boolean {
  if (yearLength < 4 || year < 1) return false;
  return isValidMonth(month);
}

function weeksInISOYear(year: number): number {
  const jan1 = new Date(utcMs(year, 0, 1)).getUTCDay();
  const isLeap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  return has53IsoWeeks(jan1, isLeap) ? 53 : 52;
}

function has53IsoWeeks(jan1: number, isLeap: boolean): boolean {
  return jan1 === 4 || (isLeap && jan1 === 3);
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
  if (!isValidWeekParts(m[1].length, y, w)) return null;
  return isoWeekMondayUTC(y, w);
}

function isValidWeekParts(yearLength: number, year: number, week: number): boolean {
  if (yearLength < 4 || year < 1) return false;
  if (week < 1) return false;
  return week <= weeksInISOYear(year);
}

export function parseTime(value: string): number | null {
  const m = RX_TIME.exec(value);
  if (!m) return null;
  const h = +m[1],
    mi = +m[2],
    s = parseOptionalNumber(m[3]);
  const ms = parseFractionalMilliseconds(m[4]);
  if (!isValidTime(h, mi, s)) return null;
  return h * MS_PER_HOUR + mi * MS_PER_MINUTE + s * MS_PER_SECOND + ms;
}

function parseOptionalNumber(value: string | undefined): number {
  return value ? +value : 0;
}

function parseFractionalMilliseconds(value: string | undefined): number {
  return value ? +value.padEnd(3, "0") : 0;
}

function isValidTime(hour: number, minute: number, second: number): boolean {
  return hour <= 23 && minute <= 59 && second <= 59;
}

export function parseDateTimeLocal(value: string): number | null {
  const m = RX_DATETIME_LOCAL.exec(value);
  if (!m) return null;
  const y = +m[1],
    mo = +m[2],
    d = +m[3],
    h = +m[4],
    mi = +m[5];
  const s = parseOptionalNumber(m[6]);
  const ms = parseFractionalMilliseconds(m[7]);
  if (!isValidDateParts(m[1].length, y, mo, d)) return null;
  if (!isValidTime(h, mi, s)) return null;
  return utcMs(y, mo - 1, d, h, mi, s, ms);
}

function isValidDateParts(yearLength: number, year: number, month: number, day: number): boolean {
  return yearLength >= 4 && isValidYMD(year, month, day);
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
  if (d === null || !isUsableDate(d)) return "";
  const out = dateValueString(type, d);
  return validDateValueString(type, out) ? out : "";
}

function isUsableDate(date: Date | null): date is Date {
  return date instanceof Date && !isNaN(date.getTime());
}

function validDateValueString(type: string, value: string): boolean {
  return parseByType(type, value) != null;
}

function dateValueString(type: string, date: Date): string {
  if (type === "month") {
    return serializeMonth(
      (date.getUTCFullYear() - MONTH_VALUE_EPOCH_YEAR) * 12 + date.getUTCMonth(),
    );
  }
  return serializeByType(type, date.getTime());
}

export function resolvedStep(type: string, stepAttr: string | null): number | null {
  if (stepAttr === "any") return null;
  if (isMissingStep(stepAttr)) return stepDefault(type);
  const n = +stepAttr;
  if (isInvalidStep(n)) return stepDefault(type);
  return n * stepScale(type);
}

function isMissingStep(stepAttr: string | null): stepAttr is null | "" {
  return stepAttr == null || stepAttr === "";
}

function isInvalidStep(step: number): boolean {
  return !Number.isFinite(step) || step <= 0;
}

export function resolvedStepBase(
  type: string,
  minAttr: string | null,
  valueAttr?: string | null,
): number {
  const min = parsedStepBase(type, minAttr);
  if (min != null) return min;
  const value = parsedStepBase(type, valueAttr);
  if (value != null) return value;
  return stepBaseDefault(type);
}

function parsedStepBase(type: string, value: string | null | undefined): number | null {
  if (value == null || value === "") return null;
  return parseByType(type, value);
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
      return sanitizeEmail(value, opts);
    case "number":
      return sanitizeNumberInput(value);
    case "date":
    case "month":
    case "week":
    case "time":
    case "datetime-local":
      return sanitizeTypedDateTime(type, value);
    case "range":
      return sanitizeRange(value, opts);
    case "color": {
      return sanitizeColor(value);
    }
    default:
      return value;
  }
}

function sanitizeEmail(value: string, opts?: SanitizeOpts): string {
  if (opts?.multiple) return value.split(",").map(stripHtmlWhitespace).join(",");
  return stripHtmlWhitespace(stripNewlines(value));
}

function sanitizeNumberInput(value: string): string {
  return parseNumber(value) == null ? "" : value;
}

function sanitizeTypedDateTime(type: string, value: string): string {
  return parseByType(type, value) == null ? "" : value;
}

function sanitizeColor(value: string): string {
  const stripped = stripNewlines(value);
  return /^#[0-9a-fA-F]{6}$/.test(stripped) ? stripped.toLowerCase() : "#000000";
}

function sanitizeRange(value: string, opts?: SanitizeOpts): string {
  const min = rangeMin(opts);
  const max = rangeMax(opts);
  const parsed = parseNumber(value);
  const clamped = rangeValue(parsed, min, max);
  return serializeNumber(snapRangeValue(clamped, min, max, opts));
}

function rangeMin(opts?: SanitizeOpts): number {
  let min = 0;
  if (opts?.minAttr != null && opts.minAttr !== "") {
    const parsed = parseNumber(opts.minAttr);
    if (parsed != null) min = parsed;
  }
  return min;
}

function rangeMax(opts?: SanitizeOpts): number {
  let max = 100;
  if (opts?.maxAttr != null && opts.maxAttr !== "") {
    const parsed = parseNumber(opts.maxAttr);
    if (parsed != null) max = parsed;
  }
  return max;
}

function rangeValue(parsed: number | null, min: number, max: number): number {
  let value = parsed;
  if (value == null) value = max < min ? min : min + (max - min) / 2;
  if (value > max) value = max;
  if (value < min) value = min;
  return value;
}

function snapRangeValue(value: number, min: number, max: number, opts?: SanitizeOpts): number {
  const step = rangeStep(opts);
  if (step != null && max >= min) {
    return snapRangeStep(value, min, max, step, opts);
  }
  return value;
}

function rangeStep(opts?: SanitizeOpts): number | null {
  return resolvedStep("range", opts?.stepAttr ?? null);
}

function snapRangeStep(
  value: number,
  min: number,
  max: number,
  step: number,
  opts?: SanitizeOpts,
): number {
  const base = resolvedStepBase("range", opts?.minAttr ?? null);
  const offset = (value - base) / step;
  if (Math.abs(offset - Math.round(offset)) > STEP_ALIGNMENT_EPSILON) {
    return nearestRangeStep(value, min, max, base, offset, step);
  }
  return value;
}

function nearestRangeStep(
  value: number,
  min: number,
  max: number,
  base: number,
  offset: number,
  step: number,
): number {
  const low = base + Math.floor(offset) * step;
  const high = base + Math.ceil(offset) * step;
  let candidate = value - low < high - value ? low : high;
  if (candidate > max) candidate = low;
  if (candidate < min) candidate = high;
  if (isWithinRange(candidate, min, max)) return Number(candidate.toPrecision(15));
  return value;
}

function isWithinRange(value: number, min: number, max: number): boolean {
  return value >= min && value <= max;
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
  const { min, max } = readStepBounds(type, minAttr, maxAttr);
  const current = initialStepValue(type, currentValue, min, max);
  let next = steppedValue(current, base, step, n);
  next = adjustStepBounds(next, min, max, step);
  next = roundStepValue(type, next);
  if (isOutsideStepBounds(next, min, max)) return { noop: true };
  if (stepsAgainstDirection(n, current, next)) return { noop: true };
  return { value: serializeByType(type, next) };
}

interface StepBounds {
  min: number | null;
  max: number | null;
}

function readStepBounds(type: string, minAttr: string | null, maxAttr: string | null): StepBounds {
  const defaults = rangeDefaults(type);
  const min = parseStepBound(type, minAttr, defaults, "min");
  const max = parseStepBound(type, maxAttr, defaults, "max");
  return { min, max };
}

function parseStepBound(
  type: string,
  attr: string | null,
  defaults: { min: number; max: number } | null,
  bound: "min" | "max",
): number | null {
  if (attr != null && attr !== "") {
    const parsed = parseByType(type, attr);
    if (parsed != null) return parsed;
  }
  return defaults ? defaults[bound] : null;
}

function initialStepValue(
  type: string,
  value: string,
  min: number | null,
  max: number | null,
): number {
  let current = parseByType(type, value);
  if (current == null) return initialInvalidStepValue(min, max);
  return current;
}

function initialInvalidStepValue(min: number | null, max: number | null): number {
  let current = 0;
  if (min != null && current < min) current = min;
  if (max != null && current > max) current = max;
  return current;
}

function steppedValue(current: number, base: number, step: number, n: number): number {
  const offset = (current - base) / step;
  if (Math.abs(offset - Math.round(offset)) > STEP_ALIGNMENT_EPSILON) {
    return (
      base +
      (n >= 0
        ? Math.ceil(offset - STEP_ALIGNMENT_EPSILON)
        : Math.floor(offset + STEP_ALIGNMENT_EPSILON)) *
        step
    );
  }
  return current + n * step;
}

function adjustStepBounds(
  value: number,
  min: number | null,
  max: number | null,
  step: number,
): number {
  let next = value;
  if (max != null && next > max) {
    const overshoot = Math.ceil((next - max) / step);
    next = next - overshoot * step;
  }
  if (min != null && next < min) {
    const undershoot = Math.ceil((min - next) / step);
    next = next + undershoot * step;
  }
  return next;
}

function roundStepValue(type: string, value: number): number {
  if (type !== "number" && type !== "range") return Math.round(value);
  return value;
}

function isOutsideStepBounds(value: number, min: number | null, max: number | null): boolean {
  return (min != null && value < min) || (max != null && value > max);
}

function stepsAgainstDirection(n: number, current: number, next: number): boolean {
  return (n > 0 && next < current) || (n < 0 && next > current);
}
