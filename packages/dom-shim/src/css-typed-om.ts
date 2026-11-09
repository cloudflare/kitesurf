// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// Implements CSS Typed OM values, property maps, and style-value conversion.

import type * as Idl from "./idl/types.generated.js";
import { opts } from "./state.js";

const NUMERIC_TYPES = [
  "length",
  "angle",
  "time",
  "frequency",
  "resolution",
  "flex",
  "percent",
] as const;

const UNIT_TYPES: Record<string, (typeof NUMERIC_TYPES)[number] | null> = {
  number: null,
  percent: "percent",
  em: "length",
  ex: "length",
  ch: "length",
  cap: "length",
  ic: "length",
  rem: "length",
  rcap: "length",
  rch: "length",
  rex: "length",
  ric: "length",
  lh: "length",
  rlh: "length",
  vw: "length",
  vh: "length",
  vi: "length",
  vb: "length",
  vmin: "length",
  vmax: "length",
  cm: "length",
  mm: "length",
  svw: "length",
  svh: "length",
  svi: "length",
  svb: "length",
  svmin: "length",
  svmax: "length",
  lvw: "length",
  lvh: "length",
  lvi: "length",
  lvb: "length",
  lvmin: "length",
  lvmax: "length",
  dvw: "length",
  dvh: "length",
  dvi: "length",
  dvb: "length",
  dvmin: "length",
  dvmax: "length",
  cqw: "length",
  cqh: "length",
  cqi: "length",
  cqb: "length",
  cqmin: "length",
  cqmax: "length",
  q: "length",
  in: "length",
  pt: "length",
  pc: "length",
  px: "length",
  deg: "angle",
  grad: "angle",
  rad: "angle",
  turn: "angle",
  s: "time",
  ms: "time",
  hz: "frequency",
  khz: "frequency",
  dpi: "resolution",
  dpcm: "resolution",
  dppx: "resolution",
  fr: "flex",
};

const UNIT_FACTORS: Record<string, number> = {
  px: 1,
  cm: 96 / 2.54,
  mm: 96 / 25.4,
  q: 96 / 101.6,
  in: 96,
  pt: 96 / 72,
  pc: 16,
  deg: 1,
  grad: 0.9,
  rad: 180 / Math.PI,
  turn: 360,
  s: 1,
  ms: 0.001,
  hz: 1,
  khz: 1000,
  dppx: 1,
  dpi: 1 / 96,
  dpcm: 2.54 / 96,
};

type BaseType = (typeof NUMERIC_TYPES)[number];
type NumericType = Partial<Record<BaseType, number>> & { percentHint?: BaseType };

function numericType(unit: string): NumericType {
  const type = UNIT_TYPES[unit.toLowerCase()];
  return type ? { [type]: 1 } : {};
}

function cloneType(type: NumericType): NumericType {
  return { ...type };
}

function typeEquals(a: NumericType, b: NumericType): boolean {
  return NUMERIC_TYPES.every((type) => a[type] === b[type]) && a.percentHint === b.percentHint;
}

function applyPercentHint(type: NumericType, hint: BaseType): NumericType {
  const out = cloneType(type);
  const percent = out.percent || 0;
  delete out.percent;
  if (percent) out[hint] = (out[hint] || 0) + percent;
  out.percentHint = hint;
  return out;
}

function addTypes(a: NumericType, b: NumericType): NumericType {
  if (a.percentHint && b.percentHint && a.percentHint !== b.percentHint) {
    throw new TypeError("Incompatible numeric types");
  }
  const existingHint = a.percentHint || b.percentHint;
  if (existingHint) {
    const left = applyPercentHint(a, existingHint);
    const right = applyPercentHint(b, existingHint);
    if (typeEquals(left, right)) return left;
    throw new TypeError("Incompatible numeric types");
  }
  if (typeEquals(a, b)) return cloneType(a);
  for (const hint of NUMERIC_TYPES) {
    if (hint === "percent") continue;
    const left = applyPercentHint(a, hint);
    const right = applyPercentHint(b, hint);
    if (typeEquals(left, right)) return left;
  }
  throw new TypeError("Incompatible numeric types");
}

function multiplyTypes(a: NumericType, b: NumericType): NumericType {
  if (a.percentHint && b.percentHint && a.percentHint !== b.percentHint) {
    throw new TypeError("Incompatible numeric types");
  }
  const hint = a.percentHint || b.percentHint;
  const left = hint ? applyPercentHint(a, hint) : a;
  const right = hint ? applyPercentHint(b, hint) : b;
  const out: NumericType = hint ? { percentHint: hint } : {};
  for (const type of NUMERIC_TYPES) {
    const exponent = (left[type] || 0) + (right[type] || 0);
    if (exponent) out[type] = exponent;
  }
  return out;
}

function invertType(type: NumericType): NumericType {
  const out: NumericType = type.percentHint ? { percentHint: type.percentHint } : {};
  for (const base of NUMERIC_TYPES) {
    if (type[base]) out[base] = -type[base]!;
  }
  return out;
}

function formatNumber(value: number): string {
  if (Object.is(value, -0)) return "0";
  return String(value);
}

function normalizeUnit(value: unknown, invalidUnitIsTypeError = false): string {
  const unit = String(value).toLowerCase();
  if (!(unit in UNIT_TYPES)) {
    if (invalidUnitIsTypeError) throw new TypeError(`Invalid unit: ${String(value)}`);
    throw new DOMException(`Invalid unit: ${String(value)}`, "SyntaxError");
  }
  return unit;
}

export class CSSStyleValue implements Idl.CSSStyleValue {
  _cssText: string;
  _associatedProperty: string | null;

  constructor(cssText = "", associatedProperty: string | null = null) {
    this._cssText = String(cssText);
    this._associatedProperty = associatedProperty;
  }

  static parse(propertyName: string, cssText: string): CSSStyleValue {
    return CSSStyleValue.parseAll(propertyName, cssText)[0];
  }

  static parseAll(propertyName: string, cssText: string): CSSStyleValue[] {
    const property = normalizeProperty(propertyName);
    assertSupportedProperty(property);
    const text = String(cssText);
    if (!text || hasTopLevelSemicolon(text) || hasTopLevelImportant(text)) {
      throw new TypeError(`Invalid value for ${property}`);
    }
    if (!property.startsWith("--")) {
      const canon =
        opts && typeof opts.canonicalizeInlineStyle === "function"
          ? opts.canonicalizeInlineStyle
          : null;
      if (!canon || canon(`${property}: ${text}`).length === 0) {
        throw new TypeError(`Invalid value for ${property}`);
      }
    }
    const typed = reifyTypedList(property, text);
    if (typed) return typed;
    const parts = LIST_VALUED_PROPERTIES.has(property) ? splitTopLevelCommas(text) : [text];
    return parts.map((part) => reify(property, part) || new CSSStyleValue(part, property));
  }

  get [Symbol.toStringTag](): string {
    return this.constructor.name;
  }
  toString() {
    return this._cssText;
  }
}

export class CSSImageValue extends CSSStyleValue implements Idl.CSSImageValue {}

export class CSSKeywordValue extends CSSStyleValue implements Idl.CSSKeywordValue {
  _value: string;

  constructor(value: string) {
    const text = String(value);
    if (!text) throw new TypeError("CSS keyword must not be empty");
    super(text);
    this._value = text;
  }

  get value(): string {
    return this._value;
  }
  set value(value: string) {
    const text = String(value);
    if (!text) throw new TypeError("CSS keyword must not be empty");
    this._value = text;
    this._cssText = text;
  }
}

export class CSSNumericValue extends CSSStyleValue implements Idl.CSSNumericValue {
  static parse(cssText: string): CSSNumericValue {
    const text = String(cssText);
    const parsed = typedValueFromDto(callTypedParser("parseTypedNumericValue", text));
    if (!(parsed instanceof CSSNumericValue)) {
      throw new DOMException("Invalid CSS numeric value", "SyntaxError");
    }
    return parsed;
  }

  type() {
    return numericType("number");
  }

  add(...values: CSSNumberish[]): CSSNumericValue {
    if (!values.length) return this;
    return simplifyAddLike([this, ...values.map(toNumericValue)], "sum");
  }

  sub(...values: CSSNumberish[]): CSSNumericValue {
    if (!values.length) return this;
    return simplifyAddLike(
      [this, ...values.map((value) => negateForArithmetic(toNumericValue(value)))],
      "sum",
    );
  }

  mul(...values: CSSNumberish[]): CSSNumericValue {
    if (!values.length) return this;
    return simplifyProduct([this, ...values.map(toNumericValue)]);
  }

  div(...values: CSSNumberish[]): CSSNumericValue {
    if (!values.length) return this;
    return simplifyProduct([
      this,
      ...values.map((value) => invertForArithmetic(toNumericValue(value))),
    ]);
  }

  min(...values: CSSNumberish[]): CSSNumericValue {
    if (!values.length) return this;
    return simplifyAddLike([this, ...values.map(toNumericValue)], "min");
  }

  max(...values: CSSNumberish[]): CSSNumericValue {
    if (!values.length) return this;
    return simplifyAddLike([this, ...values.map(toNumericValue)], "max");
  }

  equals(...values: CSSNumberish[]): boolean {
    return values.every((value) => numericEquals(this, toNumericValue(value)));
  }

  to(unitValue: string): CSSUnitValue {
    const unit = normalizeUnit(unitValue);
    const value = evaluateNumeric(this);
    const target = evaluateNumeric(new CSSUnitValue(1, unit));
    if (!typeEquals(value.type, target.type) || !atomsEqual(value.atoms, target.atoms)) {
      throw new TypeError("Incompatible units");
    }
    return new CSSUnitValue(value.value / target.value, unit);
  }

  toSum(...unitValues: string[]): CSSMathSum {
    const units = unitValues.map((value) => normalizeUnit(value));
    if (new Set(units).size !== units.length) {
      throw new DOMException("Duplicate units", "SyntaxError");
    }
    const terms = sumTerms(this);
    if (!units.length) {
      const totals = new Map<string, number>();
      for (const term of terms) {
        const unit = canonicalUnit(term.unit);
        const value = unit === term.unit ? term.value : term.to(unit).value;
        totals.set(unit, (totals.get(unit) || 0) + value);
      }
      return new CSSMathSum(
        ...[...totals]
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([unit, value]) => new CSSUnitValue(value, unit)),
      );
    }
    units.slice(1).reduce((type, unit) => addTypes(type, numericType(unit)), numericType(units[0]));
    const totals = units.map(() => 0);
    for (const term of terms) {
      let converted = false;
      for (let i = 0; i < units.length; i++) {
        try {
          totals[i] += term.to(units[i]).value;
          converted = true;
          break;
        } catch {}
      }
      if (!converted) throw new TypeError("Value has units not present in the sum");
    }
    return new CSSMathSum(...units.map((unit, i) => new CSSUnitValue(totals[i], unit)));
  }
}

function canonicalUnit(unit: string): string {
  const type = UNIT_TYPES[unit];
  if (UNIT_FACTORS[unit] == null) return unit;
  if (type === "length") return "px";
  if (type === "angle") return "deg";
  if (type === "time") return "s";
  if (type === "frequency") return "hz";
  if (type === "resolution") return "dppx";
  return unit;
}

export class CSSUnitValue extends CSSNumericValue implements Idl.CSSUnitValue {
  _value: number;
  _unit: string;

  constructor(value: number, unitValue: string) {
    const number = Number(value);
    if (!Number.isFinite(number)) throw new TypeError("CSS unit value must be finite");
    const unit = normalizeUnit(unitValue, true);
    super();
    this._value = number;
    this._unit = unit;
    this._cssText = this.toString();
  }

  get value(): number {
    return this._value;
  }
  set value(value: number) {
    const number = Number(value);
    if (!Number.isFinite(number)) throw new TypeError("CSS unit value must be finite");
    this._value = number;
    this._cssText = this.toString();
  }
  get unit(): string {
    return this._unit;
  }
  type() {
    return numericType(this._unit);
  }
  toString() {
    const suffix = this._unit === "number" ? "" : this._unit === "percent" ? "%" : this._unit;
    return `${formatNumber(this._value)}${suffix}`;
  }
}

export class CSSMathValue extends CSSNumericValue implements Idl.CSSMathValue {
  _operator: Idl.CSSMathOperator = "sum";
  constructor() {
    super();
    return new Proxy(this, {
      set(target, property, value, receiver) {
        if (property === "operator") throw new TypeError("operator is readonly");
        return Reflect.set(target, property, value, receiver);
      },
    });
  }
  get operator() {
    return this._operator;
  }
}

function setMathOperator(value: CSSMathValue, operator: Idl.CSSMathOperator): void {
  Object.defineProperty(value, "_operator", {
    value: operator,
    writable: false,
    enumerable: false,
    configurable: false,
  });
}

function lockSlot<T extends object, K extends keyof T>(value: T, name: K): void {
  Object.defineProperty(value, name, {
    value: value[name],
    writable: false,
    enumerable: false,
    configurable: false,
  });
}

export class CSSNumericArray implements Idl.CSSNumericArray {
  // The constructor defines the indexes as own properties.
  readonly [index: number]: CSSNumericValue;
  _values: CSSNumericValue[];

