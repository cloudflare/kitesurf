// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// Linear-time matcher for outbound filter patterns. A Pike VM keeps `test()` linear in
// input x program: a pattern such as `(a+)+$` cannot backtrack, but cost still grows with
// both factors and is not constant, so callers bound pattern size and count. The dialect is
// non-unicode JS RegExp without flags; see the outbound filter request type for the refusals.

const MAX_REPEAT = 1000;
const MAX_PROGRAM = 8192;

type Ranges = Array<[number, number]>;

const DIGITS: Ranges = [[0x30, 0x39]];
const WORD: Ranges = [
  [0x30, 0x39],
  [0x41, 0x5a],
  [0x5f, 0x5f],
  [0x61, 0x7a],
];
// ECMAScript \s: TAB, LF, VT, FF, CR, SP, NBSP, Zs, LS, PS, ZWNBSP.
const SPACES: Ranges = [
  [0x09, 0x0d],
  [0x20, 0x20],
  [0xa0, 0xa0],
  [0x1680, 0x1680],
  [0x2000, 0x200a],
  [0x2028, 0x2029],
  [0x202f, 0x202f],
  [0x205f, 0x205f],
  [0x3000, 0x3000],
  [0xfeff, 0xfeff],
];

function complement(ranges: Ranges): Ranges {
  const out: Ranges = [];
  let start = 0;
  for (const [low, high] of ranges) {
    if (low > start) out.push([start, low - 1]);
    start = high + 1;
  }
  if (start <= 0xffff) out.push([start, 0xffff]);
  return out;
}

function inRanges(ranges: Ranges, code: number): boolean {
  for (const [low, high] of ranges) {
    if (code >= low && code <= high) return true;
  }
  return false;
}

function singleCode(ranges: Ranges): number | null {
  const only = ranges[0];
  if (ranges.length === 1 && only !== undefined && only[0] === only[1]) return only[0];
  return null;
}

function isDigit(code: number): boolean {
  return code >= 0x30 && code <= 0x39;
}

function isLineTerminator(code: number): boolean {
  return code === 0x0a || code === 0x0d || code === 0x2028 || code === 0x2029;
}

function readDigits(src: string, start: number): { value: number | null; next: number } {
  let end = start;
  while (isDigit(src.charCodeAt(end))) end++;
  if (end === start) return { value: null, next: start };
  return { value: Number(src.slice(start, end)), next: end };
}

type Node =
  | { t: "empty" }
  | { t: "char"; c: number }
  | { t: "any" }
  | { t: "word"; neg: boolean }
  | { t: "class"; neg: boolean; ranges: Ranges }
  | { t: "bol" }
  | { t: "eol" }
  | { t: "cat"; items: Node[] }
  | { t: "alt"; items: Node[] }
  | { t: "repeat"; body: Node; min: number; max: number };

class Parser {
  private i = 0;
  private readonly src: string;

  constructor(src: string) {
    this.src = src;
  }

  parse(): Node {
    const node = this.alternation();
    if (this.i < this.src.length) throw new Error(`unexpected "${this.src.charAt(this.i)}"`);
    return node;
  }

  private alternation(): Node {
    const first = this.concat();
    if (this.src.charAt(this.i) !== "|") return first;
    const items: Node[] = [first];
    while (this.src.charAt(this.i) === "|") {
      this.i++;
      items.push(this.concat());
    }
    return { t: "alt", items };
  }

  private concat(): Node {
    const items: Node[] = [];
    while (this.i < this.src.length) {
      const ch = this.src.charAt(this.i);
      if (ch === "|" || ch === ")") break;
      items.push(this.term());
    }
    const first = items[0];
    if (first === undefined) return { t: "empty" };
    return items.length === 1 ? first : { t: "cat", items };
  }

  private term(): Node {
    const atom = this.atom();
    const repeat = this.quantifier();
    if (repeat === null) return atom;
    return { t: "repeat", body: atom, min: repeat.min, max: repeat.max };
  }

