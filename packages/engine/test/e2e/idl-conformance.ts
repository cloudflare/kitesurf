// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import type {
  WebIdlAttribute,
  WebIdlInterface,
  WebIdlOperation,
} from "../../../dom-shim/src/idl/model.ts";

export type MemberReport =
  | { k: "-" }
  | { k: "i" }
  | { k: "a"; g: boolean; s: boolean; e: boolean }
  | { k: "d"; e: boolean; w: boolean; c: boolean; t: string; l?: number; v?: number | boolean };

export interface InterfaceReport {
  type: string;
  name?: string | null;
  length?: number | null;
  objectParent?: boolean;
  hasPrototype?: boolean;
  prototypeParent?: boolean;
  classString?: string;
  iterator?: boolean;
  constants?: Record<string, MemberReport>;
  prototypeConstants?: Record<string, MemberReport>;
  attributes?: Record<string, MemberReport>;
  operations?: Record<string, MemberReport>;
  staticAttributes?: Record<string, MemberReport>;
  staticOperations?: Record<string, MemberReport>;
}

export interface ConformanceReport {
  interfaces: Record<string, InterfaceReport>;
  globals: Record<string, string>;
}

export interface InterfaceRequest {
  parent?: string;
  constants: string[];
  attributes: string[];
  operations: string[];
  staticAttributes: string[];
  staticOperations: string[];
}

export interface ConformanceRequest {
  interfaces: Record<string, InterfaceRequest>;
  globals: string[];
}

function interfaceRequest(iface: WebIdlInterface): InterfaceRequest {
  return {
    ...(iface.parent ? { parent: iface.parent } : {}),
    constants: Object.keys(iface.constants ?? {}),
    attributes: forgeable(iface.attributes),
    operations: forgeable(iface.operations),
    staticAttributes: forgeable(iface.staticAttributes),
    staticOperations: forgeable(iface.staticOperations),
  };
}

function graded(model: readonly WebIdlInterface[]): WebIdlInterface[] {
  return model.filter((iface) => !iface.global && !iface.noInterfaceObject);
}

function forgeable<T extends { unforgeable?: boolean }>(
  members: Readonly<Record<string, T>> | undefined,
): string[] {
  return Object.entries(members ?? {})
    .filter(([, member]) => !member.unforgeable)
    .map(([name]) => name);
}

function entriesOrEmpty<T>(members: Readonly<Record<string, T>> | undefined): [string, T][] {
  return Object.entries(members ?? {});
}

export function buildRequest(model: readonly WebIdlInterface[]): ConformanceRequest {
  const interfaces: Record<string, InterfaceRequest> = {};
  const globals: string[] = [];
  for (const iface of graded(model)) {
    interfaces[iface.name] = interfaceRequest(iface);
    globals.push(...(iface.windowAliases ?? []), ...(iface.factoryFunctions ?? []));
  }
  return { interfaces, globals };
}

function hasSetter(attribute: WebIdlAttribute): boolean {
  return (
    !attribute.readonly ||
    !!attribute.putForwards ||
    !!attribute.replaceable ||
    !!attribute.lenientSetter
  );
}

function gradeConstant(
  gaps: string[],
  where: string,
  seen: MemberReport | undefined,
  value: number | boolean,
): void {
  if (!seen || seen.k === "-") gaps.push(`${where}: missing constant`);
  else if (seen.k === "i") gaps.push(`${where}: inherited, not own`);
  else if (seen.k === "a") gaps.push(`${where}: accessor, expected a data property`);
  else {
    if (seen.v !== value) gaps.push(`${where}: is ${String(seen.v)}, expected ${String(value)}`);
    if (seen.w || seen.c || !seen.e) {
      gaps.push(`${where}: expected non-writable, enumerable, non-configurable`);
    }
  }
}

function gradeAttributeFlags(
  gaps: string[],
  where: string,
  seen: Extract<MemberReport, { k: "a" }>,
  attribute: WebIdlAttribute,
): void {
  if (hasSetter(attribute) && !seen.s) gaps.push(`${where}: no setter`);
  if (!hasSetter(attribute) && seen.s) gaps.push(`${where}: has a setter, expected readonly`);
}