  constructor(values: CSSNumericValue[]) {
    this._values = Object.freeze(values.slice()) as CSSNumericValue[];
    lockSlot(this, "_values");
    for (let i = 0; i < this._values.length; i++) {
      Object.defineProperty(this, i, {
        value: this._values[i],
        writable: false,
        enumerable: true,
        configurable: false,
      });
    }
  }

  get length() {
    return this._values.length;
  }
  *entries(): IterableIterator<[number, CSSNumericValue]> {
    for (let i = 0; i < this.length; i++) yield [i, this._values[i]];
  }
  *keys(): IterableIterator<number> {
    for (let i = 0; i < this.length; i++) yield i;
  }
  *values(): IterableIterator<CSSNumericValue> {
    yield* this._values;
  }
  forEach(
    callback: (value: CSSNumericValue, index: number, array: CSSNumericArray) => void,
    thisArg?: unknown,
  ): void {
    for (let i = 0; i < this.length; i++) callback.call(thisArg, this._values[i], i, this);
  }
  [Symbol.iterator](): IterableIterator<CSSNumericValue> {
    return this.values();
  }
}

function initializeVariadic(
  self: CSSMathValue & { _values: CSSNumericArray },
  operator: Idl.CSSMathOperator,
  values: CSSNumberish[],
) {
  if (!values.length) throw new DOMException("At least one value is required", "SyntaxError");
  setMathOperator(self, operator);
  const numeric = values.map(toNumericValue);
  numeric.slice(1).reduce((type, value) => addTypes(type, value.type()), numeric[0].type());
  self._values = new CSSNumericArray(numeric);
  lockSlot(self, "_values");
}

function variadicType(values: CSSNumericArray): NumericType {
  return values._values
    .slice(1)
    .reduce((type, value) => addTypes(type, value.type()), values._values[0].type());
}

export class CSSMathSum extends CSSMathValue implements Idl.CSSMathSum {
  _values!: CSSNumericArray;
  constructor(...values: CSSNumberish[]) {
    super();
    initializeVariadic(this, "sum", values);
    this._cssText = this.toString();
  }
  get values() {
    return this._values;
  }
  type() {
    return variadicType(this._values);
  }
  toString() {
    const values = this._values._values;
    let text = String(values[0]);
    for (const value of values.slice(1)) {
      text += value instanceof CSSMathNegate ? ` - ${value.value}` : ` + ${value}`;
    }
    return `calc(${text})`;
  }
}

export class CSSMathProduct extends CSSMathValue implements Idl.CSSMathProduct {
  _values: CSSNumericArray;
  constructor(...values: CSSNumberish[]) {
    super();
    if (!values.length) throw new DOMException("At least one value is required", "SyntaxError");
    setMathOperator(this, "product");
    this._values = new CSSNumericArray(values.map(toNumericValue));
    lockSlot(this, "_values");
    this.type();
    this._cssText = this.toString();
  }
  get values() {
    return this._values;
  }
  type() {
    return this._values._values
      .slice(1)
      .reduce((type, value) => multiplyTypes(type, value.type()), this._values._values[0].type());
  }
  toString() {
    return `calc(${this._values._values.map(String).join(" * ")})`;
  }
}

export class CSSMathNegate extends CSSMathValue implements Idl.CSSMathNegate {
  _value: CSSNumericValue;
  constructor(value: CSSNumberish) {
    super();
    setMathOperator(this, "negate");
    this._value = toNumericValue(value);
    lockSlot(this, "_value");
    this._cssText = this.toString();
  }
  get value() {
    return this._value;
  }
  type() {
    return cloneType(this._value.type());
  }
  toString() {
    return `calc(-1 * ${this._value})`;
  }
}

export class CSSMathInvert extends CSSMathValue implements Idl.CSSMathInvert {
  _value: CSSNumericValue;
  constructor(value: CSSNumberish) {
    super();
    setMathOperator(this, "invert");
    this._value = toNumericValue(value);
    lockSlot(this, "_value");
    this._cssText = this.toString();
  }
  get value() {
    return this._value;
  }
  type() {
    return invertType(this._value.type());
  }
  toString() {
    return `calc(1 / ${this._value})`;
  }
}

export class CSSMathMin extends CSSMathValue implements Idl.CSSMathMin {
  _values!: CSSNumericArray;
  constructor(...values: CSSNumberish[]) {
    super();
    initializeVariadic(this, "min", values);
    this._cssText = this.toString();
  }
  get values() {
    return this._values;
  }
  type() {
    return variadicType(this._values);
  }
  toString() {
    return `min(${this._values._values.join(", ")})`;
  }
}

export class CSSMathMax extends CSSMathValue implements Idl.CSSMathMax {
  _values!: CSSNumericArray;
  constructor(...values: CSSNumberish[]) {
    super();
    initializeVariadic(this, "max", values);
    this._cssText = this.toString();
  }
  get values() {
    return this._values;
  }
  type() {
    return variadicType(this._values);
  }
  toString() {
    return `max(${this._values._values.join(", ")})`;
  }
}

export class CSSMathClamp extends CSSMathValue implements Idl.CSSMathClamp {
  _lower: CSSNumericValue;
  _value: CSSNumericValue;
  _upper: CSSNumericValue;
  constructor(lower: CSSNumberish, value: CSSNumberish, upper: CSSNumberish) {
    super();
    setMathOperator(this, "clamp");
    this._lower = toNumericValue(lower);
    this._value = toNumericValue(value);
    this._upper = toNumericValue(upper);
    lockSlot(this, "_lower");
    lockSlot(this, "_value");
    lockSlot(this, "_upper");
    addTypes(addTypes(this._lower.type(), this._value.type()), this._upper.type());
    this._cssText = this.toString();
  }
  get lower() {
    return this._lower;
  }
  get value() {
    return this._value;
  }
  get upper() {
    return this._upper;
  }
  type() {
    return addTypes(addTypes(this._lower.type(), this._value.type()), this._upper.type());
  }
  toString() {
    return `clamp(${this._lower}, ${this._value}, ${this._upper})`;
  }
}

type CSSNumberish = number | CSSNumericValue;

function toNumericValue(value: CSSNumberish): CSSNumericValue {
  if (value instanceof CSSNumericValue) return value;
  return new CSSUnitValue(value, "number");
}

function negateForArithmetic(value: CSSNumericValue): CSSNumericValue {
  if (value instanceof CSSUnitValue) return new CSSUnitValue(-value.value, value.unit);
  if (value instanceof CSSMathNegate) return value.value;
  return new CSSMathNegate(value);
}

function invertForArithmetic(value: CSSNumericValue): CSSNumericValue {
  if (value instanceof CSSUnitValue && value.unit === "number") {
    if (value.value === 0) throw new RangeError("Division by zero");
    return new CSSUnitValue(1 / value.value, "number");
  }
  if (value instanceof CSSMathInvert) return value.value;
  return new CSSMathInvert(value);
}

function representativeUnit(value: CSSNumericValue): string | null {
  if (value instanceof CSSUnitValue) return value.unit;
  if (value instanceof CSSMathNegate || value instanceof CSSMathInvert)
    return representativeUnit(value.value);
  if (value instanceof CSSMathSum || value instanceof CSSMathMin || value instanceof CSSMathMax) {
    return representativeUnit(value.values._values[0]);
  }
  if (value instanceof CSSMathProduct) return representativeUnit(value.values._values[0]);
  if (value instanceof CSSMathClamp) return representativeUnit(value.lower);
  return null;
}

function simplifyAddLike(
  values: CSSNumericValue[],
  operator: "sum" | "min" | "max",
): CSSNumericValue {
  const flat: CSSNumericValue[] = [];
  for (const value of values) {
    if (
      (operator === "sum" && value instanceof CSSMathSum) ||
      (operator === "min" && value instanceof CSSMathMin) ||
      (operator === "max" && value instanceof CSSMathMax)
    )
      flat.push(...value.values._values);
    else flat.push(value);
  }
  const result =
    operator === "sum"
      ? new CSSMathSum(...flat)
      : operator === "min"
        ? new CSSMathMin(...flat)
        : new CSSMathMax(...flat);
  if (!flat.every((value) => value instanceof CSSUnitValue)) return result;
  const units = flat as CSSUnitValue[];
  if (units.some((value) => value.unit !== units[0].unit)) return result;
  const numbers = units.map((value) => value.value);
  const simplified =
    operator === "sum"
      ? numbers.reduce((a, b) => a + b, 0)
      : operator === "min"
        ? Math.min(...numbers)
        : Math.max(...numbers);
  return new CSSUnitValue(simplified, units[0].unit);
}

function simplifyProduct(values: CSSNumericValue[]): CSSNumericValue {
  const flat: CSSNumericValue[] = [];
  for (const value of values) {
    if (value instanceof CSSMathProduct) flat.push(...value.values._values);
    else flat.push(value);
  }
  const result = new CSSMathProduct(...flat);
  if (!flat.every((value) => value instanceof CSSUnitValue)) return result;
  const units = flat as CSSUnitValue[];
  const dimensional = units.filter((value) => value.unit !== "number");
  if (dimensional.length > 1) return result;
  return new CSSUnitValue(
    units.reduce((product, value) => product * value.value, 1),
    dimensional[0]?.unit || "number",
  );
}

function numericEquals(a: CSSNumericValue, b: CSSNumericValue): boolean {
  if (a.constructor !== b.constructor) return false;
  if (a instanceof CSSUnitValue && b instanceof CSSUnitValue) {
    return a.value === b.value && a.unit === b.unit;
  }
  if (
    (a instanceof CSSMathSum && b instanceof CSSMathSum) ||
    (a instanceof CSSMathMin && b instanceof CSSMathMin) ||
    (a instanceof CSSMathMax && b instanceof CSSMathMax) ||
    (a instanceof CSSMathProduct && b instanceof CSSMathProduct)
  ) {
    const left = a.values._values;
    const right = b.values._values;
    return left.length === right.length && left.every((value, i) => numericEquals(value, right[i]));
  }
  if (
    (a instanceof CSSMathNegate && b instanceof CSSMathNegate) ||
    (a instanceof CSSMathInvert && b instanceof CSSMathInvert)
  )
    return numericEquals(a.value, b.value);
  if (a instanceof CSSMathClamp && b instanceof CSSMathClamp) {
    return (
      numericEquals(a.lower, b.lower) &&
      numericEquals(a.value, b.value) &&
      numericEquals(a.upper, b.upper)
    );
  }
  return a === b;
}

interface EvaluatedNumeric {
  value: number;
  type: NumericType;
  atoms: Record<string, number>;
}

function atomsEqual(a: Record<string, number>, b: Record<string, number>): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  return [...keys].every((key) => (a[key] || 0) === (b[key] || 0));
}

function evaluateNumeric(value: CSSNumericValue): EvaluatedNumeric {
  if (value instanceof CSSUnitValue) {
    const factor =
      value.unit === "number" || value.unit === "percent" || value.unit === "fr"
        ? 1
        : UNIT_FACTORS[value.unit];
    return {
      value: value.value * (factor ?? 1),
      type: value.type(),
      atoms: factor == null ? { [value.unit]: 1 } : {},
    };
  }
  if (value instanceof CSSMathNegate) {
    const inner = evaluateNumeric(value.value);
    return { ...inner, value: -inner.value };
  }
  if (value instanceof CSSMathInvert) {
    const inner = evaluateNumeric(value.value);
    const atoms: Record<string, number> = {};
    for (const unit of Object.keys(inner.atoms)) atoms[unit] = -inner.atoms[unit];
    return { value: 1 / inner.value, type: invertType(inner.type), atoms };
  }
  if (value instanceof CSSMathProduct) {
    return value.values._values.map(evaluateNumeric).reduce((left, right) => {
      const atoms = { ...left.atoms };
      for (const unit of Object.keys(right.atoms)) {
        const exponent = (atoms[unit] || 0) + right.atoms[unit];
        if (exponent) atoms[unit] = exponent;
        else delete atoms[unit];
      }
      return { value: left.value * right.value, type: multiplyTypes(left.type, right.type), atoms };
    });
  }
  if (value instanceof CSSMathClamp) {
    const lower = evaluateNumeric(value.lower);
    const middle = evaluateNumeric(value.value);
    const upper = evaluateNumeric(value.upper);
    if (
      !typeEquals(lower.type, middle.type) ||
      !typeEquals(lower.type, upper.type) ||
      !atomsEqual(lower.atoms, middle.atoms) ||
      !atomsEqual(lower.atoms, upper.atoms)
    ) {
      throw new TypeError("Value cannot be converted to a unit");
    }
    return { ...middle, value: Math.max(lower.value, Math.min(middle.value, upper.value)) };
  }
  if (value instanceof CSSMathSum || value instanceof CSSMathMin || value instanceof CSSMathMax) {
    const evaluated = value.values._values.map(evaluateNumeric);
    const first = evaluated[0];
    if (
      evaluated.some(
        (part) => !typeEquals(first.type, part.type) || !atomsEqual(first.atoms, part.atoms),
      )
    ) {
      throw new TypeError("Value cannot be converted to a unit");
    }
    const numbers = evaluated.map((part) => part.value);
    const result =
      value instanceof CSSMathSum
        ? numbers.reduce((a, b) => a + b, 0)
        : value instanceof CSSMathMin
          ? Math.min(...numbers)
          : Math.max(...numbers);
    return { ...first, value: result };
  }
  throw new TypeError("Value cannot be converted to a unit");
}