  private atom(): Node {
    const ch = this.src.charAt(this.i);
    if (ch === "(") return this.group();
    if (ch === "[") return this.charClass();
    if (ch === "\\") {
      const next = this.src.charAt(this.i + 1);
      if (next === "b" || next === "B") {
        this.i += 2;
        return { t: "word", neg: next === "B" };
      }
      if (next === "c") return this.controlEscape();
      return { t: "class", neg: false, ranges: this.readEscape() };
    }
    this.i++;
    if (ch === ".") return { t: "any" };
    if (ch === "^") return { t: "bol" };
    if (ch === "$") return { t: "eol" };
    return { t: "char", c: ch.charCodeAt(0) };
  }

  // `\cX` is the control character X % 32 for a letter X. Annex B makes any other `\c` the
  // literal backslash, leaving `c` as the next atom so a quantifier binds to it.
  private controlEscape(): Node {
    const letter = this.src.charAt(this.i + 2);
    if (/[A-Za-z]/.test(letter)) {
      this.i += 3;
      return { t: "char", c: letter.charCodeAt(0) % 32 };
    }
    this.i += 1;
    return { t: "char", c: 0x5c };
  }

  private group(): Node {
    this.i++;
    if (this.src.charAt(this.i) === "?") {
      const kind = this.src.charAt(this.i + 1);
      const after = this.src.charAt(this.i + 2);
      if (kind === ":") {
        this.i += 2;
      } else if (kind === "<" && after !== "=" && after !== "!") {
        // A named group is a capturing group; the matcher keeps no captures, so skip the name.
        const close = this.src.indexOf(">", this.i + 2);
        if (close === -1) throw new Error("unterminated group name");
        this.i = close + 1;
      } else {
        throw new Error("only (?:...) and (?<name>...) groups are supported");
      }
    }
    const inner = this.alternation();
    if (this.src.charAt(this.i) !== ")") throw new Error("unterminated group");
    this.i++;
    return inner;
  }

  private charClass(): Node {
    this.i++;
    const neg = this.src.charAt(this.i) === "^";
    if (neg) this.i++;
    const ranges: Ranges = [];
    while (this.i < this.src.length && this.src.charAt(this.i) !== "]") {
      this.classItem(ranges);
    }
    if (this.src.charAt(this.i) !== "]") throw new Error("unterminated character class");
    this.i++;
    return { t: "class", neg, ranges };
  }

  private classItem(ranges: Ranges): void {
    const low = this.classAtom();
    const isRange =
      this.src.charAt(this.i) === "-" &&
      this.i + 1 < this.src.length &&
      this.src.charAt(this.i + 1) !== "]";
    if (!isRange) {
      for (const range of low) ranges.push(range);
      return;
    }
    this.i++;
    const high = this.classAtom();
    const lowCode = singleCode(low);
    const highCode = singleCode(high);
    if (lowCode === null || highCode === null) {
      // Annex B: an endpoint that is a class escape such as `\w` leaves the `-` literal.
      for (const range of low) ranges.push(range);
      ranges.push([0x2d, 0x2d]);
      for (const range of high) ranges.push(range);
      return;
    }
    if (lowCode > highCode) throw new Error("character class range out of order");
    ranges.push([lowCode, highCode]);
  }

  private classAtom(): Ranges {
    if (this.src.charAt(this.i) === "\\") {
      if (this.src.charAt(this.i + 1) === "c") return this.classControlEscape();
      return this.readEscape();
    }
    const code = this.src.charCodeAt(this.i);
    this.i++;
    return [[code, code]];
  }

  // Inside a class Annex B also accepts a digit or `_` after `\c`; anything else makes the
  // backslash literal, with `c` parsed as the next class atom.
  private classControlEscape(): Ranges {
    const letter = this.src.charAt(this.i + 2);
    if (/[A-Za-z0-9_]/.test(letter)) {
      this.i += 3;
      const code = letter.charCodeAt(0) % 32;
      return [[code, code]];
    }
    this.i += 1;
    return [[0x5c, 0x5c]];
  }

