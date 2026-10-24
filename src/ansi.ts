//! ANSI escape codes in log lines. Like Lens, colors and styles (SGR codes such as `ESC[31m`) are
//! shown, and every other escape sequence or control character (cursor moves, window titles,
//! charset switches) is dropped instead of showing up as `�[0;m`.

export interface AnsiSpan {
  text: string;
  /** Inline CSS for the span's colors and styles. */
  style?: string;
}

/** A line without its escape codes, and its styled spans when it has any colors or styles. */
export interface AnsiLine {
  text: string;
  spans?: AnsiSpan[];
}

/** CSI (`ESC[…m`), OSC (`ESC]…BEL`), nF (`ESC(B`) and Fe escapes, a lone ESC, or another control character. */
const CONTROL = /\x1b(?:\[([0-?]*)[ -/]*([@-~])|\][^\x07\x1b]*(?:\x07|\x1b\\)?|[ -/]+[0-~]|[@-_])?|[\x00-\x08\x0b-\x1f\x7f]/g;
const HAS_CONTROL = /[\x00-\x08\x0b-\x1f\x7f]/;

interface Sgr {
  fg?: string;
  bg?: string;
  bold?: boolean;
  dim?: boolean;
  italic?: boolean;
  underline?: boolean;
  strike?: boolean;
  inverse?: boolean;
  hidden?: boolean;
}

const rgb = (parts: string[]) => {
  const [r, g, b] = parts.map(Number);
  return [r, g, b].every((v) => Number.isInteger(v) && v >= 0 && v <= 255) ? `rgb(${r},${g},${b})` : undefined;
};

/** One of the 256 xterm colors; the first 16 follow the theme (`--ansi-0` … `--ansi-15`). */
function palette(n: number): string | undefined {
  if (!Number.isInteger(n) || n < 0 || n > 255) return undefined;
  if (n < 16) return `var(--ansi-${n})`;
  if (n >= 232) {
    const v = 8 + (n - 232) * 10;
    return `rgb(${v},${v},${v})`;
  }
  const level = (v: number) => (v ? 55 + v * 40 : 0);
  const i = n - 16;
  return `rgb(${level(Math.floor(i / 36))},${level(Math.floor(i / 6) % 6)},${level(i % 6)})`;
}

function applySgr(prev: Sgr, params: string): Sgr {
  let s: Sgr = { ...prev };
  const codes = params.split(";");
  for (let i = 0; i < codes.length; i++) {
    // Sub-parameters are separated by colons: `38:5:n`, `38:2::r:g:b`.
    const sub = codes[i].split(":");
    const n = Number(sub[0] || 0);
    if (n === 38 || n === 48) {
      let color: string | undefined;
      if (sub.length > 1) color = sub[1] === "5" ? palette(Number(sub[2])) : sub[1] === "2" ? rgb(sub.slice(-3)) : undefined;
      else if (codes[i + 1] === "5") {
        color = palette(Number(codes[i + 2]));
        i += 2;
      } else if (codes[i + 1] === "2") {
        color = rgb(codes.slice(i + 2, i + 5));
        i += 4;
      }
      if (n === 38) s.fg = color;
      else s.bg = color;
    } else if (n === 0) s = {};
    else if (n === 1) s.bold = true;
    else if (n === 2) s.dim = true;
    else if (n === 3) s.italic = true;
    else if (n === 4 || n === 21) s.underline = true;
    else if (n === 7) s.inverse = true;
    else if (n === 8) s.hidden = true;
    else if (n === 9) s.strike = true;
    else if (n === 22) s.bold = s.dim = false;
    else if (n === 23) s.italic = false;
    else if (n === 24) s.underline = false;
    else if (n === 27) s.inverse = false;
    else if (n === 28) s.hidden = false;
    else if (n === 29) s.strike = false;
    else if (n >= 30 && n <= 37) s.fg = palette(n - 30);
    else if (n === 39) s.fg = undefined;
    else if (n >= 40 && n <= 47) s.bg = palette(n - 40);
    else if (n === 49) s.bg = undefined;
    else if (n >= 90 && n <= 97) s.fg = palette(n - 90 + 8);
    else if (n >= 100 && n <= 107) s.bg = palette(n - 100 + 8);
  }
  return s;
}

function cssOf(s: Sgr): string | undefined {
  let { fg, bg } = s;
  if (s.inverse) [fg, bg] = [bg ?? "var(--logs-bg)", fg ?? "var(--text)"];
  const css: string[] = [];
  if (fg) css.push(`color:${fg}`);
  if (bg) css.push(`background:${bg}`);
  if (s.bold) css.push("font-weight:bold");
  if (s.dim) css.push("opacity:.6");
  if (s.italic) css.push("font-style:italic");
  const deco = [s.underline && "underline", s.strike && "line-through"].filter(Boolean);
  if (deco.length) css.push(`text-decoration:${deco.join(" ")}`);
  if (s.hidden) css.push("visibility:hidden");
  return css.length ? css.join(";") : undefined;
}

/**
 * Splits a line at its escape codes. Each line starts unstyled, like in Lens, so a color that
 * an app forgets to reset doesn't spill over the following lines.
 */
export function parseAnsi(line: string): AnsiLine {
  if (!HAS_CONTROL.test(line)) return { text: line };
  const spans: AnsiSpan[] = [];
  let sgr: Sgr = {};
  let style: string | undefined;
  let last = 0;
  const push = (text: string) => {
    if (!text) return;
    const prev = spans.at(-1);
    if (prev && prev.style === style) prev.text += text;
    else spans.push(style ? { text, style } : { text });
  };
  for (const m of line.matchAll(CONTROL)) {
    push(line.slice(last, m.index));
    last = m.index + m[0].length;
    if (m[2] === "m" && /^[\d;:]*$/.test(m[1])) {
      sgr = applySgr(sgr, m[1]);
      style = cssOf(sgr);
    }
  }
  push(line.slice(last));
  const text = spans.map((s) => s.text).join("");
  return spans.some((s) => s.style) ? { text, spans } : { text };
}

export const escapeHtml = (s: string) => s.replace(/[&<>]/g, (c) => (c === "&" ? "&amp;" : c === "<" ? "&lt;" : "&gt;"));

/** Where a search matches in a line's text. */
export function matchRanges(text: string, re: RegExp): [number, number][] {
  const out: [number, number][] = [];
  re.lastIndex = 0;
  for (const m of text.matchAll(re)) {
    if (!m[0]) break;
    out.push([m.index, m.index + m[0].length]);
  }
  return out;
}

/** HTML for a line: its styled spans, with the `marks` (ranges of its text) in `<mark>`. */
export function lineHtml(line: AnsiLine, marks: [number, number][] = []): string {
  if (!line.spans && !marks.length) return escapeHtml(line.text);
  let out = "";
  let pos = 0;
  let k = 0;
  for (const span of line.spans ?? [{ text: line.text }]) {
    const end = pos + span.text.length;
    let inner = "";
    let at = pos;
    // A mark that crosses into the next span is split in two.
    while (k < marks.length && marks[k][0] < end) {
      const [from, to] = marks[k];
      const s = Math.max(from, at);
      const e = Math.min(to, end);
      inner += escapeHtml(span.text.slice(at - pos, s - pos)) + `<mark>${escapeHtml(span.text.slice(s - pos, e - pos))}</mark>`;
      at = e;
      if (to > end) break;
      k++;
    }
    inner += escapeHtml(span.text.slice(at - pos));
    out += span.style ? `<span style="${span.style}">${inner}</span>` : inner;
    pos = end;
  }
  return out;
}
