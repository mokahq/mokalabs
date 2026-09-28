#!/usr/bin/env node
// Tag vX.Y.Z and create a GitHub Release for every version in the sandbox
// CHANGELOG that is on npm but has no release yet. Safe to run repeatedly.
//
// changesets/action@v1 looks for "New tag:" lines to detect a publish, which
// @changesets/cli v3 no longer prints, so it never tags or creates releases.
//
//   node scripts/github-release.mjs            # create what's missing
//   node scripts/github-release.mjs --dry-run  # only print the plan
//
// Needs `gh` and GH_TOKEN. With WAIT_FOR_NPM=true it waits up to 10 minutes
// for the current version to show up on npm. Writes `published` and `version`
// to $GITHUB_OUTPUT when a release for the current version was created.
import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";

const PKG = "@mokalabs/sandbox";
const PKG_JSON = "packages/sandbox/package.json";
const CHANGELOG = "packages/sandbox/CHANGELOG.md";
const dryRun = process.argv.includes("--dry-run");

const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...opts }).trim();
const tryRun = (cmd, args) => {
  try {
    return run(cmd, args);
  } catch {
    return undefined;
  }
};

/** "## 0.2.1" sections of the changelog, newest first. */
function changelogSections() {
  const text = readFileSync(CHANGELOG, "utf8");
  const sections = [];
  const re = /^## (\d+\.\d+\.\d+[^\s]*)\s*$/gm;
  const heads = [...text.matchAll(re)];
  heads.forEach((m, i) => {
    const end = i + 1 < heads.length ? heads[i + 1].index : text.length;
    sections.push({ version: m[1], notes: text.slice(m.index + m[0].length, end).trim() });
  });
  return sections;
}

/** The commit that set packages/sandbox/package.json to this version. */
function versionCommit(version) {
  const log = run("git", ["log", "--format=%H", "-G", `"version": "${version.replace(/\./g, "\\.")}"`, "--", PKG_JSON]);
  const commits = log.split("\n").filter(Boolean);
  return commits.at(-1); // oldest commit that introduced the line
}

const npmVersions = () => new Set([JSON.parse(tryRun("npm", ["view", PKG, "versions", "--json"]) ?? "[]")].flat());
let published = npmVersions();
const releases = new Set(((dryRun ? tryRun : run)("gh", ["release", "list", "--limit", "200", "--json", "tagName", "--jq", ".[].tagName"]) ?? "").split("\n").filter(Boolean));
const current = JSON.parse(readFileSync(PKG_JSON, "utf8")).version;
const sections = changelogSections();

// Just published? The registry can take a few minutes to list the new version.
if (process.env.WAIT_FOR_NPM === "true" && !published.has(current) && !releases.has(`v${current}`)) {
  for (let i = 0; i < 20 && !published.has(current); i++) {
    console.log(`waiting for ${PKG}@${current} to appear on npm…`);
    await new Promise((r) => setTimeout(r, 30_000));
    published = npmVersions();
  }
}
let createdCurrent = false;

for (const { version, notes } of [...sections].reverse()) {
  const tag = `v${version}`;
  if (releases.has(tag)) continue;
  if (!published.has(version)) {
    console.log(`skip ${tag}: ${PKG}@${version} is not on npm`);
    continue;
  }
  const sha = versionCommit(version);
  if (!sha) {
    console.log(`skip ${tag}: no commit sets version ${version}`);
    continue;
  }
  const body = `${notes}\n\n---\n\n\`\`\`\nnpx ${PKG}@${version}\n\`\`\`\n\nnpm: https://www.npmjs.com/package/${PKG}/v/${version}`;
  console.log(`${dryRun ? "would create" : "creating"} ${tag} at ${sha.slice(0, 7)}${version === current ? " (latest)" : ""}`);
  if (dryRun) continue;
  run("gh", ["release", "create", tag, "--target", sha, "--title", `Moka ${version}`, "--notes-file", "-", ...(version === current ? ["--latest"] : ["--latest=false"])], {
    input: body,
    stdio: ["pipe", "pipe", "inherit"],
  });
  if (version === current) createdCurrent = true;
}

if (process.env.GITHUB_OUTPUT) {
  appendFileSync(process.env.GITHUB_OUTPUT, `published=${createdCurrent}\nversion=${current}\n`);
}