  private readEscape(): Ranges {
    this.i++;
    const ch = this.src.charAt(this.i);
    if (ch === "") throw new Error("trailing backslash");
    const code = ch.charCodeAt(0);
    this.i++;
    switch (ch) {
      case "d":
        return DIGITS;
      case "D":
        return complement(DIGITS);
      case "w":
        return WORD;
      case "W":
        return complement(WORD);
      case "s":
        return SPACES;
      case "S":
        return complement(SPACES);
      case "b":
        // Outside a class this is a word boundary, intercepted by atom().
        return [[0x08, 0x08]];
      case "B":
        // Outside a class atom() intercepts `\B`; inside one it is the literal letter.
        return [[0x42, 0x42]];
      case "t":
        return [[0x09, 0x09]];
      case "n":
        return [[0x0a, 0x0a]];
      case "v":
        return [[0x0b, 0x0b]];
      case "f":
        return [[0x0c, 0x0c]];
      case "r":
        return [[0x0d, 0x0d]];
      case "0": {
        // NUL only on its own; `\01` and friends are legacy octal escapes.
        if (isDigit(this.src.charCodeAt(this.i))) {
          throw new Error("octal escapes are not supported");
        }
        return [[0x00, 0x00]];
      }
      case "x": {
        // Annex B: a malformed `\x` is the literal letter, so `\x4` matches "x4".
        const value = this.readHex(2);
        return value === null ? [[0x78, 0x78]] : [[value, value]];
      }
      case "u": {
        const value = this.readHex(4);
        return value === null ? [[0x75, 0x75]] : [[value, value]];
      }
      default:
        break;
    }
    // `\8` and `\9` are identity escapes; `\1`-`\7` are backreferences or legacy octal.
    if (code >= 0x31 && code <= 0x37) throw new Error("backreferences are not supported");
    // `\k` would be a named backreference, which is refused even where V8 reads it as a letter.
    if (ch === "k") throw new Error("backreferences are not supported");
    return [[code, code]];
  }

  private readHex(digits: number): number | null {
    const hex = this.src.slice(this.i, this.i + digits);
    if (hex.length !== digits || !/^[0-9a-fA-F]+$/.test(hex)) return null;
    this.i += digits;
    return Number.parseInt(hex, 16);
  }

  private quantifier(): { min: number; max: number } | null {
    const ch = this.src.charAt(this.i);
    if (ch === "*") {
      this.i++;
      this.skipLazy();
      return { min: 0, max: Infinity };
    }
    if (ch === "+") {
      this.i++;
      this.skipLazy();
      return { min: 1, max: Infinity };
    }
    if (ch === "?") {
      this.i++;
      this.skipLazy();
      return { min: 0, max: 1 };
    }
    return ch === "{" ? this.bracedQuantifier() : null;
  }

  private bracedQuantifier(): { min: number; max: number } | null {
    const lower = readDigits(this.src, this.i + 1);
    if (lower.value === null) return null;
    let next = lower.next;
    let max: number | null = lower.value;
    if (this.src.charAt(next) === ",") {
      const upper = readDigits(this.src, next + 1);
      max = upper.value;
      next = upper.next;
    }
    if (this.src.charAt(next) !== "}") return null;
    if (lower.value > MAX_REPEAT || (max !== null && max > MAX_REPEAT)) {
      throw new Error(`repeat bounds above ${MAX_REPEAT} are not supported`);
    }
    if (max !== null && lower.value > max) throw new Error("numbers out of order in {} quantifier");
    this.i = next + 1;
    this.skipLazy();
    return { min: lower.value, max: max === null ? Infinity : max };
  }

  private skipLazy(): void {
    if (this.src.charAt(this.i) === "?") this.i++;
  }
}

const SIZE_LIMIT = MAX_PROGRAM + 1;

function addSize(total: number, size: number): number {
  return Math.min(total + size, SIZE_LIMIT);
}

function multiplySize(count: number, size: number): number {
  return size === 0 ? 0 : Math.min(count * size, SIZE_LIMIT);
}