function sumTerms(value: CSSNumericValue): CSSUnitValue[] {
  if (value instanceof CSSUnitValue) return [new CSSUnitValue(value.value, value.unit)];
  if (value instanceof CSSMathSum) return value.values._values.flatMap(sumTerms);
  if (value instanceof CSSMathNegate) {
    return sumTerms(value.value).map((term) => new CSSUnitValue(-term.value, term.unit));
  }
  const unit = representativeUnit(value);
  if (!unit) throw new TypeError("Value cannot be represented as a sum");
  return [value.to(unit)];
}

type CSSColorChannel = CSSNumericValue | CSSKeywordValue;

function colorSyntaxError(description: string): never {
  throw new DOMException(description, "SyntaxError");
}

function colorKeyword(value: unknown): CSSKeywordValue | null {
  if (value instanceof CSSKeywordValue && value.value.toLowerCase() === "none") return value;
  if (typeof value === "string" && value.toLowerCase() === "none")
    return new CSSKeywordValue(value);
  return null;
}

function colorPercent(value: unknown, description: string): CSSColorChannel {
  const keyword = colorKeyword(value);
  if (keyword) return keyword;
  if (typeof value === "number") return new CSSUnitValue(value * 100, "percent");
  if (value instanceof CSSNumericValue && hasNumericType(value, { percent: 1 })) return value;
  return colorSyntaxError(`${description} must be a percentage or none`);
}

function colorNumber(value: unknown, description: string): CSSColorChannel {
  const keyword = colorKeyword(value);
  if (keyword) return keyword;
  if (typeof value === "number") return new CSSUnitValue(value, "number");
  if (value instanceof CSSNumericValue && hasNumericType(value, {})) return value;
  return colorSyntaxError(`${description} must be a number or none`);
}

function colorRgbComponent(value: unknown, description: string): CSSColorChannel {
  const keyword = colorKeyword(value);
  if (keyword) return keyword;
  if (typeof value === "number") return new CSSUnitValue(value * 100, "percent");
  if (
    value instanceof CSSNumericValue &&
    (hasNumericType(value, {}) || hasNumericType(value, { percent: 1 }))
  )
    return value;
  return colorSyntaxError(`${description} must be a number, percentage, or none`);
}

function colorAngle(value: unknown, description: string, allowUndefined = false): CSSColorChannel {
  const keyword = colorKeyword(value);
  if (keyword) return keyword;
  if (allowUndefined && value === undefined) return new CSSKeywordValue("undefined");
  if (typeof value === "number") return new CSSUnitValue(value, "deg");
  if (value instanceof CSSNumericValue && hasNumericType(value, { angle: 1 })) return value;
  return colorSyntaxError(`${description} must be an angle or none`);
}

function serializeColorFunction(
  name: string,
  channels: CSSColorChannel[],
  alpha: CSSColorChannel,
): string {
  const alphaText =
    alpha instanceof CSSUnitValue && alpha.unit === "percent" && alpha.value === 100
      ? ""
      : ` / ${alpha}`;
  return `${name}(${channels.join(" ")}${alphaText})`;
}

