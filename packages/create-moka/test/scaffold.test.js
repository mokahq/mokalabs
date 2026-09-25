import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { detectPackageManager, scaffold, toPackageName } from "../index.js";

test("scaffold copies the template, restores dotfiles and names the package", () => {
  const dir = path.join(mkdtempSync(path.join(os.tmpdir(), "create-moka-")), "My Demo");
  scaffold(dir);
  assert.ok(existsSync(path.join(dir, "moka.json")));
  assert.ok(existsSync(path.join(dir, ".gitignore")));
  assert.ok(existsSync(path.join(dir, ".env.example")));
  assert.ok(existsSync(path.join(dir, "skills/brand-voice/SKILL.md")));
  const pkg = JSON.parse(readFileSync(path.join(dir, "package.json"), "utf8"));
  assert.equal(pkg.name, "my-demo");
  const config = JSON.parse(readFileSync(path.join(dir, "moka.json"), "utf8"));
  assert.equal(config.version, 1);
  assert.ok(config.workspaces.length >= 1);
});

test("scaffold refuses non-empty folders", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "create-moka-"));
  scaffold(path.join(dir, "a"));
  assert.throws(() => scaffold(path.join(dir, "a")), /not empty/);
});

test("helpers", () => {
  assert.equal(toPackageName("./Hello World!"), "hello-world");
  assert.equal(detectPackageManager("pnpm/10.0.0 npm/? node/v22"), "pnpm");
  assert.equal(detectPackageManager(""), "npm");
});