// Saturating count of the instructions emit() would append. A repeat multiplies its body's
// size, so nested repeats can pass the bound without `out` growing first.
function expandedSize(node: Node): number {
  switch (node.t) {
    case "empty":
      return 0;
    case "char":
    case "any":
    case "word":
    case "class":
    case "bol":
    case "eol":
      return 1;
    case "cat": {
      let total = 0;
      for (const item of node.items) total = addSize(total, expandedSize(item));
      return total;
    }
    case "alt": {
      let total = multiplySize(node.items.length - 1, 2);
      for (const item of node.items) total = addSize(total, expandedSize(item));
      return total;
    }
    case "repeat": {
      const body = expandedSize(node.body);
      // An empty body matches empty at every count; emitRepeat collapses it.
      if (body === 0) return 0;
      const optional =
        node.max === Infinity ? addSize(body, 2) : multiplySize(node.max - node.min, body + 1);
      return addSize(multiplySize(node.min, body), optional);
    }
  }
}

type Inst =
  | { op: "char"; c: number }
  | { op: "any" }
  | { op: "word"; neg: boolean }
  | { op: "class"; neg: boolean; ranges: Ranges }
  | { op: "split"; x: number; y: number }
  | { op: "jmp"; x: number }
  | { op: "bol" }
  | { op: "eol" }
  | { op: "match" };

function emit(node: Node, out: Inst[]): void {
  if (out.length > MAX_PROGRAM) throw new Error(`pattern expands past ${MAX_PROGRAM} steps`);
  switch (node.t) {
    case "empty":
      return;
    case "char":
      out.push({ op: "char", c: node.c });
      return;
    case "any":
      out.push({ op: "any" });
      return;
    case "word":
      out.push({ op: "word", neg: node.neg });
      return;
    case "class":
      out.push({ op: "class", neg: node.neg, ranges: node.ranges });
      return;
    case "bol":
      out.push({ op: "bol" });
      return;
    case "eol":
      out.push({ op: "eol" });
      return;
    case "cat":
      for (const item of node.items) emit(item, out);
      return;
    case "alt":
      emitAlternation(node.items, out);
      return;
    case "repeat":
      emitRepeat(node.body, node.min, node.max, out);
  }
}

function emitAlternation(items: Node[], out: Inst[]): void {
  const jumps: Array<{ op: "jmp"; x: number }> = [];
  const last = items.length - 1;
  items.forEach((item, index) => {
    if (index === last) {
      emit(item, out);
      return;
    }
    const split: Inst = { op: "split", x: out.length + 1, y: -1 };
    out.push(split);
    emit(item, out);
    const jump = { op: "jmp" as const, x: -1 };
    out.push(jump);
    jumps.push(jump);
    split.y = out.length;
  });
  for (const jump of jumps) jump.x = out.length;
}

function emitRepeat(body: Node, min: number, max: number, out: Inst[]): void {
  // An empty body matches empty at every count, so the copies cannot consume or assert.
  if (expandedSize(body) === 0) return;
  for (let count = 0; count < min; count++) emit(body, out);
  if (max === Infinity) {
    const start = out.length;
    const split: Inst = { op: "split", x: start + 1, y: -1 };
    out.push(split);
    emit(body, out);
    out.push({ op: "jmp", x: start });
    split.y = out.length;
    return;
  }
  for (let count = min; count < max; count++) {
    const split: Inst = { op: "split", x: out.length + 1, y: -1 };
    out.push(split);
    emit(body, out);
    split.y = out.length;
  }
}

// A sparse set of program counters, written through `len`. Reused across positions and calls:
// `seen` admits each pc to a generation's list once, so `len` stays within the program length
// and the buffers never grow.
interface ThreadList {
  buf: Int32Array;
  len: number;
}

interface VmState {
  program: Inst[];
  seen: Int32Array;
  generation: number;
  length: number;
  input: string;
  stack: number[];
  lists: [ThreadList, ThreadList];
}

// `seen` holds one generation stamp per pc; restart the stamps before they leave Int32 range.
const GENERATION_RESET = 0x7fff0000;