function simpleColorNumeric(
  token: string,
  kind: "rgb" | "percent" | "number" | "angle",
): CSSColorChannel | null {
  const text = token.trim();
  if (text.toLowerCase() === "none") return new CSSKeywordValue("none");
  const match = /^([+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?)(%|deg|grad|rad|turn)?$/i.exec(text);
  if (!match) return null;
  const value = Number(match[1]);
  const unit = match[2]?.toLowerCase();
  if (unit === "%") return new CSSUnitValue(value, "percent");
  if (unit) return kind === "angle" ? new CSSUnitValue(value, unit) : null;
  if (kind === "percent") return new CSSUnitValue(value * 100, "percent");
  if (kind === "angle") return new CSSUnitValue(value, "deg");
  return new CSSUnitValue(value, "number");
}

function splitColorFunction(body: string): { channels: string[]; alpha?: string } {
  const slash = body.split("/");
  if (slash.length > 2) return { channels: [] };
  const commaSyntax = slash[0].includes(",");
  let channels = commaSyntax ? slash[0].split(",") : slash[0].trim().split(/\s+/);
  let alpha: string | undefined = slash[1]?.trim();
  if (commaSyntax && !alpha && channels.length === 4) alpha = channels.pop()?.trim();
  channels = channels.map((value) => value.trim()).filter(Boolean);
  return { channels, ...(alpha ? { alpha } : {}) };
}

const PINNED_NAMED_COLORS: Record<string, [number, number, number, number?]> = {
  black: [0, 0, 0],
  blue: [0, 0, 255],
  red: [255, 0, 0],
  transparent: [0, 0, 0, 0],
  white: [255, 255, 255],
};

const CSS_COLOR_KEYWORDS = new Set(
  `
  aliceblue antiquewhite aqua aquamarine azure beige bisque blanchedalmond blueviolet brown
  burlywood cadetblue chartreuse chocolate coral cornflowerblue cornsilk crimson cyan darkblue
  darkcyan darkgoldenrod darkgray darkgreen darkgrey darkkhaki darkmagenta darkolivegreen
  darkorange darkorchid darkred darksalmon darkseagreen darkslateblue darkslategray darkslategrey
  darkturquoise darkviolet deeppink deepskyblue dimgray dimgrey dodgerblue firebrick floralwhite
  forestgreen fuchsia gainsboro ghostwhite gold goldenrod gray green greenyellow grey honeydew
  hotpink indianred indigo ivory khaki lavender lavenderblush lawngreen lemonchiffon lightblue
  lightcoral lightcyan lightgoldenrodyellow lightgray lightgreen lightgrey lightpink lightsalmon
  lightseagreen lightskyblue lightslategray lightslategrey lightsteelblue lightyellow lime limegreen
  linen magenta maroon mediumaquamarine mediumblue mediumorchid mediumpurple mediumseagreen
  mediumslateblue mediumspringgreen mediumturquoise mediumvioletred midnightblue mintcream
  mistyrose moccasin navajowhite navy oldlace olive olivedrab orange orangered orchid palegoldenrod
  palegreen paleturquoise palevioletred papayawhip peachpuff peru pink plum powderblue purple
  rebeccapurple rosybrown royalblue saddlebrown salmon sandybrown seagreen seashell sienna silver
  skyblue slateblue slategray slategrey snow springgreen steelblue tan teal thistle tomato turquoise
  violet wheat whitesmoke yellow yellowgreen
`
    .trim()
    .split(/\s+/),
);

const CSS_SYSTEM_COLOR_KEYWORDS = new Set(
  `
  accentcolor accentcolortext activetext buttonborder buttonface buttontext canvas canvastext field
  fieldtext graytext highlight highlighttext linktext mark marktext selecteditem selecteditemtext
  visitedtext
`
    .trim()
    .split(/\s+/),
);

function parseColorValue(cssText: unknown): CSSStyleValue {
  const text = String(cssText).trim();
  const lower = text.toLowerCase();
  if (CSS_SYSTEM_COLOR_KEYWORDS.has(lower)) return new CSSKeywordValue(lower);
  const named = PINNED_NAMED_COLORS[lower];
  if (named) {
    return new CSSRGB(
      new CSSUnitValue(named[0], "number"),
      new CSSUnitValue(named[1], "number"),
      new CSSUnitValue(named[2], "number"),
      new CSSUnitValue(named[3] ?? 100, "percent"),
    );
  }
  if (CSS_COLOR_KEYWORDS.has(lower)) return new CSSKeywordValue(lower);
  const hex = /^#([\da-f]{3,4}|[\da-f]{6}|[\da-f]{8})$/i.exec(text);
  if (hex) {
    const expanded =
      hex[1].length <= 4 ? [...hex[1]].map((digit) => digit + digit).join("") : hex[1];
    const channels = [0, 2, 4].map((index) => parseInt(expanded.slice(index, index + 2), 16));
    const alpha = expanded.length === 8 ? (parseInt(expanded.slice(6), 16) / 255) * 100 : 100;
    return new CSSRGB(
      new CSSUnitValue(channels[0], "number"),
      new CSSUnitValue(channels[1], "number"),
      new CSSUnitValue(channels[2], "number"),
      new CSSUnitValue(alpha, "percent"),
    );
  }
  const fn = /^([a-z]+)\((.*)\)$/i.exec(text);
  if (!fn) return colorSyntaxError("Invalid color");
  const name = fn[1].toLowerCase();
  const parts = splitColorFunction(fn[2]);
  const alpha =
    parts.alpha === undefined
      ? new CSSUnitValue(100, "percent")
      : simpleColorNumeric(parts.alpha, "percent");
  if (!alpha || parts.channels.length !== 3) return colorSyntaxError("Invalid color");
  const parsed = (kinds: Array<"rgb" | "percent" | "number" | "angle">) =>
    parts.channels.map((channel, index) => simpleColorNumeric(channel, kinds[index]));
  let channels: Array<CSSColorChannel | null>;
  if (name === "rgb" || name === "rgba") {
    channels = parsed(["rgb", "rgb", "rgb"]);
    if (channels.every(Boolean))
      return new CSSRGB(
        ...(channels as [CSSColorChannel, CSSColorChannel, CSSColorChannel]),
        alpha,
      );
  } else if (name === "hsl" || name === "hsla") {
    channels = parsed(["angle", "percent", "percent"]);
    if (channels.every(Boolean))
      return new CSSHSL(
        ...(channels as [CSSColorChannel, CSSColorChannel, CSSColorChannel]),
        alpha,
      );
  } else if (name === "hwb") {
    channels = parsed(["angle", "percent", "percent"]);
    if (channels.every(Boolean))
      return new CSSHWB(
        ...(channels as [CSSNumericValue, CSSColorChannel, CSSColorChannel]),
        alpha,
      );
  } else if (name === "lab" || name === "oklab") {
    channels = parsed(["percent", "number", "number"]);
    if (channels.every(Boolean)) {
      const args = channels as [CSSColorChannel, CSSColorChannel, CSSColorChannel];
      return name === "lab" ? new CSSLab(...args, alpha) : new CSSOKLab(...args, alpha);
    }
  } else if (name === "lch" || name === "oklch") {
    channels = parsed(["percent", "percent", "angle"]);
    if (channels.every(Boolean)) {
      const args = channels as [CSSColorChannel, CSSColorChannel, CSSColorChannel];
      return name === "lch" ? new CSSLCH(...args, alpha) : new CSSOKLCH(...args, alpha);
    }
  }
  return colorSyntaxError("Invalid color");
}

export class CSSColorValue extends CSSStyleValue implements Idl.CSSColorValue {
  static parse(cssText: string): CSSStyleValue {
    return parseColorValue(cssText);
  }
}

export class CSSRGB extends CSSColorValue implements Idl.CSSRGB {
  _r!: CSSColorChannel;
  _g!: CSSColorChannel;
  _b!: CSSColorChannel;
  _alpha!: CSSColorChannel;
  constructor(
    r: Idl.CSSColorRGBComp,
    g: Idl.CSSColorRGBComp,
    b: Idl.CSSColorRGBComp,
    alpha: Idl.CSSColorPercent = 1,
  ) {
    super();
    this.r = r;
    this.g = g;
    this.b = b;
    this.alpha = alpha;
  }
  get r(): CSSColorChannel {
    return this._r;
  }
  set r(value: Idl.CSSColorRGBComp) {
    this._r = colorRgbComponent(value, "r");
  }
  get g(): CSSColorChannel {
    return this._g;
  }
  set g(value: Idl.CSSColorRGBComp) {
    this._g = colorRgbComponent(value, "g");
  }
  get b(): CSSColorChannel {
    return this._b;
  }
  set b(value: Idl.CSSColorRGBComp) {
    this._b = colorRgbComponent(value, "b");
  }
  get alpha(): CSSColorChannel {
    return this._alpha;
  }
  set alpha(value: Idl.CSSColorPercent) {
    this._alpha = colorPercent(value, "alpha");
  }
  toString() {
    return serializeColorFunction("rgb", [this.r, this.g, this.b], this.alpha);
  }
}

export class CSSHSL extends CSSColorValue implements Idl.CSSHSL {
  _h!: CSSColorChannel;
  _s!: CSSColorChannel;
  _l!: CSSColorChannel;
  _alpha!: CSSColorChannel;
  constructor(
    h: Idl.CSSColorAngle,
    s: Idl.CSSColorPercent,
    l: Idl.CSSColorPercent,
    alpha: Idl.CSSColorPercent = 1,
  ) {
    super();
    this.h = h;
    this.s = s;
    this.l = l;
    this.alpha = alpha;
  }
  get h(): CSSColorChannel {
    return this._h;
  }
  set h(value: Idl.CSSColorAngle) {
    this._h = colorAngle(value, "h", true);
  }
  get s(): CSSColorChannel {
    return this._s;
  }
  set s(value: Idl.CSSColorPercent) {
    this._s = colorPercent(value, "s");
  }
  get l(): CSSColorChannel {
    return this._l;
  }
  set l(value: Idl.CSSColorPercent) {
    this._l = colorPercent(value, "l");
  }
  get alpha(): CSSColorChannel {
    return this._alpha;
  }
  set alpha(value: Idl.CSSColorPercent) {
    this._alpha = colorPercent(value, "alpha");
  }
  toString() {
    return serializeColorFunction("hsl", [this.h, this.s, this.l], this.alpha);
  }
}

export class CSSHWB extends CSSColorValue implements Idl.CSSHWB {
  _h!: CSSColorChannel;
  _w!: CSSColorChannel;
  _b!: CSSColorChannel;
  _alpha!: CSSColorChannel;
  constructor(
    h: Idl.CSSNumericValue,
    w: Idl.CSSColorPercent,
    b: Idl.CSSColorPercent,
    alpha: Idl.CSSColorPercent = 1,
  ) {
    super();
    this.h = h;
    this.w = w;
    this.b = b;
    this.alpha = alpha;
  }
  // CSSHWB's members are type gaps. h takes the pinned IDL's type; w, b and
  // alpha also take a keyword (none), as the other color classes do.
  get h(): CSSColorChannel {
    return this._h;
  }
  set h(value: Idl.CSSNumericValue) {
    if (!(value instanceof CSSNumericValue)) throw new TypeError("h must be a CSSNumericValue");
    this._h = colorAngle(value, "h");
  }
  get w(): CSSColorChannel {
    return this._w;
  }
  set w(value: Idl.CSSColorPercent) {
    this._w = colorPercent(value, "w");
  }
  get b(): CSSColorChannel {
    return this._b;
  }
  set b(value: Idl.CSSColorPercent) {
    this._b = colorPercent(value, "b");
  }
  get alpha(): CSSColorChannel {
    return this._alpha;
  }
  set alpha(value: Idl.CSSColorPercent) {
    this._alpha = colorPercent(value, "alpha");
  }
  toString() {
    return serializeColorFunction("hwb", [this.h, this.w, this.b], this.alpha);
  }
}

abstract class CSSCartesianColor extends CSSColorValue {
  _l!: CSSColorChannel;
  _a!: CSSColorChannel;
  _b!: CSSColorChannel;
  _alpha!: CSSColorChannel;
  _functionName = "lab";
  constructor(
    l: Idl.CSSColorPercent,
    a: Idl.CSSColorNumber,
    b: Idl.CSSColorNumber,
    alpha: Idl.CSSColorPercent = 1,
  ) {
    super();
    this.l = l;
    this.a = a;
    this.b = b;
    this.alpha = alpha;
  }
  get l(): CSSColorChannel {
    return this._l;
  }
  set l(value: Idl.CSSColorPercent) {
    this._l = colorPercent(value, "l");
  }
  get a(): CSSColorChannel {
    return this._a;
  }
  set a(value: Idl.CSSColorNumber) {
    this._a = colorNumber(value, "a");
  }
  get b(): CSSColorChannel {
    return this._b;
  }
  set b(value: Idl.CSSColorNumber) {
    this._b = colorNumber(value, "b");
  }
  get alpha(): CSSColorChannel {
    return this._alpha;
  }
  set alpha(value: Idl.CSSColorPercent) {
    this._alpha = colorPercent(value, "alpha");
  }
  toString(): string {
    return serializeColorFunction(this._functionName, [this.l, this.a, this.b], this.alpha);
  }
}

export class CSSLab extends CSSCartesianColor implements Idl.CSSLab {}
export class CSSOKLab extends CSSCartesianColor implements Idl.CSSOKLab {
  override _functionName = "oklab";
}

abstract class CSSPolarColor extends CSSColorValue {
  _l!: CSSColorChannel;
  _c!: CSSColorChannel;
  _h!: CSSColorChannel;
  _alpha!: CSSColorChannel;
  _functionName = "lch";
  constructor(
    l: Idl.CSSColorPercent,
    c: Idl.CSSColorPercent,
    h: Idl.CSSColorAngle,
    alpha: Idl.CSSColorPercent = 1,
  ) {
    super();
    this.l = l;
    this.c = c;
    this.h = h;
    this.alpha = alpha;
  }
  get l(): CSSColorChannel {
    return this._l;
  }
  set l(value: Idl.CSSColorPercent) {
    this._l = colorPercent(value, "l");
  }
  get c(): CSSColorChannel {
    return this._c;
  }
  set c(value: Idl.CSSColorPercent) {
    this._c = colorPercent(value, "c");
  }
  get h(): CSSColorChannel {
    return this._h;
  }
  set h(value: Idl.CSSColorAngle) {
    this._h = colorAngle(value, "h");
  }
  get alpha(): CSSColorChannel {
    return this._alpha;
  }
  set alpha(value: Idl.CSSColorPercent) {
    this._alpha = colorPercent(value, "alpha");
  }
  toString(): string {
    return serializeColorFunction(this._functionName, [this.l, this.c, this.h], this.alpha);
  }
}

export class CSSLCH extends CSSPolarColor implements Idl.CSSLCH {}
export class CSSOKLCH extends CSSPolarColor implements Idl.CSSOKLCH {
  override _functionName = "oklch";
}

function colorKeywordish(value: unknown): CSSKeywordValue {
  return value instanceof CSSKeywordValue ? value : new CSSKeywordValue(String(value));
}

function colorAlpha(value: unknown): CSSNumericValue {
  const numeric =
    value instanceof CSSNumericValue ? value : new CSSUnitValue(Number(value), "number");
  if (!hasNumericType(numeric, {})) throw new TypeError("alpha must be a number");
  return numeric;
}

function numericIndex(property: PropertyKey): number | null {
  if (typeof property !== "string" || !/^(0|[1-9]\d*)$/.test(property)) return null;
  const index = Number(property);
  return Number.isSafeInteger(index) ? index : null;
}

function colorChannels(values: unknown): CSSColorChannel[] {
  if (values == null || typeof (values as Iterable<unknown>)[Symbol.iterator] !== "function") {
    throw new TypeError("channels must be a sequence");
  }
  return Array.from(values as Iterable<unknown>, (value) => colorPercent(value, "channel"));
}

function observableColorChannels(values: unknown): CSSColorChannel[] {
  return new Proxy(colorChannels(values), {
    set(target, property, value) {
      const index = numericIndex(property);
      return Reflect.set(
        target,
        property,
        index === null ? value : colorPercent(value, "channel"),
        target,
      );
    },
    defineProperty(target, property, descriptor) {
      const index = numericIndex(property);
      if (index !== null) {
        if (!("value" in descriptor)) throw new TypeError("channel must be a value");
        descriptor = { ...descriptor, value: colorPercent(descriptor.value, "channel") };
      }
      return Reflect.defineProperty(target, property, descriptor);
    },
  });
}

export class CSSColor extends CSSColorValue implements Idl.CSSColor {
  _colorSpace!: CSSKeywordValue;
  _channels: CSSColorChannel[];
  _alpha!: CSSNumericValue;
  constructor(
    colorSpace: Idl.CSSKeywordish,
    channels: Idl.CSSColorPercent[],
    alpha: Idl.CSSNumberish = 1,
  ) {
    super();
    this._channels = observableColorChannels(channels);
    lockSlot(this, "_channels");
    this.colorSpace = colorSpace;
    this.alpha = alpha;
  }
  get colorSpace(): CSSKeywordValue {
    return this._colorSpace;
  }
  set colorSpace(value: Idl.CSSKeywordish) {
    this._colorSpace = colorKeywordish(value);
  }
  get channels(): CSSColorChannel[] {
    return this._channels;
  }
  set channels(value: Idl.CSSColorPercent[]) {
    const channels = colorChannels(value);
    this._channels.splice(0, this._channels.length, ...channels);
  }
  get alpha(): CSSNumericValue {
    return this._alpha;
  }
  set alpha(value: Idl.CSSNumberish) {
    this._alpha = colorAlpha(value);
  }
  toString() {
    const alpha =
      this.alpha instanceof CSSUnitValue && this.alpha.unit === "number" && this.alpha.value === 1
        ? ""
        : ` / ${this.alpha}`;
    return `color(${this.colorSpace} ${this.channels.join(" ")}${alpha})`;
  }
}

function copyColorInterfaceMembers(source: object, targets: object[]): void {
  for (const target of targets) {
    for (const name of Object.getOwnPropertyNames(source)) {
      if (name === "constructor") continue;
      const descriptor = Object.getOwnPropertyDescriptor(source, name);
      if (descriptor) Object.defineProperty(target, name, descriptor);
    }
  }
}
copyColorInterfaceMembers(CSSCartesianColor.prototype, [CSSLab.prototype, CSSOKLab.prototype]);
copyColorInterfaceMembers(CSSPolarColor.prototype, [CSSLCH.prototype, CSSOKLCH.prototype]);

function callTypedParser(name: "parseTypedNumericValue", cssText: string): unknown;
function callTypedParser(name: "parseTypedStyleValue", property: string, cssText: string): unknown;
function callTypedParser(
  name: "parseTypedNumericValue" | "parseTypedStyleValue",
  first: string,
  second?: string,
): unknown {
  try {
    return name === "parseTypedNumericValue"
      ? opts?.parseTypedNumericValue?.(first)
      : opts?.parseTypedStyleValue?.(first, second || "");
  } catch {
    return null;
  }
}

function dtoObject(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function dtoNumericValues(value: unknown): CSSNumericValue[] | null {
  if (!Array.isArray(value)) return null;
  const out: CSSNumericValue[] = [];
  for (const item of value) {
    const parsed = typedValueFromDto(item);
    if (!(parsed instanceof CSSNumericValue)) return null;
    out.push(parsed);
  }
  return out;
}

function typedUnparsedSegments(value: unknown): Array<string | CSSVariableReferenceValue> | null {
  if (!Array.isArray(value)) return null;
  const segments: Array<string | CSSVariableReferenceValue> = [];
  for (const item of value) {
    const segment = dtoObject(item);
    if (segment?.type === "string" && typeof segment.value === "string") {
      segments.push(segment.value);
    } else if (segment?.type === "variable" && typeof segment.name === "string") {
      const fallbackSegments =
        segment.fallback === undefined ? null : typedUnparsedSegments(segment.fallback);
      if (segment.fallback !== undefined && !fallbackSegments) return null;
      segments.push(
        new CSSVariableReferenceValue(
          segment.name,
          fallbackSegments ? new CSSUnparsedValue(fallbackSegments) : null,
        ),
      );
    } else {
      return null;
    }
  }
  return segments;
}

function typedValueFromDto(value: unknown, _associatedProperty?: string): CSSStyleValue | null {
  const dto = dtoObject(value);
  if (!dto || typeof dto.type !== "string") return null;
  if (dto.type === "keyword" && typeof dto.value === "string")
    return new CSSKeywordValue(dto.value);
  if (dto.type === "unit" && typeof dto.value === "number" && typeof dto.unit === "string") {
    return new CSSUnitValue(dto.value, dto.unit === "%" ? "percent" : dto.unit);
  }
  const values = dtoNumericValues(dto.values);
  if (dto.type === "sum" && values) return new CSSMathSum(...values);
  if (dto.type === "product" && values) return new CSSMathProduct(...values);
  if (dto.type === "min" && values) return new CSSMathMin(...values);
  if (dto.type === "max" && values) return new CSSMathMax(...values);
  const numeric = typedValueFromDto(dto.value);
  if (dto.type === "negate" && numeric instanceof CSSNumericValue)
    return new CSSMathNegate(numeric);
  if (dto.type === "invert" && numeric instanceof CSSNumericValue)
    return new CSSMathInvert(numeric);
  if (dto.type === "clamp") {
    const lower = typedValueFromDto(dto.lower);
    const middle = typedValueFromDto(dto.value);
    const upper = typedValueFromDto(dto.upper);
    if (
      lower instanceof CSSNumericValue &&
      middle instanceof CSSNumericValue &&
      upper instanceof CSSNumericValue
    ) {
      return new CSSMathClamp(lower, middle, upper);
    }
  }
  if (dto.type === "transform" && Array.isArray(dto.components)) {
    const components: CSSTransformComponent[] = [];
    for (const component of dto.components) {
      const parsed = transformComponentFromDto(component);
      if (!parsed) return null;
      components.push(parsed);
    }
    if (components.length) return new CSSTransformValue(components);
  }
  if (dto.type === "unparsed") {
    const segments = typedUnparsedSegments(dto.segments);
    if (segments) return new CSSUnparsedValue(segments);
  }
  if (dto.type === "generic") return null;
  return null;
}

function reifyTypedList(property: string, cssText: string): CSSStyleValue[] | null {
  const result = dtoObject(callTypedParser("parseTypedStyleValue", property, cssText));
  if (!result || !Array.isArray(result.values)) return null;
  const values: CSSStyleValue[] = [];
  for (const item of result.values) {
    const dto = dtoObject(item);
    if (dto?.type === "keyword" || dto?.type === "generic") return null;
    const value = typedValueFromDto(item, property);
    if (!value) return null;
    value._associatedProperty = property;
    values.push(value);
  }
  return values.length ? values : null;
}

export class CSSVariableReferenceValue implements Idl.CSSVariableReferenceValue {
  _variable: string;
  _fallback: CSSUnparsedValue | null;

  constructor(variable: string, fallback: CSSUnparsedValue | null = null) {
    const name = String(variable);
    if (!/^--[^\s]+$/.test(name)) throw new TypeError("Invalid custom property name");
    if (fallback !== null && !(fallback instanceof CSSUnparsedValue)) {
      throw new TypeError("Fallback must be a CSSUnparsedValue");
    }
    this._variable = name;
    this._fallback = fallback;
  }

  get variable() {
    return this._variable;
  }
  set variable(value: string) {
    const name = String(value);
    if (!/^--[^\s]+$/.test(name)) throw new TypeError("Invalid custom property name");
    this._variable = name;
  }
  get fallback() {
    return this._fallback;
  }
  toString() {
    return `var(${this._variable}${this.fallback ? `, ${this.fallback}` : ""})`;
  }
}

export class CSSUnparsedValue extends CSSStyleValue implements Idl.CSSUnparsedValue {
  [index: number]: string | CSSVariableReferenceValue;
  _length: number;

  constructor(members: Iterable<string | CSSVariableReferenceValue>) {
    super();
    const values = Array.from(members);
    this._length = values.length;
    for (let i = 0; i < values.length; i++) {
      const value = values[i];
      if (typeof value !== "string" && !(value instanceof CSSVariableReferenceValue)) {
        throw new TypeError("Invalid CSSUnparsedValue member");
      }
      this[i] = value;
    }
    this._cssText = this.toString();
  }

  get length() {
    return this._length;
  }
  *[Symbol.iterator](): IterableIterator<string | CSSVariableReferenceValue> {
    for (let i = 0; i < this.length; i++) yield this[i];
  }
  toString() {
    return Array.from(this).map(String).join("");
  }
}

function hasNumericType(value: CSSNumericValue, expected: NumericType): boolean {
  return typeEquals(value.type(), expected);
}

function asNumeric(value: unknown, description: string): CSSNumericValue {
  if (!(value instanceof CSSNumericValue)) throw new TypeError(`${description} must be numeric`);
  return value;
}

function asNumberish(value: unknown, description: string): CSSNumericValue {
  const numeric =
    typeof value === "number" ? new CSSUnitValue(value, "number") : asNumeric(value, description);
  if (!hasNumericType(numeric, {})) throw new TypeError(`${description} must be a number`);
  return numeric;
}

function asAngle(value: unknown, description: string): CSSNumericValue {
  const numeric = asNumeric(value, description);
  if (!hasNumericType(numeric, { angle: 1 }))
    throw new TypeError(`${description} must be an angle`);
  return numeric;
}

function asLength(value: unknown, description: string): CSSNumericValue {
  const numeric = asNumeric(value, description);
  if (!hasNumericType(numeric, { length: 1 }))
    throw new TypeError(`${description} must be a length`);
  return numeric;
}

function asLengthPercentage(value: unknown, description: string): CSSNumericValue {
  const numeric = asNumeric(value, description);
  const type = numeric.type();
  if (
    !typeEquals(type, { length: 1 }) &&
    !typeEquals(type, { percent: 1 }) &&
    !typeEquals(type, { length: 1, percentHint: "length" })
  ) {
    throw new TypeError(`${description} must be a length or percentage`);
  }
  return numeric;
}

function numericIn(value: CSSNumericValue, unit: string): number {
  return value.to(unit).value;
}

function serializeTransformNumeric(value: CSSNumericValue): string {
  if (value instanceof CSSUnitValue) {
    const unit = canonicalUnit(value.unit);
    return String(unit === value.unit ? value : value.to(unit));
  }
  if (value instanceof CSSMathSum) {
    const parts = value.values._values.map((part, index) => ({
      text: serializeTransformNumeric(part),
      unit: representativeUnit(part) || "",
      index,
    }));
    parts.sort((a, b) => a.unit.localeCompare(b.unit) || a.index - b.index);
    return `calc(${parts.map((part) => part.text).join(" + ")})`;
  }
  if (value instanceof CSSMathProduct) {
    const numerator: CSSNumericValue[] = [];
    const denominator: CSSNumericValue[] = [];
    for (const part of value.values._values) {
      if (part instanceof CSSMathInvert) denominator.push(part.value);
      else numerator.push(part);
    }
    numerator.sort((a, b) => Number(!hasNumericType(a, {})) - Number(!hasNumericType(b, {})));
    let text = numerator.map(serializeTransformNumeric).join(" * ") || "1";
    for (const part of denominator) text += ` / ${serializeTransformNumeric(part)}`;
    return `calc(${text})`;
  }
  if (value instanceof CSSMathNegate) return `calc(-1 * ${serializeTransformNumeric(value.value)})`;
  if (value instanceof CSSMathInvert) return `calc(1 / ${serializeTransformNumeric(value.value)})`;
  if (value instanceof CSSMathMin)
    return `min(${value.values._values.map(serializeTransformNumeric).join(", ")})`;
  if (value instanceof CSSMathMax)
    return `max(${value.values._values.map(serializeTransformNumeric).join(", ")})`;
  if (value instanceof CSSMathClamp) {
    return `clamp(${serializeTransformNumeric(value.lower)}, ${serializeTransformNumeric(value.value)}, ${serializeTransformNumeric(value.upper)})`;
  }
  return String(value);
}

interface MatrixState {
  values: number[];
  is2D: boolean;
}
const matrixStates = new WeakMap<DOMMatrixReadOnly, MatrixState>();

function matrixState(matrix: DOMMatrixReadOnly): MatrixState {
  const state = matrixStates.get(matrix);
  if (!state) throw new TypeError("Illegal invocation");
  return state;
}

function parseMatrixString(value: string): number[] | null {
  const text = value.trim();
  if (text === "" || text === "none") return [1, 0, 0, 1, 0, 0];
  const match = /^matrix(3d)?\(([^)]*)\)$/i.exec(text);
  if (!match) return null;
  const parts = match[2].split(",").map((part) => Number(part.trim()));
  if (parts.some((part) => !Number.isFinite(part))) return null;
  const wanted = match[1] ? 16 : 6;
  return parts.length === wanted ? parts : null;
}

function matrixValues(values: string | Iterable<number> | ArrayLike<number>): {
  values: number[];
  is2D: boolean;
} {
  const parsed = typeof values === "string" ? parseMatrixString(values) : null;
  const input = parsed ?? Array.from(values as Iterable<number>, Number);
  if (input.length === 6) {
    const [a, b, c, d, e, f] = input;
    return { values: [a, b, 0, 0, c, d, 0, 0, 0, 0, 1, 0, e, f, 0, 1], is2D: true };
  }
  if (input.length === 16) return { values: input, is2D: false };
  throw new TypeError("Matrix needs 6 or 16 values");
}

function multiplyMatrices(left: readonly number[], right: readonly number[]): number[] {
  const result = Array(16).fill(0) as number[];
  for (let column = 0; column < 4; column++) {
    for (let row = 0; row < 4; row++) {
      for (let k = 0; k < 4; k++) {
        result[column * 4 + row] += left[k * 4 + row] * right[column * 4 + k];
      }
    }
  }
  return result;
}

function matrixFrom4x4(values: number[], is2D: boolean): DOMMatrix {
  const matrix = new DOMMatrix(values);
  matrixState(matrix).is2D = is2D;
  return matrix;
}

function twoDimensionalValues(values: readonly number[]): number[] {
  return [values[0], values[1], values[4], values[5], values[12], values[13]];
}

export class DOMMatrixReadOnly implements Idl.DOMMatrixReadOnly {
  constructor(values: string | Iterable<number> | ArrayLike<number> = [1, 0, 0, 1, 0, 0]) {
    matrixStates.set(this, matrixValues(values));
  }

  get a() {
    return matrixState(this).values[0];
  }
  get b() {
    return matrixState(this).values[1];
  }
  get c() {
    return matrixState(this).values[4];
  }
  get d() {
    return matrixState(this).values[5];
  }
  get e() {
    return matrixState(this).values[12];
  }
  get f() {
    return matrixState(this).values[13];
  }
  get m11() {
    return matrixState(this).values[0];
  }
  get m12() {
    return matrixState(this).values[1];
  }
  get m13() {
    return matrixState(this).values[2];
  }
  get m14() {
    return matrixState(this).values[3];
  }
  get m21() {
    return matrixState(this).values[4];
  }
  get m22() {
    return matrixState(this).values[5];
  }
  get m23() {
    return matrixState(this).values[6];
  }
  get m24() {
    return matrixState(this).values[7];
  }
  get m31() {
    return matrixState(this).values[8];
  }
  get m32() {
    return matrixState(this).values[9];
  }
  get m33() {
    return matrixState(this).values[10];
  }
  get m34() {
    return matrixState(this).values[11];
  }
  get m41() {
    return matrixState(this).values[12];
  }
  get m42() {
    return matrixState(this).values[13];
  }
  get m43() {
    return matrixState(this).values[14];
  }
  get m44() {
    return matrixState(this).values[15];
  }
  get is2D() {
    return matrixState(this).is2D;
  }

  multiply(other: DOMMatrixReadOnly): DOMMatrix {
    if (!(other instanceof DOMMatrixReadOnly)) throw new TypeError("Matrix required");
    return matrixFrom4x4(
      multiplyMatrices(matrixState(this).values, matrixState(other).values),
      this.is2D && other.is2D,
    );
  }

  translate(tx = 0, ty = 0, tz = 0): DOMMatrix {
    return this.multiply(
      matrixFrom4x4(
        [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, Number(tx), Number(ty), Number(tz), 1],
        Number(tz) === 0,
      ),
    );
  }

  scale(scaleX = 1, scaleY = scaleX, scaleZ = 1): DOMMatrix {
    return this.multiply(
      matrixFrom4x4(
        [Number(scaleX), 0, 0, 0, 0, Number(scaleY), 0, 0, 0, 0, Number(scaleZ), 0, 0, 0, 0, 1],
        Number(scaleZ) === 1,
      ),
    );
  }

  rotate(angle = 0): DOMMatrix {
    return this.rotateAxisAngle(0, 0, 1, angle);
  }

  rotateAxisAngle(x = 0, y = 0, z = 0, angle = 0): DOMMatrix {
    let nx = Number(x),
      ny = Number(y),
      nz = Number(z);
    const length = Math.hypot(nx, ny, nz);
    if (!length) return matrixFrom4x4(matrixState(this).values.slice(), this.is2D);
    nx /= length;
    ny /= length;
    nz /= length;
    const radians = (Number(angle) * Math.PI) / 180;
    const c = Math.cos(radians),
      s = Math.sin(radians),
      t = 1 - c;
    const rotation = [
      t * nx * nx + c,
      t * nx * ny + s * nz,
      t * nx * nz - s * ny,
      0,
      t * nx * ny - s * nz,
      t * ny * ny + c,
      t * ny * nz + s * nx,
      0,
      t * nx * nz + s * ny,
      t * ny * nz - s * nx,
      t * nz * nz + c,
      0,
      0,
      0,
      0,
      1,
    ];
    return this.multiply(matrixFrom4x4(rotation, nx === 0 && ny === 0));
  }

  skewX(angle = 0): DOMMatrix {
    const tangent = Math.tan((Number(angle) * Math.PI) / 180);
    return this.multiply(new DOMMatrix([1, 0, tangent, 1, 0, 0]));
  }

  skewY(angle = 0): DOMMatrix {
    const tangent = Math.tan((Number(angle) * Math.PI) / 180);
    return this.multiply(new DOMMatrix([1, tangent, 0, 1, 0, 0]));
  }

  toFloat32Array(): Float32Array {
    return new Float32Array(matrixState(this).values);
  }
  toFloat64Array(): Float64Array {
    return new Float64Array(matrixState(this).values);
  }

  toString() {
    const stored = matrixState(this).values;
    const values = this.is2D ? twoDimensionalValues(stored) : stored;
    return `${this.is2D ? "matrix" : "matrix3d"}(${values.join(", ")})`;
  }
}

export class DOMMatrix extends DOMMatrixReadOnly implements Idl.DOMMatrix {
  _set(index: number, value: unknown, twoDimensionalValue: number | null = null): void {
    const state = matrixState(this);
    const number = Number(value);
    state.values[index] = number;
    if (twoDimensionalValue !== null && number !== twoDimensionalValue) state.is2D = false;
  }
  multiplySelf(other: DOMMatrixReadOnly): this {
    const result = this.multiply(other);
    matrixStates.set(this, { values: matrixState(result).values.slice(), is2D: result.is2D });
    return this;
  }
  translateSelf(tx = 0, ty = 0, tz = 0): this {
    const result = this.translate(tx, ty, tz);
    matrixStates.set(this, { values: matrixState(result).values.slice(), is2D: result.is2D });
    return this;
  }
  scaleSelf(scaleX = 1, scaleY = scaleX, scaleZ = 1): this {
    const result = this.scale(scaleX, scaleY, scaleZ);
    matrixStates.set(this, { values: matrixState(result).values.slice(), is2D: result.is2D });
    return this;
  }
  rotateSelf(angle = 0): this {
    const result = this.rotate(angle);
    matrixStates.set(this, { values: matrixState(result).values.slice(), is2D: result.is2D });
    return this;
  }
}

const MATRIX_FIELDS: Record<string, [number, number | null]> = {
  a: [0, null],
  b: [1, null],
  c: [4, null],
  d: [5, null],
  e: [12, null],
  f: [13, null],
  m11: [0, null],
  m12: [1, null],
  m13: [2, 0],
  m14: [3, 0],
  m21: [4, null],
  m22: [5, null],
  m23: [6, 0],
  m24: [7, 0],
  m31: [8, 0],
  m32: [9, 0],
  m33: [10, 1],
  m34: [11, 0],
  m41: [12, null],
  m42: [13, null],
  m43: [14, 0],
  m44: [15, 1],
};
for (const [name, [index, twoDimensionalValue]] of Object.entries(MATRIX_FIELDS)) {
  Object.defineProperty(DOMMatrix.prototype, name, {
    get(this: DOMMatrix) {
      return matrixState(this).values[index];
    },
    set(this: DOMMatrix, value: number) {
      this._set(index, value, twoDimensionalValue);
    },
    enumerable: true,
    configurable: true,
  });
}

export class CSSTransformComponent implements Idl.CSSTransformComponent {
  _is2D = true;
  get is2D() {
    return this._is2D;
  }
  set is2D(value: boolean) {
    this._is2D = Boolean(value);
  }
  toMatrix(): DOMMatrix {
    return new DOMMatrix();
  }
  toString() {
    return String(this.toMatrix());
  }
}

export class CSSTranslate extends CSSTransformComponent implements Idl.CSSTranslate {
  _x!: CSSNumericValue;
  _y!: CSSNumericValue;
  _z!: CSSNumericValue;
  constructor(x: CSSNumericValue, y: CSSNumericValue, z?: CSSNumericValue) {
    super();
    this.x = x;
    this.y = y;
    this._z = asLength(arguments.length < 3 ? new CSSUnitValue(0, "px") : z, "z");
    this._is2D = arguments.length < 3;
  }
  get x(): CSSNumericValue {
    return this._x;
  }
  set x(value: Idl.CSSNumericValue) {
    this._x = asLengthPercentage(value, "x");
  }
  get y(): CSSNumericValue {
    return this._y;
  }
  set y(value: Idl.CSSNumericValue) {
    this._y = asLengthPercentage(value, "y");
  }
  get z(): CSSNumericValue {
    return this._z;
  }
  set z(value: Idl.CSSNumericValue) {
    this._z = asLength(value, "z");
  }
  toMatrix() {
    const x = numericIn(this.x, "px"),
      y = numericIn(this.y, "px");
    return new DOMMatrix().translate(x, y, this.is2D ? 0 : numericIn(this.z, "px"));
  }
  toString() {
    const x = serializeTransformNumeric(this._x),
      y = serializeTransformNumeric(this._y);
    return this.is2D
      ? `translate(${x}, ${y})`
      : `translate3d(${x}, ${y}, ${serializeTransformNumeric(this._z)})`;
  }
}

export class CSSRotate extends CSSTransformComponent implements Idl.CSSRotate {
  _x!: CSSNumericValue;
  _y!: CSSNumericValue;
  _z!: CSSNumericValue;
  _angle!: CSSNumericValue;
  constructor(
    x: CSSNumberish | CSSNumericValue,
    y?: CSSNumberish,
    z?: CSSNumberish,
    angle?: CSSNumericValue,
  ) {
    super();
    if (arguments.length === 1) {
      this.x = 0;
      this.y = 0;
      this.z = 1;
      this.angle = x as CSSNumericValue;
    } else {
      this.x = x;
      this._y = asNumberish(y, "y");
      this._z = asNumberish(z, "z");
      this._angle = asAngle(angle, "angle");
      this._is2D = false;
    }
  }
  get x(): CSSNumericValue {
    return this._x;
  }
  set x(value: Idl.CSSNumberish) {
    this._x = asNumberish(value, "x");
  }
  get y(): CSSNumericValue {
    return this._y;
  }
  set y(value: Idl.CSSNumberish) {
    this._y = asNumberish(value, "y");
  }
  get z(): CSSNumericValue {
    return this._z;
  }
  set z(value: Idl.CSSNumberish) {
    this._z = asNumberish(value, "z");
  }
  get angle(): CSSNumericValue {
    return this._angle;
  }
  set angle(value: Idl.CSSNumericValue) {
    this._angle = asAngle(value, "angle");
  }
  toMatrix() {
    const angle = numericIn(this.angle, "deg");
    if (this.is2D) return new DOMMatrix().rotate(angle);
    return new DOMMatrix().rotateAxisAngle(
      numericIn(this._x, "number"),
      numericIn(this._y, "number"),
      numericIn(this._z, "number"),
      angle,
    );
  }
  toString() {
    const angle = serializeTransformNumeric(this._angle);
    return this.is2D
      ? `rotate(${angle})`
      : `rotate3d(${serializeTransformNumeric(this._x)}, ${serializeTransformNumeric(this._y)}, ${serializeTransformNumeric(this._z)}, ${angle})`;
  }
}

export class CSSScale extends CSSTransformComponent implements Idl.CSSScale {
  _x!: CSSNumericValue;
  _y!: CSSNumericValue;
  _z!: CSSNumericValue;
  constructor(x: CSSNumberish, y: CSSNumberish, z?: CSSNumberish) {
    super();
    this.x = x;
    this.y = y;
    this._z = asNumberish(arguments.length < 3 ? 1 : z, "z");
    this._is2D = arguments.length < 3;
  }
  get x(): CSSNumericValue {
    return this._x;
  }
  set x(value: Idl.CSSNumberish) {
    this._x = asNumberish(value, "x");
  }
  get y(): CSSNumericValue {
    return this._y;
  }
  set y(value: Idl.CSSNumberish) {
    this._y = asNumberish(value, "y");
  }
  get z(): CSSNumericValue {
    return this._z;
  }
  set z(value: Idl.CSSNumberish) {
    this._z = asNumberish(value, "z");
  }
  toMatrix() {
    return new DOMMatrix().scale(
      numericIn(this._x, "number"),
      numericIn(this._y, "number"),
      this.is2D ? 1 : numericIn(this._z, "number"),
    );
  }
  toString() {
    const x = serializeTransformNumeric(this._x),
      y = serializeTransformNumeric(this._y);
    return this.is2D
      ? `scale(${x}, ${y})`
      : `scale3d(${x}, ${y}, ${serializeTransformNumeric(this._z)})`;
  }
}

export class CSSSkew extends CSSTransformComponent implements Idl.CSSSkew {
  _ax!: CSSNumericValue;
  _ay!: CSSNumericValue;
  constructor(ax: CSSNumericValue, ay: CSSNumericValue) {
    super();
    this.ax = ax;
    this.ay = ay;
  }
  get ax() {
    return this._ax;
  }
  set ax(value: CSSNumericValue) {
    this._ax = asAngle(value, "ax");
  }
  get ay() {
    return this._ay;
  }
  set ay(value: CSSNumericValue) {
    this._ay = asAngle(value, "ay");
  }
  override set is2D(_value: boolean) {}
  override get is2D() {
    return true;
  }
  toMatrix() {
    const ax = Math.tan(numericIn(this.ax, "rad")),
      ay = Math.tan(numericIn(this.ay, "rad"));
    return new DOMMatrix([1, ay, ax, 1, 0, 0]);
  }
  toString() {
    const ax = serializeTransformNumeric(this._ax);
    return numericIn(this._ay, "deg") === 0
      ? `skew(${ax})`
      : `skew(${ax}, ${serializeTransformNumeric(this._ay)})`;
  }
}
export class CSSSkewX extends CSSTransformComponent implements Idl.CSSSkewX {
  _ax!: CSSNumericValue;
  constructor(ax: CSSNumericValue) {
    super();
    this.ax = ax;
  }
  get ax() {
    return this._ax;
  }
  set ax(value: CSSNumericValue) {
    this._ax = asAngle(value, "ax");
  }
  override set is2D(_value: boolean) {}
  override get is2D() {
    return true;
  }
  toMatrix() {
    return new DOMMatrix().skewX(numericIn(this.ax, "deg"));
  }
  toString() {
    return `skewX(${serializeTransformNumeric(this._ax)})`;
  }
}
export class CSSSkewY extends CSSTransformComponent implements Idl.CSSSkewY {
  _ay!: CSSNumericValue;
  constructor(ay: CSSNumericValue) {
    super();
    this.ay = ay;
  }
  get ay() {
    return this._ay;
  }
  set ay(value: CSSNumericValue) {
    this._ay = asAngle(value, "ay");
  }
  override set is2D(_value: boolean) {}
  override get is2D() {
    return true;
  }
  toMatrix() {
    return new DOMMatrix().skewY(numericIn(this.ay, "deg"));
  }
  toString() {
    return `skewY(${serializeTransformNumeric(this._ay)})`;
  }
}
export class CSSPerspective extends CSSTransformComponent implements Idl.CSSPerspective {
  _length!: CSSNumericValue | CSSKeywordValue;
  constructor(length: CSSNumericValue | CSSKeywordValue | "none") {
    super();
    this.length = length;
    this._is2D = false;
  }
  get length() {
    return this._length;
  }
  set length(value: CSSNumericValue | CSSKeywordValue | "none") {
    if (value === "none") value = new CSSKeywordValue("none");
    if (value instanceof CSSKeywordValue && value.value === "none") this._length = value;
    else this._length = asLength(value, "length");
  }
  override set is2D(_value: boolean) {}
  override get is2D() {
    return false;
  }
  toMatrix() {
    if (this._length instanceof CSSKeywordValue) return new DOMMatrix();
    const length = Math.max(1, numericIn(this._length, "px"));
    return matrixFrom4x4([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, -1 / length, 0, 0, 0, 1], false);
  }
  toString() {
    const value =
      this._length instanceof CSSUnitValue && this._length.value < 0
        ? `calc(${serializeTransformNumeric(this._length)})`
        : this._length instanceof CSSNumericValue
          ? serializeTransformNumeric(this._length)
          : String(this._length);
    return `perspective(${value})`;
  }
}

export class CSSMatrixComponent extends CSSTransformComponent implements Idl.CSSMatrixComponent {
  _matrix!: DOMMatrix;
  constructor(matrix: DOMMatrixReadOnly, options?: { is2D?: unknown } | null) {
    super();
    if (!(matrix instanceof DOMMatrixReadOnly))
      throw new TypeError("matrix must be a DOMMatrixReadOnly");
    const state = matrixState(matrix);
    this._matrix = matrixFrom4x4(state.values.slice(), state.is2D);
    this._is2D =
      options && typeof options === "object" && "is2D" in options
        ? Boolean(options.is2D)
        : this.matrix.is2D;
  }
  get matrix() {
    return this._matrix;
  }
  set matrix(value: DOMMatrix) {
    if (!(value instanceof DOMMatrix)) throw new TypeError("matrix must be a DOMMatrix");
    this._matrix = value;
  }
  toMatrix() {
    const values = matrixState(this.matrix).values;
    return this.is2D ? new DOMMatrix(twoDimensionalValues(values)) : new DOMMatrix(values);
  }
  toString() {
    return String(this.toMatrix());
  }
}

function transformComponentFromDto(value: unknown): CSSTransformComponent | null {
  const dto = dtoObject(value);
  if (!dto || typeof dto.type !== "string") return null;
  const numeric = (member: string) => typedValueFromDto(dto[member]);
  try {
    let component: CSSTransformComponent | null = null;
    if (dto.type === "translate")
      component = new CSSTranslate(
        numeric("x") as CSSNumericValue,
        numeric("y") as CSSNumericValue,
        numeric("z") as CSSNumericValue,
      );
    else if (dto.type === "rotate")
      component = new CSSRotate(
        numeric("x") as CSSNumericValue,
        numeric("y") as CSSNumericValue,
        numeric("z") as CSSNumericValue,
        numeric("angle") as CSSNumericValue,
      );
    else if (dto.type === "scale")
      component = new CSSScale(
        numeric("x") as CSSNumericValue,
        numeric("y") as CSSNumericValue,
        numeric("z") as CSSNumericValue,
      );
    else if (dto.type === "skew")
      component = new CSSSkew(numeric("ax") as CSSNumericValue, numeric("ay") as CSSNumericValue);
    else if (dto.type === "skew_x") component = new CSSSkewX(numeric("angle") as CSSNumericValue);
    else if (dto.type === "skew_y") component = new CSSSkewY(numeric("angle") as CSSNumericValue);
    else if (dto.type === "perspective") {
      const length = typedValueFromDto(dto.length);
      component = new CSSPerspective(length as CSSNumericValue | CSSKeywordValue);
    } else if (dto.type === "matrix" && Array.isArray(dto.matrix) && dto.matrix.length === 16) {
      component = new CSSMatrixComponent(new DOMMatrix(dto.matrix as number[]));
    }
    if (component && typeof dto.is_2d === "boolean") component.is2D = dto.is_2d;
    return component;
  } catch {
    return null;
  }
}

const transformComponents = new WeakMap<CSSTransformValue, CSSTransformComponent[]>();
function componentsFor(value: CSSTransformValue): CSSTransformComponent[] {
  const components = transformComponents.get(value);
  if (!components) throw new TypeError("Illegal invocation");
  return components;
}

export class CSSTransformValue extends CSSStyleValue implements Idl.CSSTransformValue {
  [index: number]: CSSTransformComponent;
  constructor(components: Iterable<CSSTransformComponent>) {
    super();
    if (components == null) throw new TypeError("Transform components are required");
    const values = Array.from(components);
    if (!values.length || values.some((value) => !(value instanceof CSSTransformComponent))) {
      throw new TypeError("CSSTransformValue requires transform components");
    }
    transformComponents.set(this, values);
    const proxy = new Proxy(this, {
      get(target, property, receiver) {
        const index = numericIndex(property);
        return index === null
          ? Reflect.get(target, property, receiver)
          : componentsFor(target)[index];
      },
      set(target, property, value, receiver) {
        const index = numericIndex(property);
        if (index !== null) {
          if (!(value instanceof CSSTransformComponent))
            throw new TypeError("Transform component required");
          const stored = componentsFor(target);
          if (index > stored.length) throw new TypeError("Transform index is out of range");
          stored[index] = value;
          return true;
        }
        if (property === "length" || property === "is2D" || property === "_components") {
          throw new TypeError(`${String(property)} is readonly`);
        }
        return Reflect.set(target, property, value, receiver);
      },
      defineProperty(target, property, descriptor) {
        if (property === "_components") throw new TypeError("_components is private");
        return Reflect.defineProperty(target, property, descriptor);
      },
      deleteProperty(target, property) {
        if (numericIndex(property) !== null) return false;
        return Reflect.deleteProperty(target, property);
      },
      has(target, property) {
        const index = numericIndex(property);
        return index === null
          ? Reflect.has(target, property)
          : index < componentsFor(target).length;
      },
      ownKeys(target) {
        return [
          ...componentsFor(target).map((_, index) => String(index)),
          ...Reflect.ownKeys(target),
        ];
      },
      getOwnPropertyDescriptor(target, property) {
        const index = numericIndex(property);
        const stored = componentsFor(target);
        if (index !== null && index < stored.length) {
          return { value: stored[index], writable: true, enumerable: true, configurable: true };
        }
        return Reflect.getOwnPropertyDescriptor(target, property);
      },
    });
    transformComponents.set(proxy, values);
    return proxy;
  }
  get length() {
    return componentsFor(this).length;
  }
  get is2D() {
    return componentsFor(this).every((value) => value.is2D);
  }
  *entries(): IterableIterator<[number, CSSTransformComponent]> {
    const components = componentsFor(this);
    for (let i = 0; i < components.length; i++) yield [i, components[i]];
  }
  *keys(): IterableIterator<number> {
    for (let i = 0; i < this.length; i++) yield i;
  }
  *values(): IterableIterator<CSSTransformComponent> {
    yield* componentsFor(this);
  }
  forEach(
    callback: (value: CSSTransformComponent, index: number, array: CSSTransformValue) => void,
    thisArg?: unknown,
  ): void {
    const components = componentsFor(this);
    for (let i = 0; i < components.length; i++) callback.call(thisArg, components[i], i, this);
  }
  [Symbol.iterator](): IterableIterator<CSSTransformComponent> {
    return this.values();
  }
  toMatrix() {
    return componentsFor(this).reduce(
      (matrix, component) => matrix.multiply(component.toMatrix()),
      new DOMMatrix(),
    );
  }
  toString() {
    return componentsFor(this).map(String).join(" ");
  }
}

function normalizeProperty(name: unknown): string {
  const property = String(name);
  return property.startsWith("--") ? property : property.toLowerCase();
}

const supportedPropertyCache = new Map<string, boolean>();
function assertSupportedProperty(property: string) {
  if (property.startsWith("--")) return;
  let supported = supportedPropertyCache.get(property);
  if (supported === undefined) {
    const canon =
      opts && typeof opts.canonicalizeInlineStyle === "function"
        ? opts.canonicalizeInlineStyle
        : null;
    if (!canon) return;
    try {
      supported = canon(`${property}: initial`).length > 0;
    } catch {
      supported = false;
    }
    supportedPropertyCache.set(property, supported);
  }
  if (!supported) throw new TypeError(`Unsupported property: ${property}`);
}

const IMAGE_PROPERTIES = new Set([
  "background-image",
  "border-image-source",
  "list-style-image",
  "mask-image",
  "shape-outside",
]);

const LIST_VALUED_PROPERTIES = new Set([
  "animation-composition",
  "animation-delay",
  "animation-direction",
  "animation-duration",
  "animation-fill-mode",
  "animation-iteration-count",
  "animation-name",
  "animation-play-state",
  "animation-timeline",
  "animation-timing-function",
  "background-attachment",
  "background-clip",
  "background-image",
  "background-origin",
  "background-position",
  "background-repeat",
  "background-size",
  "mask-clip",
  "mask-composite",
  "mask-image",
  "mask-mode",
  "mask-origin",
  "mask-position",
  "mask-repeat",
  "mask-size",
  "transition-behavior",
  "transition-delay",
  "transition-duration",
  "transition-timing-function",
]);

function isColorProperty(property: string): boolean {
  return (
    property === "color" ||
    property === "accent-color" ||
    property === "caret-color" ||
    property === "fill" ||
    property === "stroke" ||
    property.endsWith("-color")
  );
}

function splitTopLevelCommas(text: string): string[] {
  const values: string[] = [];
  let start = 0;
  let depth = 0;
  let quote = "";
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (quote) {
      if (char === "\\") i++;
      else if (char === quote) quote = "";
    } else if (char === '"' || char === "'") quote = char;
    else if (char === "(") depth++;
    else if (char === ")") depth--;
    else if (char === "," && depth === 0) {
      values.push(text.slice(start, i).trim());
      start = i + 1;
    }
  }
  values.push(text.slice(start).trim());
  return values;
}

