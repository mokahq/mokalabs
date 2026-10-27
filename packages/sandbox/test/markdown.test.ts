import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import ReactMarkdown from "react-markdown";
import { languageOf, languageOfFile } from "../web/src/highlight";
import { loadKatex, normalizeMath, rehypePlugins, remarkPlugins } from "../web/src/markdown";

// The same pipeline as the chat's Markdown component (without its code-block UI).
const render = (text: string) => renderToStaticMarkup(createElement(ReactMarkdown, { remarkPlugins, rehypePlugins: rehypePlugins() }, normalizeMath(text)));

describe("reply formatting", () => {
  it("keeps safe inline HTML: colors, highlights, keys, sub/superscript", () => {
    const html = render('A <span style="color:#d6453d; position:fixed; background:url(x)">red</span> word, <mark>marked</mark>, <kbd>Ctrl</kbd>+<kbd>K</kbd>, H<sub>2</sub>O, x<sup>2</sup>, <u>under</u>, <font color="green">old</font>.');
    expect(html).toContain('<span style="color:#d6453d">red</span>');
    expect(html).toContain("<mark>marked</mark>");
    expect(html).toContain("<kbd>Ctrl</kbd>");
    expect(html).toContain("<sub>2</sub>");
    expect(html).toContain("<sup>2</sup>");
    expect(html).toContain("<u>under</u>");
    expect(html).toContain('<span style="color:green">old</span>');
  });

  it("drops scripts, event handlers and javascript: links but keeps the text", () => {
    const html = render('<script>alert(1)</script><img src="x" onerror="alert(2)"><a href="javascript:alert(3)">click</a> <div onclick="x()">inside</div>');
    expect(html).not.toMatch(/<script|onerror|onclick|javascript:/);
    expect(html).toContain("click");
    expect(html).toContain("inside");
  });

  it("turns GitHub alerts into callouts", () => {
    const html = render("> [!WARNING]\n> Back up first.");
    expect(html).toContain('<div class="callout callout-warning">');
    expect(html).toContain('<p class="callout-title">Warning</p>');
    expect(html).toContain("Back up first.");
    expect(render("> just a quote")).toContain("<blockquote>");
  });

  it("styles task lists and tables like GitHub", () => {
    const html = render("- [x] done\n- [ ] todo\n\n| a | b |\n|---|---|\n| 1 | 2 |");
    expect(html).toContain('class="contains-task-list"');
    expect(html).toMatch(/<input type="checkbox" disabled="" checked=""/);
    expect(html).toContain("<table>");
  });

  it("normalises math the way models write it, without eating prices or code", () => {
    expect(normalizeMath("Euler: \\(e^{i\\pi}+1=0\\)")).toBe("Euler: $$e^{i\\pi}+1=0$$");
    expect(normalizeMath("\\[ a^2+b^2=c^2 \\]")).toBe("\n$$\na^2+b^2=c^2\n$$\n");
    expect(normalizeMath("so $x^2$ grows")).toBe("so $$x^2$$ grows");
    expect(normalizeMath("costs $5 and $10")).toBe("costs $5 and $10");
    expect(normalizeMath("between $5-$10 a day")).toBe("between $5-$10 a day");
    expect(normalizeMath("`echo $HOME $PATH`")).toBe("`echo $HOME $PATH`");
    expect(normalizeMath("```sh\necho $A $B\n```")).toBe("```sh\necho $A $B\n```");
    expect(render("so $x^2$ grows")).toContain('class="language-math math-inline"');
  });

  it("maps fence labels and file names to languages", () => {
    expect(languageOf("ts")).toBe("typescript");
    expect(languageOf("HTML")).toBe("html");
    expect(languageOf("sh")).toBe("bash");
    expect(languageOf("brainfuck")).toBeUndefined();
    expect(languageOfFile("agent.py")).toBe("python");
    expect(languageOfFile("src/Dockerfile")).toBe("docker");
    expect(languageOfFile("moka.json")).toBe("json");
  });

  it("renders math with KaTeX once it's loaded", async () => {
    const katex = await loadKatex();
    const html = renderToStaticMarkup(createElement(ReactMarkdown, { remarkPlugins, rehypePlugins: rehypePlugins(katex) }, normalizeMath("Pythagoras: \\(a^2+b^2=c^2\\)\n\n\\[\\int_0^1 x\\,dx\\]")));
    expect(html).toContain('class="katex"');
    expect(html).toContain('class="katex-display"');
  });

  it("keeps footnote links pointing at their notes", () => {
    const html = render("Fact.[^1]\n\n[^1]: Source.");
    const href = /href="#([^"]+)"[^>]*data-footnote-ref/.exec(html)?.[1];
    expect(href).toBeTruthy();
    expect(html).toContain(`id="${href}"`);
  });
});