function gradeAttribute(
  gaps: string[],
  where: string,
  seen: MemberReport | undefined,
  attribute: WebIdlAttribute,
): void {
  switch (seen?.k) {
    case undefined:
    case "-":
      gaps.push(`${where}: missing attribute`);
      return;
    case "i":
      gaps.push(`${where}: inherited, not own`);
      return;
    case "d":
      gaps.push(`${where}: data property, expected an accessor`);
      return;
    case "a":
      if (!seen.g) gaps.push(`${where}: no getter`);
      gradeAttributeFlags(gaps, where, seen, attribute);
      if (!seen.e) gaps.push(`${where}: not enumerable`);
  }
}

function gradeOperationDetails(
  gaps: string[],
  where: string,
  seen: Extract<MemberReport, { k: "d" }>,
  operation: WebIdlOperation,
): void {
  if (seen.l !== operation.length) {
    gaps.push(`${where}: length is ${String(seen.l)}, expected ${operation.length}`);
  }
  if (!seen.e) gaps.push(`${where}: not enumerable`);
}

function isMissingOperation(
  seen: MemberReport | undefined,
): seen is undefined | Extract<MemberReport, { k: "-" }> {
  return !seen || seen.k === "-";
}

function isFunctionOperation(seen: MemberReport): seen is Extract<MemberReport, { k: "d" }> {
  return seen.k === "d" && seen.t === "function";
}

function gradeOperation(
  gaps: string[],
  where: string,
  seen: MemberReport | undefined,
  operation: WebIdlOperation,
): void {
  if (isMissingOperation(seen)) return void gaps.push(`${where}: missing operation`);
  if (seen.k === "i") return void gaps.push(`${where}: inherited, not own`);
  if (!isFunctionOperation(seen)) {
    return void gaps.push(`${where}: not a function`);
  }
  gradeOperationDetails(gaps, where, seen, operation);
}

function gradeAliases(
  iface: WebIdlInterface,
  globals: Record<string, string>,
  gaps: string[],
): void {
  for (const alias of iface.windowAliases ?? []) {
    if (globals[alias] !== "function") gaps.push(`${alias}: missing window alias of ${iface.name}`);
  }
}

function gradeFactories(
  iface: WebIdlInterface,
  globals: Record<string, string>,
  gaps: string[],
): void {
  for (const factory of iface.factoryFunctions ?? []) {
    if (globals[factory] !== "function") {
      gaps.push(`${factory}: missing factory function for ${iface.name}`);
    }
  }
}

function gradeConstants(iface: WebIdlInterface, seen: InterfaceReport, gaps: string[]): void {
  for (const [constant, value] of Object.entries(iface.constants ?? {})) {
    gradeConstant(gaps, `${iface.name}.${constant}`, seen.constants?.[constant], value);
  }
}

function gradeInterfaceFunction(
  iface: WebIdlInterface,
  seen: InterfaceReport,
  gaps: string[],
): void {
  const name = iface.name;
  if (seen.name !== name) gaps.push(`${name}: name is ${JSON.stringify(seen.name)}`);
  if (seen.length !== iface.length) {
    gaps.push(`${name}: length is ${String(seen.length)}, expected ${iface.length}`);
  }
  if (!seen.objectParent) {
    gaps.push(
      `${name}: interface object does not inherit from ${iface.parent ?? "Function.prototype"}`,
    );
  }
}

function gradeStaticAttributes(
  iface: WebIdlInterface,
  seen: InterfaceReport,
  gaps: string[],
): void {
  for (const [attribute, idl] of entriesOrEmpty(iface.staticAttributes)) {
    if (!idl.unforgeable)
      gradeAttribute(gaps, `${iface.name}.${attribute}`, seen.staticAttributes?.[attribute], idl);
  }
}

function gradeStaticOperations(
  iface: WebIdlInterface,
  seen: InterfaceReport,
  gaps: string[],
): void {
  for (const [operation, idl] of entriesOrEmpty(iface.staticOperations)) {
    if (!idl.unforgeable)
      gradeOperation(gaps, `${iface.name}.${operation}()`, seen.staticOperations?.[operation], idl);
  }
}

function gradeStaticMembers(iface: WebIdlInterface, seen: InterfaceReport, gaps: string[]): void {
  gradeStaticAttributes(iface, seen, gaps);
  gradeStaticOperations(iface, seen, gaps);
}

