#!/usr/bin/env node
// create-moka — scaffold a shareable Moka demo. Zero dependencies on purpose.
import { cpSync, existsSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const tty = process.stdout.isTTY;
const c = (code) => (s) => (tty ? `\x1b[${code}m${s}\x1b[0m` : s);
const bold = c(1);
const dim = c(2);
const accent = c(33);
const red = c(31);

const HELP = `
  ${accent("☕ create-moka")} — scaffold a Moka demo project

  Usage
    npm create moka@latest [dir]
    pnpm create moka [dir]
    npx create-moka [dir] [--yes]

  Options
    -y, --yes      accept defaults, no prompts
    -h, --help     show this help
`;

export function toPackageName(input) {
  return (
    path
      .basename(path.resolve(input))
      .toLowerCase()
      .replace(/[^a-z0-9-~._]+/g, "-")
      .replace(/^[-._]+|[-._]+$/g, "") || "moka-demo"
  );
}

export function detectPackageManager(userAgent = process.env.npm_config_user_agent ?? "") {
  if (userAgent.startsWith("pnpm")) return "pnpm";
  if (userAgent.startsWith("yarn")) return "yarn";
  if (userAgent.startsWith("bun")) return "bun";
  return "npm";
}

export function scaffold(targetDir, { name } = {}) {
  const target = path.resolve(targetDir);
  if (existsSync(target) && readdirSync(target).filter((f) => f !== ".git").length > 0) {
    throw new Error(`${targetDir} is not empty`);
  }
  cpSync(path.join(here, "templates", "default"), target, { recursive: true });
  // npm strips dotfiles from published packages, so templates ship them with a leading underscore.
  for (const file of ["_gitignore", "_env.example"]) {
    const from = path.join(target, file);
    if (existsSync(from)) renameSync(from, path.join(target, file.replace(/^_/, ".")));
  }
  const pkgPath = path.join(target, "package.json");
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
  pkg.name = name ?? toPackageName(targetDir);
  writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);
  return target;
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes("-h") || args.includes("--help")) {
    console.log(HELP);
    return;
  }
  const yes = args.includes("-y") || args.includes("--yes");
  let dir = args.find((a) => !a.startsWith("-"));

  console.log(`\n  ${accent("☕ create-moka")}\n`);
  if (!dir) {
    if (yes || !process.stdin.isTTY) dir = "moka-demo";
    else {
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      dir = (await rl.question(`  ${bold("Project folder")} ${dim("(moka-demo)")} › `)).trim() || "moka-demo";
      rl.close();
    }
  }

  const target = scaffold(dir);
  const pm = detectPackageManager();
  const run = pm === "npm" ? "npm run" : pm;
  const rel = path.relative(process.cwd(), target) || ".";
  console.log(`  ${c(32)("✓")} Created ${bold(rel)}\n`);
  console.log(`  Next steps:\n`);
  if (rel !== ".") console.log(`    cd ${rel}`);
  console.log(`    ${pm} install`);
  console.log(`    export OPENAI_API_KEY=…   ${dim("# or ANTHROPIC_API_KEY, GEMINI_API_KEY, or run Ollama")}`);
  console.log(`    ${run} start\n`);
  console.log(`  ${dim("Edit moka.json (or use the Settings UI) to add models, MCP servers and skills.")}\n`);
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly || process.argv[1]?.endsWith("create-moka")) {
  main().catch((error) => {
    console.error(`  ${red("✗")} ${error.message}`);
    process.exit(1);
  });
}
