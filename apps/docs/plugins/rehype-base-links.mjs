// Prefix root-relative links ("/guides/x/") with the site's base path so docs
// work on GitHub Pages ("/moka/") and custom domains ("/") alike.
export default function rehypeBaseLinks({ base = "/" } = {}) {
  const prefix = base.replace(/\/$/, "");
  const fix = (href) =>
    typeof href === "string" && href.startsWith("/") && !href.startsWith("//") && prefix && !href.startsWith(`${prefix}/`) ? `${prefix}${href}` : href;
  return (tree) => {
    const visit = (node) => {
      if (node.type === "element" && node.tagName === "a" && node.properties) {
        node.properties.href = fix(node.properties.href);
      }
      // MDX components such as <LinkCard href="/x/" />
      if ((node.type === "mdxJsxFlowElement" || node.type === "mdxJsxTextElement") && Array.isArray(node.attributes)) {
        for (const attr of node.attributes) if (attr.name === "href" && typeof attr.value === "string") attr.value = fix(attr.value);
      }
      (node.children ?? []).forEach(visit);
    };
    visit(tree);
  };
}
