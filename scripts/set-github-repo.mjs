#!/usr/bin/env node
// Point every GitHub reference (repo URLs, GHCR image, docs site, changelog links)
// at a new owner/repo. npm package names (@mokalabs/*) are left alone.
//   node scripts/set-github-repo.mjs mokahq/moka
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

const target = process.argv[2];
if (!/^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/.test(target ?? "")) {
  console.error("Usage: node scripts/set-github-repo.mjs <owner>/<repo>");
  process.exit(1);
}
const [owner, repo] = target.split("/");
const lower = owner.toLowerCase();

const replacements = [
  [/github\.com\/mokalabs\/moka\b/g, `github.com/${owner}/${repo}`],
  [/ghcr\.io\/mokalabs\/moka\b/g, `ghcr.io/${lower}/moka`],
  [/mokalabs\.github\.io\/moka\b/g, `${lower}.github.io/${repo}`],
  [/mokalabs\.github\.io%2Fmoka\b/g, `${lower}.github.io%2F${repo}`],
  [/"repo": "mokalabs\/moka"/g, `"repo": "${owner}/${repo}"`],
  [/"https:\/\/mokalabs\.github\.io"/g, `"https://${lower}.github.io"`],
  [/\?\? "\/moka";/g, `?? "/${repo}";`],
];

const skip = new Set(["node_modules", "dist", ".git", ".astro", "pnpm-lock.yaml"]);
const exts = new Set([".json", ".md", ".mdx", ".mjs", ".ts", ".tsx", ".yml", ".yaml", ".html", ".astro", ""]);
let changed = 0;

function walk(dir) {
  for (const name of readdirSync(dir)) {
    if (skip.has(name)) continue;
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) walk(full);
    else if (exts.has(path.extname(name)) || name === "Dockerfile") {
      const before = readFileSync(full, "utf8");
      let after = before;
      for (const [re, to] of replacements) after = after.replace(re, to);
      if (after !== before) {
        writeFileSync(full, after);
        changed++;
        console.log("  updated", path.relative(process.cwd(), full));
      }
    }
  }
}

walk(process.cwd());
console.log(`\n✓ ${changed} files now point at github.com/${owner}/${repo}`);
console.log(`  npm packages stay @mokalabs/*; Docker image is ghcr.io/${lower}/moka; docs at https://${lower}.github.io/${repo}/`);
