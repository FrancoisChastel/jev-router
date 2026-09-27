/**
 * Tiny whitelisted expression language for policy rules.
 * Grammar: or := and ("or" and)* ; and := not ("and" not)* ; not := "not" not | cmp ;
 * cmp := primary ((">=" | "<=" | "==" | "!=" | ">" | "<") primary | "in" list)? ;
 * primary := "(" or ")" | number | string | identifier | "true" | "false" ;
 * list := "[" (item ("," item)*)? "]" where a bare identifier inside a list is a string literal.
 * There is no code execution and no function calls.
 */

export type ExprValue = number | string | boolean | undefined;
export type ExprContext = Readonly<Record<string, ExprValue>>;

export interface CompiledExpr {
  readonly source: string;
  readonly identifiers: ReadonlySet<string>;
  evaluate(ctx: ExprContext): boolean;
}

export class ExprError extends Error {
  constructor(
    message: string,
    readonly position: number,
  ) {
    super(`${message} at ${position}`);
    this.name = "ExprError";
  }
}

type TokenKind = "ident" | "num" | "str" | "op" | "punct" | "kw" | "end";
interface Token {
  readonly kind: TokenKind;
  readonly value: string;
  readonly pos: number;
}

const KEYWORDS: ReadonlySet<string> = new Set(["and", "or", "not", "in", "true", "false"]);
const CMP_OPS: ReadonlySet<string> = new Set([">=", "<=", "==", "!=", ">", "<"]);

function tokenize(src: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i] as string;
    if (/\s/.test(ch)) {
      i += 1;
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      let j = i + 1;
      while (j < src.length && /[A-Za-z0-9_.]/.test(src[j] as string)) j += 1;
      const word = src.slice(i, j);
      out.push({ kind: KEYWORDS.has(word) ? "kw" : "ident", value: word, pos: i });
      i = j;
      continue;
    }
    if (/[0-9]/.test(ch)) {
      let j = i + 1;
      while (j < src.length && /[0-9.]/.test(src[j] as string)) j += 1;
      const num = src.slice(i, j);
      if (!/^\d+(\.\d+)?$/.test(num)) throw new ExprError(`bad number '${num}'`, i);
      out.push({ kind: "num", value: num, pos: i });
      i = j;
      continue;
    }
    if (ch === '"' || ch === "'") {
      const j = src.indexOf(ch, i + 1);
      if (j < 0) throw new ExprError("unterminated string", i);
      out.push({ kind: "str", value: src.slice(i + 1, j), pos: i });
      i = j + 1;
      continue;
    }
    const two = src.slice(i, i + 2);
    if (CMP_OPS.has(two)) {
      out.push({ kind: "op", value: two, pos: i });
      i += 2;
      continue;
    }
    if (CMP_OPS.has(ch)) {
      out.push({ kind: "op", value: ch, pos: i });
      i += 1;
      continue;
    }
    if ("()[],".includes(ch)) {
      out.push({ kind: "punct", value: ch, pos: i });
      i += 1;
      continue;
    }
    throw new ExprError(`unexpected character '${ch}'`, i);
  }
  out.push({ kind: "end", value: "", pos: src.length });
  return out;
}

type Node =
  | { readonly t: "or"; readonly l: Node; readonly r: Node }
  | { readonly t: "and"; readonly l: Node; readonly r: Node }
  | { readonly t: "not"; readonly e: Node }
  | { readonly t: "cmp"; readonly op: string; readonly l: Node; readonly r: Node }
  | { readonly t: "in"; readonly l: Node; readonly items: readonly Literal[] }
  | Literal
  | { readonly t: "ident"; readonly name: string };

type Literal = { readonly t: "lit"; readonly v: number | string | boolean };

class Parser {
  private i = 0;
  readonly identifiers = new Set<string>();
  constructor(private readonly tokens: readonly Token[]) {}

  private peek(): Token {
    return this.tokens[this.i] as Token;
  }
  private next(): Token {
    const t = this.peek();
    this.i += 1;
    return t;
  }
  private accept(kind: TokenKind, value?: string): Token | undefined {
    const t = this.peek();
    if (t.kind === kind && (value === undefined || t.value === value)) {
      this.i += 1;
      return t;
    }
    return undefined;
  }
  private expect(kind: TokenKind, value?: string): Token {
    const t = this.accept(kind, value);
    if (!t) throw new ExprError(`expected ${value ?? kind}`, this.peek().pos);
    return t;
  }

