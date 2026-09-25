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

// Work out where links currently point (default: the original mokalabs/moka).
const current = (() => {
  try {
    const pkg = JSON.parse(readFileSync("packages/core/package.json", "utf8"));
    const m = /github\.com\/([^/]+)\/([^/.]+)/.exec(pkg.repository?.url ?? "");
    if (m) return { owner: m[1], repo: m[2] };
  } catch {}
  return { owner: "mokalabs", repo: "moka" };
})();
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const O = esc(current.owner), R = esc(current.repo), o = esc(current.owner.toLowerCase());
console.log(`Retargeting ${current.owner}/${current.repo} -> ${owner}/${repo}`);

const replacements = [
  [new RegExp(`github\\.com/${O}/${R}\\b`, "g"), `github.com/${owner}/${repo}`],
  [new RegExp(`ghcr\\.io/${o}/moka\\b`, "g"), `ghcr.io/${lower}/moka`],
  [new RegExp(`${o}\\.github\\.io/${R}\\b`, "g"), `${lower}.github.io/${repo}`],
  [new RegExp(`${o}\\.github\\.io%2F${R}\\b`, "g"), `${lower}.github.io%2F${repo}`],
  [new RegExp(`"repo": "${O}/${R}"`, "g"), `"repo": "${owner}/${repo}"`],
  [new RegExp(`"https://${o}\\.github\\.io"`, "g"), `"https://${lower}.github.io"`],
  [new RegExp(`\\?\\? "/${R}";`, "g"), `?? "/${repo}";`],
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