function hasTopLevelSemicolon(text: string): boolean {
  let depth = 0;
  let quote = "";
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (quote) {
      if (char === "\\") i++;
      else if (char === quote) quote = "";
    } else if (char === '"' || char === "'") quote = char;
    else if (char === "(") depth++;
    else if (char === ")") depth--;
    else if (char === ";" && depth === 0) return true;
  }
  return false;
}

function hasTopLevelImportant(text: string): boolean {
  let depth = 0;
  let quote = "";
  let bang = -1;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (quote) {
      if (char === "\\") i++;
      else if (char === quote) quote = "";
    } else if (char === '"' || char === "'") quote = char;
    else if (char === "(") depth++;
    else if (char === ")") depth--;
    else if (char === "!" && depth === 0) bang = i;
  }
  return bang >= 0 && /^!\s*important\s*$/i.test(text.slice(bang));
}

function reify(property: string, cssText: string): CSSStyleValue | undefined {
  const text = String(cssText).trim();
  if (!text) return undefined;
  if (property.startsWith("--")) return new CSSUnparsedValue([text]);
  if (IMAGE_PROPERTIES.has(property) && /^url\(/i.test(text))
    return new CSSImageValue(text, property);
  if (/^var\(/i.test(text)) {
    const match = /^var\(\s*(--[^,\s)]+)(?:\s*,\s*(.*))?\)$/i.exec(text);
    if (match) {
      const fallback = match[2] == null ? null : new CSSUnparsedValue([match[2]]);
      return new CSSUnparsedValue([new CSSVariableReferenceValue(match[1], fallback)]);
    }
  }
  const typed = reifyTypedList(property, text);
  if (typed?.length === 1) return typed[0];
  const canon =
    opts && typeof opts.canonicalizeInlineStyle === "function"
      ? opts.canonicalizeInlineStyle
      : null;
  if (canon) {
    try {
      const declarations = canon(`${property}: ${text}`);
      if (declarations.length > 1) {
        return new CSSStyleValue(text, property);
      }
    } catch {}
  }
  const calc = /^calc\((.*)\)$/i.exec(text);
  if (calc) {
    const terms = calc[1].split(/\s+\+\s+/).map((term) => reifyNumeric(term));
    if (terms.every((term) => term !== null))
      return new CSSMathSum(...(terms as CSSNumericValue[]));
  }
  const numeric = reifyNumeric(text);
  if (numeric) return numeric;
  const comma = text.indexOf(",");
  if (comma >= 0) {
    const firstListValue = text.slice(0, comma).trim();
    const firstNumeric = reifyNumeric(firstListValue);
    if (firstNumeric) return firstNumeric;
  }
  if (/^[a-zA-Z_-][a-zA-Z0-9_-]*$/.test(text)) {
    if (isColorProperty(property)) {
      const keyword = text.toLowerCase();
      const supported =
        keyword === "currentcolor" ||
        (keyword === "auto" && (property === "accent-color" || property === "caret-color"));
      return supported ? new CSSKeywordValue(text) : new CSSStyleValue(text, property);
    }
    if (property === "font-family") return new CSSStyleValue(text, property);
    if (property === "transition-property" && text.toLowerCase() !== "none") {
      return new CSSStyleValue(text, property);
    }
    if (property === "will-change" && text.toLowerCase() !== "auto") {
      return new CSSStyleValue(text, property);
    }
    return new CSSKeywordValue(text);
  }
  return new CSSStyleValue(text, property);
}

function reifyNumeric(text: string): CSSUnitValue | null {
  const match = /^([+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?)(%|[a-zA-Z]+)?$/i.exec(text.trim());
  if (!match) return null;
  const rawUnit = match[2] || "number";
  const unit = rawUnit === "%" ? "percent" : rawUnit;
  try {
    return new CSSUnitValue(Number(match[1]), unit);
  } catch {
    return null;
  }
}

interface StyleDeclarationLike {
  cssText: string;
  length?: number;
  item?(index: number): string;
  getPropertyValue(name: string): string;
  setProperty?(name: string, value: string): void;
  removeProperty?(name: string): string;
}

export class StylePropertyMapReadOnly
  implements Iterable<[string, CSSStyleValue[]]>, Idl.StylePropertyMapReadOnly
{
  _declaration: () => StyleDeclarationLike;
  constructor(declaration: () => StyleDeclarationLike) {
    this._declaration = declaration;
  }

  get(propertyName: string) {
    const property = normalizeProperty(propertyName);
    assertSupportedProperty(property);
    return this.getAll(property)[0];
  }
  getAll(propertyName: string) {
    const property = normalizeProperty(propertyName);
    assertSupportedProperty(property);
    const text = this._declaration().getPropertyValue(property);
    if (!text) return [];
    const parts = LIST_VALUED_PROPERTIES.has(property) ? splitTopLevelCommas(text) : [text];
    const values = parts
      .map((part) => reify(property, part))
      .filter((value): value is CSSStyleValue => value !== undefined);
    for (const value of values) value._associatedProperty = property;
    return values;
  }
  has(propertyName: string) {
    return this.get(propertyName) !== undefined;
  }
  protected _entries() {
    const declaration = this._declaration();
    const entries: [string, CSSStyleValue[]][] = [];
    const seen = new Set<string>();
    if (typeof declaration.item === "function" && typeof declaration.length === "number") {
      for (let i = 0; i < declaration.length; i++) {
        const property = declaration.item(i);
        if (!property || seen.has(property)) continue;
        seen.add(property);
        const values = this.getAll(property);
        if (values.length) entries.push([property, values]);
      }
    }
    return entries;
  }
  get size() {
    return this._entries().length;
  }
  [Symbol.iterator](): IterableIterator<[string, CSSStyleValue[]]> {
    return this._entries()[Symbol.iterator]();
  }
  entries(): IterableIterator<[string, CSSStyleValue[]]> {
    return this._entries()[Symbol.iterator]();
  }
  keys(): IterableIterator<string> {
    return this._entries()
      .map(([key]) => key)
      [Symbol.iterator]();
  }
  values(): IterableIterator<CSSStyleValue[]> {
    return this._entries()
      .map(([, value]) => value)
      [Symbol.iterator]();
  }
  forEach(
    callback: (value: CSSStyleValue[], key: string, map: StylePropertyMapReadOnly) => void,
    thisArg?: unknown,
  ): void {
    for (const [key, value] of this) callback.call(thisArg, value, key, this);
  }
}

export class StylePropertyMap extends StylePropertyMapReadOnly implements Idl.StylePropertyMap {
  _associatedValues = new Map<string, { declarationValue: string; value: CSSStyleValue }>();

  get(propertyName: string) {
    const property = normalizeProperty(propertyName);
    assertSupportedProperty(property);
    const associated = this._associatedValues.get(property);
    if (
      associated &&
      this._declaration().getPropertyValue(property) === associated.declarationValue
    ) {
      const value = cloneAssociatedValue(associated.value, property);
      value._associatedProperty = property;
      return value;
    }
    this._associatedValues.delete(property);
    return super.get(property);
  }
  set(propertyName: string, ...values: Array<CSSStyleValue | string>) {
    const property = normalizeProperty(propertyName);
    assertSupportedProperty(property);
    if (
      values.length === 0 ||
      (values.length > 1 && !LIST_VALUED_PROPERTIES.has(property)) ||
      values.some((value) => typeof value !== "string" && !(value instanceof CSSStyleValue))
    ) {
      throw new TypeError("Expected one CSSStyleValue or string");
    }
    for (const value of values) {
      if (
        value instanceof CSSStyleValue &&
        value._associatedProperty &&
        value._associatedProperty !== property
      ) {
        throw new TypeError("CSSStyleValue is associated with another property");
      }
    }
    const value = values.length === 1 ? values[0] : values.map(String).join(", ");
    if (
      values.length > 1 &&
      values.some((part) => part instanceof CSSUnparsedValue || /var\(/i.test(String(part)))
    ) {
      throw new TypeError("Cannot combine a variable reference with other values");
    }
    let cssText = String(value);
    if (hasTopLevelSemicolon(cssText)) throw new TypeError(`Invalid value for ${property}`);
    let associatedValue = values.length === 1 ? values[0] : value;
    const canon =
      opts && typeof opts.canonicalizeInlineStyle === "function"
        ? opts.canonicalizeInlineStyle
        : null;
    let valid = property.startsWith("--") && cssText !== "";
    let typeAccepted = true;
    if (canon) {
      try {
        const declarations = canon(`${property}: ${cssText}`);
        valid = Array.isArray(declarations) && declarations.length > 0;
        const universal =
          value instanceof CSSUnparsedValue ||
          (value instanceof CSSKeywordValue &&
            ["initial", "inherit", "unset", "revert"].includes(value.value));
        if (
          value instanceof CSSStyleValue &&
          Object.getPrototypeOf(value) !== CSSStyleValue.prototype &&
          !universal &&
          declarations.length > 1
        )
          valid = false;
        if (value instanceof CSSUnitValue) {
          const probe = new CSSUnitValue(1, value.unit);
          typeAccepted = canon(`${property}: ${probe}`).length > 0;
          if (valid && !typeAccepted) valid = false;
        }
      } catch {
        valid = false;
      }
    }
    if (!valid && typeAccepted && value instanceof CSSUnitValue) {
      const calcText = `calc(${cssText})`;
      try {
        const declarations = canon?.(`${property}: ${calcText}`) || [];
        valid = declarations.length > 0;
      } catch {
        valid = false;
      }
      if (valid) {
        cssText = calcText;
        associatedValue = new CSSMathSum(cloneAssociatedValue(value, property) as CSSNumericValue);
      }
    }
    if (!valid) throw new TypeError(`Invalid value for ${property}`);
    let storedAssociated =
      associatedValue instanceof CSSStyleValue
        ? cloneAssociatedValue(associatedValue, property)
        : null;
    const declaration = this._declaration();
    const previous = declaration.getPropertyValue(property);
    declaration.setProperty?.(property, cssText);
    let written = declaration.getPropertyValue(property);
    if (written === previous && written !== cssText) {
      declaration.removeProperty?.(property);
      declaration.setProperty?.(property, cssText);
      written = declaration.getPropertyValue(property);
      if (!written && previous) declaration.setProperty?.(property, previous);
    }
    if (!written && value instanceof CSSUnitValue && value.value < 0) {
      const calcText = `calc(${String(value)})`;
      declaration.setProperty?.(property, calcText);
      written = declaration.getPropertyValue(property);
      if (written) {
        associatedValue = new CSSMathSum(cloneAssociatedValue(value, property) as CSSNumericValue);
        storedAssociated = cloneAssociatedValue(associatedValue, property);
      }
    }
    if (!written) {
      throw new TypeError(`Invalid value for ${property}`);
    }
    if (storedAssociated) {
      this._associatedValues.set(property, {
        declarationValue: written,
        value: storedAssociated,
      });
    } else {
      this._associatedValues.delete(property);
    }
  }
  append(propertyName: string, ...values: Array<CSSStyleValue | string>) {
    const property = normalizeProperty(propertyName);
    assertSupportedProperty(property);
    if (
      !LIST_VALUED_PROPERTIES.has(property) ||
      values.length === 0 ||
      values.some((value) => value instanceof CSSUnparsedValue || /^var\(/i.test(String(value)))
    ) {
      throw new TypeError("Property does not accept multiple values");
    }
    const current = this._declaration().getPropertyValue(property);
    const shorthand = property.startsWith("transition-")
      ? this._declaration().getPropertyValue("transition")
      : "";
    if (/var\(/i.test(current) || /var\(/i.test(shorthand)) {
      throw new TypeError("Cannot append to a variable reference");
    }
    const combined = [...(current ? splitTopLevelCommas(current) : []), ...values.map(String)].join(
      ", ",
    );
    this.set(property, combined);
  }
  delete(propertyName: string) {
    const property = normalizeProperty(propertyName);
    assertSupportedProperty(property);
    this._associatedValues.delete(property);
    this._declaration().removeProperty?.(property);
  }
  clear() {
    this._associatedValues.clear();
    const declaration = this._declaration();
    declaration.cssText = "";
  }
}

function cloneAssociatedValue(value: CSSStyleValue, property: string): CSSStyleValue {
  if (value instanceof CSSTransformValue) {
    return new CSSTransformValue(Array.from(value, cloneTransformComponent));
  }
  if (value instanceof CSSColor) {
    return new CSSColor(
      new CSSKeywordValue(value.colorSpace.value),
      value.channels.map(cloneColorChannel),
      cloneNumericValue(value.alpha),
    );
  }
  if (value instanceof CSSRGB) {
    return new CSSRGB(
      cloneColorChannel(value.r),
      cloneColorChannel(value.g),
      cloneColorChannel(value.b),
      cloneColorChannel(value.alpha),
    );
  }
  if (value instanceof CSSHSL) {
    return new CSSHSL(
      cloneColorChannel(value.h),
      cloneColorChannel(value.s),
      cloneColorChannel(value.l),
      cloneColorChannel(value.alpha),
    );
  }
  if (value instanceof CSSHWB) {
    return new CSSHWB(
      cloneColorChannel(value.h) as CSSNumericValue,
      cloneColorChannel(value.w),
      cloneColorChannel(value.b),
      cloneColorChannel(value.alpha),
    );
  }
  if (value instanceof CSSLab) {
    return new CSSLab(
      cloneColorChannel(value.l),
      cloneColorChannel(value.a),
      cloneColorChannel(value.b),
      cloneColorChannel(value.alpha),
    );
  }
  if (value instanceof CSSLCH) {
    return new CSSLCH(
      cloneColorChannel(value.l),
      cloneColorChannel(value.c),
      cloneColorChannel(value.h),
      cloneColorChannel(value.alpha),
    );
  }
  if (value instanceof CSSOKLab) {
    return new CSSOKLab(
      cloneColorChannel(value.l),
      cloneColorChannel(value.a),
      cloneColorChannel(value.b),
      cloneColorChannel(value.alpha),
    );
  }
  if (value instanceof CSSOKLCH) {
    return new CSSOKLCH(
      cloneColorChannel(value.l),
      cloneColorChannel(value.c),
      cloneColorChannel(value.h),
      cloneColorChannel(value.alpha),
    );
  }
  if (value instanceof CSSUnitValue) return new CSSUnitValue(value.value, value.unit);
  if (value instanceof CSSKeywordValue) return new CSSKeywordValue(value.value);
  if (value instanceof CSSMathSum) {
    const parts = Array.from(value.values, cloneNumericValue);
    const first = parts[0];
    if (first instanceof CSSUnitValue) {
      return new CSSMathSum(
        ...parts.map((part) => {
          try {
            return part.to(first.unit);
          } catch {
            return part;
          }
        }),
      );
    }
    return new CSSMathSum(...parts);
  }
  if (value instanceof CSSNumericValue) return cloneNumericValue(value);
  if (value instanceof CSSUnparsedValue) {
    return new CSSUnparsedValue(
      Array.from(value, (part) => {
        if (typeof part === "string") return part;
        return new CSSVariableReferenceValue(
          part.variable,
          part.fallback
            ? (cloneAssociatedValue(part.fallback, property) as CSSUnparsedValue)
            : null,
        );
      }),
    );
  }
  return new CSSStyleValue(String(value), property);
}

function cloneTransformComponent(value: CSSTransformComponent): CSSTransformComponent {
  let clone: CSSTransformComponent;
  if (value instanceof CSSTranslate) {
    clone = new CSSTranslate(
      cloneNumericValue(toNumericValue(value.x)),
      cloneNumericValue(toNumericValue(value.y)),
      cloneNumericValue(toNumericValue(value.z)),
    );
  } else if (value instanceof CSSRotate) {
    clone = new CSSRotate(
      cloneNumericValue(toNumericValue(value.x)),
      cloneNumericValue(toNumericValue(value.y)),
      cloneNumericValue(toNumericValue(value.z)),
      cloneNumericValue(value.angle),
    );
  } else if (value instanceof CSSScale) {
    clone = new CSSScale(
      cloneNumericValue(toNumericValue(value.x)),
      cloneNumericValue(toNumericValue(value.y)),
      cloneNumericValue(toNumericValue(value.z)),
    );
  } else if (value instanceof CSSSkew) {
    clone = new CSSSkew(cloneNumericValue(value.ax), cloneNumericValue(value.ay));
  } else if (value instanceof CSSSkewX) {
    clone = new CSSSkewX(cloneNumericValue(value.ax));
  } else if (value instanceof CSSSkewY) {
    clone = new CSSSkewY(cloneNumericValue(value.ay));
  } else if (value instanceof CSSPerspective) {
    const length = value.length;
    clone = new CSSPerspective(
      typeof length === "string"
        ? length
        : length instanceof CSSKeywordValue
          ? new CSSKeywordValue(length.value)
          : cloneNumericValue(length),
    );
  } else if (value instanceof CSSMatrixComponent) {
    clone = new CSSMatrixComponent(cloneMatrix(value.matrix), { is2D: value.is2D });
  } else {
    throw new TypeError("Unknown CSS transform component");
  }
  clone.is2D = value.is2D;
  return clone;
}

function cloneMatrix(value: DOMMatrixReadOnly): DOMMatrix {
  const state = matrixState(value);
  const clone = new DOMMatrix(state.values);
  matrixState(clone).is2D = state.is2D;
  return clone;
}

function cloneColorChannel(value: CSSColorChannel): CSSColorChannel {
  return value instanceof CSSKeywordValue
    ? new CSSKeywordValue(value.value)
    : cloneNumericValue(value);
}

function cloneNumericValue(value: CSSNumericValue): CSSNumericValue {
  if (value instanceof CSSUnitValue) return new CSSUnitValue(value.value, value.unit);
  if (value instanceof CSSMathSum)
    return new CSSMathSum(...Array.from(value.values, cloneNumericValue));
  if (value instanceof CSSMathProduct)
    return new CSSMathProduct(...Array.from(value.values, cloneNumericValue));
  if (value instanceof CSSMathNegate) return new CSSMathNegate(cloneNumericValue(value.value));
  if (value instanceof CSSMathInvert) return new CSSMathInvert(cloneNumericValue(value.value));
  if (value instanceof CSSMathMin)
    return new CSSMathMin(...Array.from(value.values, cloneNumericValue));
  if (value instanceof CSSMathMax)
    return new CSSMathMax(...Array.from(value.values, cloneNumericValue));
  if (value instanceof CSSMathClamp) {
    return new CSSMathClamp(
      cloneNumericValue(value.lower),
      cloneNumericValue(value.value),
      cloneNumericValue(value.upper),
    );
  }
  throw new TypeError("Unknown CSS numeric value");
}

export function makeAttributeStyleMap(element: {
  style: StyleDeclarationLike;
}): Idl.StylePropertyMap {
  return new StylePropertyMap(() => element.style);
}

export function makeStylePropertyMap(declaration: StyleDeclarationLike): Idl.StylePropertyMap {
  return new StylePropertyMap(() => declaration);
}

export function makeComputedStyleMap(
  element: unknown,
  getComputedStyle: (element: unknown) => StyleDeclarationLike,
  specified?: StylePropertyMap,
): Idl.StylePropertyMapReadOnly {
  const map = new StylePropertyMapReadOnly(() => getComputedStyle(element));
  if (!specified) return map;
  const getAll = map.getAll.bind(map);
  map.getAll = (propertyName: unknown) => {
    const property = normalizeProperty(propertyName);
    if (isColorProperty(property)) {
      const value = specified.get(property);
      if (value instanceof CSSKeywordValue) return [cloneAssociatedValue(value, property)];
    }
    return getAll(property);
  };
  return map;
}

export const CSS_TYPED_OM_GLOBALS = {
  CSSStyleValue,
  CSSImageValue,
  CSSKeywordValue,
  CSSNumericValue,
  CSSUnitValue,
  CSSMathValue,
  CSSMathSum,
  CSSMathProduct,
  CSSMathNegate,
  CSSMathInvert,
  CSSMathMin,
  CSSMathMax,
  CSSMathClamp,
  CSSNumericArray,
  CSSColorValue,
  CSSRGB,
  CSSHSL,
  CSSHWB,
  CSSLab,
  CSSLCH,
  CSSOKLab,
  CSSOKLCH,
  CSSColor,
  CSSUnparsedValue,
  CSSVariableReferenceValue,
  StylePropertyMapReadOnly,
  StylePropertyMap,
  CSSTransformValue,
  CSSTransformComponent,
  CSSTranslate,
  CSSRotate,
  CSSScale,
  CSSSkew,
  CSSSkewX,
  CSSSkewY,
  CSSPerspective,
  CSSMatrixComponent,
  DOMMatrixReadOnly,
  DOMMatrix,
};