// Adds `pc` and its epsilon closure to `list`. Assertions resolve against `pos` and `length`.
// Returns true when a `match` instruction was added, which replaces the caller's O(list) scan.
function addThread(vm: VmState, list: ThreadList, pc: number, pos: number): boolean {
  let matched = false;
  const stack = vm.stack;
  stack.push(pc);
  while (stack.length > 0) {
    const at = stack.pop();
    if (at === undefined) break;
    if (vm.seen[at] === vm.generation) continue;
    vm.seen[at] = vm.generation;
    const inst = vm.program[at];
    if (inst === undefined) continue;
    if (inst.op === "split") {
      stack.push(inst.x, inst.y);
      continue;
    }
    if (inst.op === "jmp") {
      stack.push(inst.x);
      continue;
    }
    if (inst.op === "bol") {
      if (pos === 0) stack.push(at + 1);
      continue;
    }
    if (inst.op === "eol") {
      if (pos === vm.length) stack.push(at + 1);
      continue;
    }
    if (inst.op === "word") {
      const prev = pos > 0 && inRanges(WORD, vm.input.charCodeAt(pos - 1));
      const cur = pos < vm.length && inRanges(WORD, vm.input.charCodeAt(pos));
      if ((prev !== cur) !== inst.neg) stack.push(at + 1);
      continue;
    }
    if (inst.op === "match") matched = true;
    list.buf[list.len] = at;
    list.len++;
  }
  return matched;
}

function consumes(inst: Inst, code: number): boolean {
  if (inst.op === "char") return inst.c === code;
  if (inst.op === "any") return !isLineTerminator(code);
  if (inst.op === "class") return inRanges(inst.ranges, code) !== inst.neg;
  return false;
}

// First-code-unit set for the threads a fresh start position can produce. Positions whose code
// unit is not in the set cannot start a match, so they are skipped while no thread is live.
interface StartSet {
  // Bit per ASCII code unit; null means "no prefilter" (the set covers every code unit).
  ascii: Uint8Array | null;
  nonAscii: boolean;
  // Static seed closure when pc 0 reaches no position-dependent assertion; null otherwise.
  seed: number[] | null;
  // Whether that static closure can reach `match` without consuming.
  seedHasMatch: boolean;
  // Whether every path from pc 0 asserts `bol` before it consumes or matches.
  anchored: boolean;
}

// No multiline support, so `bol` holds only at position 0: a start-anchored program can never
// begin a thread at a later position and the scan stops as soon as no thread is live.
function isStartAnchored(program: Inst[]): boolean {
  const seen = new Uint8Array(program.length);
  const stack = [0];
  while (stack.length > 0) {
    const at = stack.pop();
    if (at === undefined) break;
    if (seen[at] === 1) continue;
    seen[at] = 1;
    const inst = program[at];
    if (inst === undefined) return false;
    if (inst.op === "bol") continue;
    if (inst.op === "split") {
      stack.push(inst.x, inst.y);
      continue;
    }
    if (inst.op === "jmp") {
      stack.push(inst.x);
      continue;
    }
    return false;
  }
  return true;
}

function buildStartSet(program: Inst[]): StartSet {
  const ascii = new Uint8Array(128);
  let nonAscii = false;
  const mark = (low: number, high: number): void => {
    for (let code = Math.max(0, low); code <= Math.min(127, high); code++) ascii[code] = 1;
    if (high > 127) nonAscii = true;
  };
  // Walk the epsilon closure of pc 0, treating assertions as passable (an over-approximation
  // is safe for a prefilter) and recording whether any was crossed.
  const seen = new Uint8Array(program.length);
  const order: number[] = [];
  let positionDependent = false;
  let hasMatch = false;
  const stack = [0];
  while (stack.length > 0) {
    const at = stack.pop();
    if (at === undefined) break;
    if (seen[at] === 1) continue;
    seen[at] = 1;
    const inst = program[at];
    if (inst === undefined) continue;
    if (inst.op === "split") {
      stack.push(inst.x, inst.y);
      continue;
    }
    if (inst.op === "jmp") {
      stack.push(inst.x);
      continue;
    }
    if (inst.op === "bol" || inst.op === "eol" || inst.op === "word") {
      // `word` is zero-width and depends on both neighbours, so the closure is not static.
      positionDependent = true;
      stack.push(at + 1);
      continue;
    }
    if (inst.op === "match") {
      hasMatch = true;
      continue;
    }
    order.push(at);
    if (inst.op === "any") {
      // Over-approximate: keep the line terminators in the set so a later `char`/`class`
      // thread that does match them cannot have its bit cleared. Extra bits only make the
      // prefilter weaker, never wrong.
      mark(0, 127);
      nonAscii = true;
    } else if (inst.op === "char") {
      mark(inst.c, inst.c);
    } else {
      const ranges = inst.neg ? complement(inst.ranges) : inst.ranges;
      for (const [low, high] of ranges) mark(low, high);
    }
  }
  let all = !nonAscii;
  for (let code = 0; code < 128; code++) {
    if (ascii[code] === 0) {
      all = false;
      break;
    }
  }
  return {
    // A closure that reaches `match` can accept without consuming, so no position may be
    // skipped; the same is true when the set covers every code unit.
    ascii: hasMatch || (all && !nonAscii) ? null : ascii,
    nonAscii,
    seed: positionDependent ? null : order,
    seedHasMatch: hasMatch,
    anchored: isStartAnchored(program),
  };
}

