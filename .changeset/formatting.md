---
"@mokalabs/sandbox": patch
"@mokalabs/core": patch
"@mokalabs/proxy": patch
"create-moka": patch
---

**Formatting.** Code is syntax-highlighted wherever Moka shows it (replies, the preview pane, Export, the inspector, JSON tool results), with light and dark themes and a header with the language and a copy button. The `moka.json`, tool-arguments and `SKILL.md` editors highlight as you type. Replies also get GitHub callouts (`> [!NOTE]`…), math (KaTeX: `$…$`, `\(…\)`, `$$…$$`, `\[…\]`), checklists, footnotes, and a short list of inline HTML: color, `mark`, `kbd`, `sub`, `sup`, `u`. Other HTML is dropped. Inter and JetBrains Mono now ship with Moka (before, they were used only if installed). The highlighter (Shiki) and KaTeX load only when needed.