  parse(): Node {
    const node = this.or();
    if (this.peek().kind !== "end") throw new ExprError(`unexpected '${this.peek().value}'`, this.peek().pos);
    return node;
  }
  private or(): Node {
    let l = this.and();
    while (this.accept("kw", "or")) l = { t: "or", l, r: this.and() };
    return l;
  }
  private and(): Node {
    let l = this.not();
    while (this.accept("kw", "and")) l = { t: "and", l, r: this.not() };
    return l;
  }
  private not(): Node {
    if (this.accept("kw", "not")) return { t: "not", e: this.not() };
    return this.cmp();
  }
  private cmp(): Node {
    const l = this.primary();
    const t = this.peek();
    if (t.kind === "op") {
      this.next();
      return { t: "cmp", op: t.value, l, r: this.primary() };
    }
    if (t.kind === "kw" && t.value === "in") {
      this.next();
      return { t: "in", l, items: this.list() };
    }
    return l;
  }
  private list(): Literal[] {
    this.expect("punct", "[");
    const items: Literal[] = [];
    if (!this.accept("punct", "]")) {
      do {
        items.push(this.listItem());
      } while (this.accept("punct", ","));
      this.expect("punct", "]");
    }
    return items;
  }
  private listItem(): Literal {
    const t = this.next();
    if (t.kind === "num") return { t: "lit", v: Number(t.value) };
    if (t.kind === "str" || t.kind === "ident") return { t: "lit", v: t.value };
    if (t.kind === "kw" && (t.value === "true" || t.value === "false")) return { t: "lit", v: t.value === "true" };
    throw new ExprError("expected list item", t.pos);
  }
  private primary(): Node {
    const t = this.next();
    if (t.kind === "punct" && t.value === "(") {
      const e = this.or();
      this.expect("punct", ")");
      return e;
    }
    if (t.kind === "num") return { t: "lit", v: Number(t.value) };
    if (t.kind === "str") return { t: "lit", v: t.value };
    if (t.kind === "kw" && (t.value === "true" || t.value === "false")) return { t: "lit", v: t.value === "true" };
    if (t.kind === "ident") {
      this.identifiers.add(t.value);
      return { t: "ident", name: t.value };
    }
    throw new ExprError(`unexpected '${t.value || "end of expression"}'`, t.pos);
  }
}

function nodeValue(node: Node, ctx: ExprContext): ExprValue {
  if (node.t === "lit") return node.v;
  if (node.t === "ident") return ctx[node.name];
  return truthy(node, ctx);
}

function compare(op: string, a: ExprValue, b: ExprValue): boolean {
  if (a === undefined || b === undefined) return false;
  if (typeof a === "number" && typeof b === "number") {
    switch (op) {
      case ">=":
        return a >= b;
      case "<=":
        return a <= b;
      case ">":
        return a > b;
      case "<":
        return a < b;
      case "==":
        return a === b;
      case "!=":
        return a !== b;
      default:
        return false;
    }
  }
  if (typeof a === typeof b && (op === "==" || op === "!=")) return op === "==" ? a === b : a !== b;
  return false;
}

function truthy(node: Node, ctx: ExprContext): boolean {
  switch (node.t) {
    case "or":
      return truthy(node.l, ctx) || truthy(node.r, ctx);
    case "and":
      return truthy(node.l, ctx) && truthy(node.r, ctx);
    case "not":
      return !truthy(node.e, ctx);
    case "cmp":
      return compare(node.op, nodeValue(node.l, ctx), nodeValue(node.r, ctx));
    case "in": {
      const v = nodeValue(node.l, ctx);
      return v !== undefined && node.items.some((it) => it.v === v);
    }
    case "lit":
      return node.v === true;
    case "ident":
      return ctx[node.name] === true;
  }
}

export function compileExpr(source: string): CompiledExpr {
  if (source.trim() === "") throw new ExprError("empty expression", 0);
  const parser = new Parser(tokenize(source));
  const ast = parser.parse();
  const identifiers: ReadonlySet<string> = new Set(parser.identifiers);
  return { source, identifiers, evaluate: (ctx) => truthy(ast, ctx) };
}

export function evaluateExpr(source: string, ctx: ExprContext): boolean {
  return compileExpr(source).evaluate(ctx);
}