function canStart(start: StartSet, code: number): boolean {
  const ascii = start.ascii;
  if (ascii === null) return true;
  return code < 128 ? ascii[code] === 1 : start.nonAscii;
}

// Unanchored search, like a flagless `RegExp.prototype.test`.
function matches(vm: VmState, start: StartSet, input: string): boolean {
  if (vm.generation > GENERATION_RESET) {
    vm.seen.fill(-1);
    vm.generation = 0;
  }
  vm.input = input;
  vm.length = input.length;
  const seed = start.seed;
  const seedHasMatch = seed !== null && start.seedHasMatch;
  let current = vm.lists[0];
  let next = vm.lists[1];
  current.len = 0;
  next.len = 0;
  for (let pos = 0; ; pos++) {
    if (current.len === 0) {
      // `^` holds only at position 0, so an anchored program cannot restart later.
      if (pos > 0 && start.anchored) return false;
      // No live thread and no thread can start here: skip the position entirely.
      if (pos < vm.length && !canStart(start, input.charCodeAt(pos))) continue;
    }
    if (seed !== null && current.len === 0) {
      // Nothing live and pc 0 crosses no position-dependent assertion: the seed closure is
      // position independent, so copy it instead of re-walking the program's epsilon edges.
      let len = 0;
      for (const pc of seed) {
        current.buf[len] = pc;
        len++;
      }
      current.len = len;
      if (seedHasMatch) return true;
    } else {
      vm.generation++;
      // Survivors from the previous step are already in `current`; mark them so this
      // generation's closure does not append the same pc twice.
      for (let index = 0; index < current.len; index++) {
        vm.seen[current.buf[index] ?? 0] = vm.generation;
      }
      if (addThread(vm, current, 0, pos)) return true;
    }
    if (pos === vm.length) return false;
    const code = input.charCodeAt(pos);
    vm.generation++;
    next.len = 0;
    for (let index = 0; index < current.len; index++) {
      const pc = current.buf[index] ?? 0;
      const inst = vm.program[pc];
      if (inst !== undefined && consumes(inst, code) && addThread(vm, next, pc + 1, pos + 1)) {
        return true;
      }
    }
    const swap = current;
    current = next;
    next = swap;
  }
}

export interface LinearRegex {
  readonly source: string;
  test(input: string): boolean;
}

export function compileLinearRegex(
  source: string,
): { ok: true; regex: LinearRegex } | { ok: false; error: string } {
  try {
    // V8 validates the syntax only; the matcher below never calls test() or exec() on it.
    new RegExp(source);
    const root = new Parser(source).parse();
    if (expandedSize(root) > MAX_PROGRAM) {
      throw new Error(`pattern expands past ${MAX_PROGRAM} steps`);
    }
    const program: Inst[] = [];
    emit(root, program);
    program.push({ op: "match" });
    const start = buildStartSet(program);
    // The VM state is reused across test() calls: one regex owns its buffers.
    const vm: VmState = {
      program,
      seen: new Int32Array(program.length).fill(-1),
      generation: 0,
      length: 0,
      input: "",
      stack: [],
      lists: [
        { buf: new Int32Array(program.length), len: 0 },
        { buf: new Int32Array(program.length), len: 0 },
      ],
    };
    const regex: LinearRegex = { source, test: (input: string) => matches(vm, start, input) };
    return { ok: true, regex };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
