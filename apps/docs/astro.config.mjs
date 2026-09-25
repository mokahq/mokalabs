// @ts-check
import starlight from "@astrojs/starlight";
import { defineConfig } from "astro/config";
import rehypeBaseLinks from "./plugins/rehype-base-links.mjs";

// Deployed to GitHub Pages. Override with DOCS_SITE / DOCS_BASE for a custom domain (e.g. https://docs.mokalabs.dev, "/").
const site = process.env.DOCS_SITE ?? "https://thebunnyweb.github.io";
const base = process.env.DOCS_BASE ?? "/mokalabs";

export default defineConfig({
  site,
  base,
  markdown: { rehypePlugins: [[rehypeBaseLinks, { base }]] },
  integrations: [
    starlight({
      title: "Moka",
      description: "Any LLM. Any MCP server. Any skill. One command.",
      logo: { src: "./src/assets/logo.svg", replacesTitle: false },
      favicon: "/favicon.svg",
      social: [
        { icon: "github", label: "GitHub", href: "https://github.com/thebunnyweb/mokalabs" },
        { icon: "seti:npm", label: "npm", href: "https://www.npmjs.com/package/@mokalabs/sandbox" },
      ],
      editLink: { baseUrl: "https://github.com/thebunnyweb/mokalabs/edit/main/apps/docs/" },
      lastUpdated: true,
      customCss: ["./src/styles/theme.css"],
      head: [
        { tag: "meta", attrs: { property: "og:image", content: `${site}${base}/og.png` } },
      ],
      sidebar: [
        {
          label: "Start here",
          items: [
            { label: "Introduction", slug: "introduction" },
            { label: "Quickstart", slug: "quickstart" },
            { label: "Installation", slug: "installation" },
            { label: "Tutorial: your first demo", slug: "tutorial" },
          ],
        },
        {
          label: "Guides",
          items: [
            { label: "Models & providers", slug: "guides/models" },
            { label: "MCP servers", slug: "guides/mcp-servers" },
            { label: "Skills", slug: "guides/skills" },
            { label: "Workspaces & demos", slug: "guides/workspaces" },
            { label: "Inspector", slug: "guides/inspector" },
            { label: "Compare models", slug: "guides/compare" },
            { label: "Tool runner", slug: "guides/tool-runner" },
            { label: "Export to code", slug: "guides/export" },
          ],
        },
        {
          label: "Generative UI",
          badge: { text: "New", variant: "tip" },
          items: [
            { label: "Overview", slug: "generative-ui/overview" },
            { label: "MCP Apps", slug: "generative-ui/mcp-apps" },
            { label: "Build an MCP App", slug: "generative-ui/build-an-mcp-app" },
            { label: "A2UI", slug: "generative-ui/a2ui" },
            { label: "A2UI component catalog", slug: "generative-ui/a2ui-components" },
          ],
        },
        {
          label: "Deploy & share",
          items: [
            { label: "Docker", slug: "deploy/docker" },
            { label: "Sharing demos", slug: "deploy/sharing" },
            { label: "Security", slug: "deploy/security" },
          ],
        },
        {
          label: "Reference",
          items: [
            { label: "CLI", slug: "reference/cli" },
            { label: "moka.json", slug: "reference/config" },
            { label: "Environment variables", slug: "reference/environment" },
            { label: "Inspector events", slug: "reference/events" },
            { label: "HTTP API", slug: "reference/http-api" },
            { label: "@mokalabs/core", slug: "reference/core" },
          ],
        },
        {
          label: "Help",
          items: [
            { label: "Troubleshooting", slug: "help/troubleshooting" },
            { label: "FAQ", slug: "help/faq" },
            { label: "Contributing", slug: "help/contributing" },
          ],
        },
      ],
    }),
  ],
});
