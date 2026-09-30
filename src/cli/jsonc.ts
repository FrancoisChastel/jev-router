/**
 * JSON with comments, as Gemini CLI accepts in its settings.json: `//` and `/* *\/` comments and trailing commas are
 * removed outside strings, then the text is parsed as JSON. Comments are not preserved on write; `setup` keeps a
 * `.bak` of the original.
 */
export function stripJsonComments(text: string): string {
  let out = "";
  let i = 0;
  while (i < text.length) {
    const c = text[i] as string;
    const next = text[i + 1];
    if (c === '"') {
      const end = endOfString(text, i);
      out += text.slice(i, end);
      i = end;
    } else if (c === "/" && next === "/") {
      while (i < text.length && text[i] !== "\n") i += 1;
    } else if (c === "/" && next === "*") {
      const close = text.indexOf("*/", i + 2);
      i = close < 0 ? text.length : close + 2;
    } else {
      out += c;
      i += 1;
    }
  }
  return dropTrailingCommas(out);
}

/** Commas directly before a closing bracket, outside strings. Runs on comment-free text. */
function dropTrailingCommas(text: string): string {
  let out = "";
  let i = 0;
  while (i < text.length) {
    const c = text[i] as string;
    if (c === '"') {
      const end = endOfString(text, i);
      out += text.slice(i, end);
      i = end;
      continue;
    }
    if (c === "," && /^\s*[}\]]/.test(text.slice(i + 1))) {
      i += 1;
      continue;
    }
    out += c;
    i += 1;
  }
  return out;
}

/** Index just past the closing quote of the string starting at `start`. */
function endOfString(text: string, start: number): number {
  let i = start + 1;
  while (i < text.length) {
    if (text[i] === "\\") i += 2;
    else if (text[i] === '"') return i + 1;
    else i += 1;
  }
  return text.length;
}

export function parseJsonc(text: string): unknown {
  return JSON.parse(stripJsonComments(text));
}