function gradePrototypeShape(
  iface: WebIdlInterface,
  seen: InterfaceReport,
  gaps: string[],
): boolean {
  const name = iface.name;
  if (!seen.hasPrototype) {
    gaps.push(`${name}.prototype: missing`);
    return false;
  }
  if (!seen.prototypeParent) {
    gaps.push(
      `${name}.prototype: does not inherit from ${iface.parent ? `${iface.parent}.prototype` : "Object.prototype"}`,
    );
  }
  if (seen.classString !== `[object ${name}]`) {
    gaps.push(`${name}.prototype: class string is ${JSON.stringify(seen.classString)}`);
  }
  return true;
}

function gradePrototypeConstants(
  iface: WebIdlInterface,
  seen: InterfaceReport,
  gaps: string[],
): void {
  const name = iface.name;
  for (const [constant, value] of entriesOrEmpty(iface.constants)) {
    gradeConstant(
      gaps,
      `${name}.prototype.${constant}`,
      seen.prototypeConstants?.[constant],
      value,
    );
  }
}

function gradePrototypeAttributes(
  iface: WebIdlInterface,
  seen: InterfaceReport,
  gaps: string[],
): void {
  const name = iface.name;
  for (const [attribute, idl] of entriesOrEmpty(iface.attributes)) {
    if (!idl.unforgeable)
      gradeAttribute(gaps, `${name}.prototype.${attribute}`, seen.attributes?.[attribute], idl);
  }
}

function gradePrototypeOperations(
  iface: WebIdlInterface,
  seen: InterfaceReport,
  gaps: string[],
): void {
  const name = iface.name;
  for (const [operation, idl] of entriesOrEmpty(iface.operations)) {
    if (!idl.unforgeable)
      gradeOperation(gaps, `${name}.prototype.${operation}()`, seen.operations?.[operation], idl);
  }
}

function gradePrototypeMembers(
  iface: WebIdlInterface,
  seen: InterfaceReport,
  gaps: string[],
): void {
  gradePrototypeConstants(iface, seen, gaps);
  gradePrototypeAttributes(iface, seen, gaps);
  gradePrototypeOperations(iface, seen, gaps);
}

function gradeIterator(iface: WebIdlInterface, seen: InterfaceReport, gaps: string[]): void {
  if ((iface.iterable || iface.setlike || iface.maplike) && !seen.iterator) {
    gaps.push(`${iface.name}.prototype[Symbol.iterator]: missing`);
  }
}

function gradeNonCallbackInterfaceDetails(
  iface: WebIdlInterface,
  seen: InterfaceReport,
  gaps: string[],
): void {
  gradeInterfaceFunction(iface, seen, gaps);
  gradeStaticMembers(iface, seen, gaps);
  if (!gradePrototypeShape(iface, seen, gaps)) return;
  gradePrototypeMembers(iface, seen, gaps);
  gradeIterator(iface, seen, gaps);
}

function gradeInterfaceDetails(
  iface: WebIdlInterface,
  seen: InterfaceReport,
  gaps: string[],
): void {
  if (iface.callback) return;
  gradeNonCallbackInterfaceDetails(iface, seen, gaps);
}

function hasExpectedInterfaceType(
  iface: WebIdlInterface,
  seen: InterfaceReport | undefined,
): seen is InterfaceReport {
  if (!seen) return false;
  if (seen.type === "function") return true;
  return iface.callback === true && seen.type === "object";
}

function gradeInterface(iface: WebIdlInterface, report: ConformanceReport, gaps: string[]): void {
  const name = iface.name;
  const seen = report.interfaces[name];
  if (!hasExpectedInterfaceType(iface, seen)) {
    gaps.push(`${name}: missing interface`);
    return;
  }
  gradeAliases(iface, report.globals, gaps);
  gradeFactories(iface, report.globals, gaps);
  gradeConstants(iface, seen, gaps);
  gradeInterfaceDetails(iface, seen, gaps);
}

export function grade(model: readonly WebIdlInterface[], report: ConformanceReport): string[] {
  const gaps: string[] = [];
  for (const iface of graded(model)) {
    gradeInterface(iface, report, gaps);
  }
  return gaps.sort();
}
