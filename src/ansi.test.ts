import { describe, expect, it } from "vitest";
import { lineHtml, matchRanges, parseAnsi } from "./ansi";

describe("parseAnsi", () => {
  it("drops resets that style nothing, like a runner's `ESC[0;m`", () => {
    const line = "listen_address not defined, session endpoints disabled\x1b[0;m  builds\x1b[0;m=0 max_builds\x1b[0;m=10";
    expect(parseAnsi(line)).toEqual({ text: "listen_address not defined, session endpoints disabled  builds=0 max_builds=10" });
  });

  it("leaves lines without escape codes alone", () => {
    expect(parseAnsi("plain line")).toEqual({ text: "plain line" });
  });

  it("turns colors and styles into spans", () => {
    expect(parseAnsi("\x1b[1;31mERROR\x1b[0m done \x1b[32mok\x1b[39m.")).toEqual({
      text: "ERROR done ok.",
      spans: [
        { text: "ERROR", style: "color:var(--ansi-1);font-weight:bold" },
        { text: " done " },
        { text: "ok", style: "color:var(--ansi-2)" },
        { text: "." },
      ],
    });
  });

  it("reads bright, 256 and true colors, in semicolon and colon forms", () => {
    const styles = (line: string) => parseAnsi(line).spans?.map((s) => s.style);
    expect(styles("\x1b[94ma\x1b[103mb")).toEqual(["color:var(--ansi-12)", "color:var(--ansi-12);background:var(--ansi-11)"]);
    expect(styles("\x1b[38;5;196ma\x1b[38;5;244mb\x1b[38;5;3mc")).toEqual(["color:rgb(255,0,0)", "color:rgb(128,128,128)", "color:var(--ansi-3)"]);
    expect(styles("\x1b[38;2;10;20;30;48;2;1;2;3ma\x1b[38:2::40:50:60mb")).toEqual([
      "color:rgb(10,20,30);background:rgb(1,2,3)",
      "color:rgb(40,50,60);background:rgb(1,2,3)",
    ]);
  });

  it("swaps colors for inverse and combines decorations", () => {
    expect(parseAnsi("\x1b[7;4;9ma").spans).toEqual([
      { text: "a", style: "color:var(--logs-bg);background:var(--text);text-decoration:underline line-through" },
    ]);
  });

  it("drops other escape sequences and control characters", () => {
    expect(parseAnsi("\x1b]0;title\x07a\x1b[2Kb\x1b(B\x1b[?25lc\x07\r\x1b")).toEqual({ text: "abc" });
  });

  it("starts every line unstyled", () => {
    expect(parseAnsi("\x1b[31mred, never reset").spans).toHaveLength(1);
    expect(parseAnsi("next line")).toEqual({ text: "next line" });
  });
});

describe("lineHtml", () => {
  it("escapes plain text", () => {
    expect(lineHtml({ text: "<b>&" })).toBe("&lt;b&gt;&amp;");
  });

  it("wraps styled spans and splits search marks at their edges", () => {
    const line = parseAnsi("\x1b[31merror\x1b[0m: <disk> full");
    const marks = matchRanges(line.text, /or: <d/g);
    expect(marks).toEqual([[3, 9]]);
    expect(lineHtml(line, marks)).toBe(
      '<span style="color:var(--ansi-1)">err<mark>or</mark></span><mark>: &lt;d</mark>isk&gt; full',
    );
  });

  it("marks several matches in one span", () => {
    const line = parseAnsi("\x1b[33ma-b-a\x1b[0m!");
    expect(lineHtml(line, matchRanges(line.text, /a/g))).toBe('<span style="color:var(--ansi-3)"><mark>a</mark>-b-<mark>a</mark></span>!');
  });
});
