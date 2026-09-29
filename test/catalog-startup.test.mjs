import assert from "node:assert/strict";
import test, { after } from "node:test";
import fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { syncBuiltinESMExports } from "node:module";
import { catalogCachePath, writeCatalogCache } from "../src/catalog-cache.ts";

const directory = fs.mkdtempSync(join(tmpdir(), "pi-devin-catalog-test-"));
after(() => fs.rmSync(directory, { recursive: true, force: true }));
const cli = join(directory, process.platform === "win32" ? "devin.cmd" : "devin");
const counter = join(directory, "calls");
const catalog = { families: [{ family_label: "Test", family_uid: "test", slug: "test", variants: [{ model_uid: "test-high", label: "Test high", cost_summary: "$1/MTok In, $2/MTok Out" }] }] };
const script = join(directory, "catalog.cjs");
fs.writeFileSync(script, `const fs = require('node:fs');\nfs.appendFileSync(${JSON.stringify(counter)}, 'call\\n');\nsetTimeout(() => { console.log(process.env.TEST_CATALOG); process.exit(Number(process.env.TEST_CLI_EXIT || 0)); }, 30);\n`);
fs.writeFileSync(cli, process.platform === "win32" ? `@echo off\r\n"${process.execPath}" "${script}"\r\n` : `#!/bin/sh\nexec "${process.execPath}" "${script}"\n`, { mode: 0o700 });
const originalEnv = { ...process.env };
process.env.DEVIN_CLI = cli;
const { default: extension } = await import("../extensions/index.ts");
const { clearDevinBinCache } = await import("../src/cli.ts");
after(() => { if (originalEnv.DEVIN_CLI === undefined) delete process.env.DEVIN_CLI; else process.env.DEVIN_CLI = originalEnv.DEVIN_CLI; });

function setup(t) {
  clearDevinBinCache();
  const root = fs.mkdtempSync(join(directory, "cache-"));
  const previous = { ...process.env };
  process.env.XDG_CACHE_HOME = root;
  process.env.TEST_CATALOG = JSON.stringify(catalog);
  delete process.env.PI_OFFLINE;
  delete process.env.TEST_CLI_EXIT;
  fs.writeFileSync(counter, "");
  const read = fs.readFileSync, exists = fs.existsSync;
  const isCredentials = (path) => String(path).replaceAll("\\", "/").endsWith("devin/credentials.toml");
  t.mock.method(fs, "readFileSync", (path, ...args) => isCredentials(path) ? 'api_key = "synthetic-test-key"\n' : read(path, ...args));
  t.mock.method(fs, "existsSync", (path) => isCredentials(path) || exists(path));
  t.mock.method(console, "warn", () => {});
  syncBuiltinESMExports();
  const registrations = [], hooks = {}, commands = {};
  const pi = { registerProvider: (_id, config) => registrations.push(config), on: (name, fn) => hooks[name] = fn, registerCommand: (name, command) => commands[name] = command };
  t.after(async () => {
    await hooks.session_shutdown?.();
    t.mock.restoreAll(); syncBuiltinESMExports();
    for (const key of ["XDG_CACHE_HOME", "PI_OFFLINE", "TEST_CATALOG", "TEST_CLI_EXIT"]) {
      if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key];
    }
  });
  return { registrations, hooks, commands, pi, path: catalogCachePath(), calls: () => fs.readFileSync(counter, "utf8").split("\n").filter(Boolean).length };
}

test("fresh cache registers once without invoking the CLI", async (t) => {
  const x = setup(t); writeCatalogCache(catalog);
  await extension(x.pi);
  assert.equal(x.calls(), 0); assert.equal(x.registrations.length, 1);
  assert.equal(x.registrations[0].models[0].id, "test-high");
});

test("malformed cached cost data cannot prevent provider and command registration", async (t) => {
  const x = setup(t); process.env.PI_OFFLINE = "1";
  const malformed = structuredClone(catalog); malformed.families[0].variants[0].cost_summary = {};
  fs.mkdirSync(join(process.env.XDG_CACHE_HOME, "pi-devin"));
  fs.writeFileSync(x.path, JSON.stringify({ version: 1, fetchedAt: Date.now(), catalog: malformed }));
  await extension(x.pi);
  assert.equal(x.registrations.length, 1); assert.ok(x.registrations[0].models.length);
  assert.ok(x.commands["devin-refresh"]); assert.equal(x.calls(), 0);
});

test("cold startup loads and caches the CLI catalog", async (t) => {
  const x = setup(t); await extension(x.pi);
  assert.equal(x.calls(), 1); assert.equal(x.registrations.at(-1).models[0].id, "test-high");
  assert.deepEqual(JSON.parse(fs.readFileSync(x.path, "utf8")).catalog, catalog);
});

test("stale cache shares its background request with manual refresh", async (t) => {
  const x = setup(t); writeCatalogCache(catalog, x.path, 1);
  await extension(x.pi);
  const notifications = [];
  await x.commands["devin-refresh"].handler("", { ui: { notify: (...args) => notifications.push(args) } });
  assert.equal(x.calls(), 1); assert.equal(notifications.at(-1)[1], "info");
  assert.equal(x.registrations.at(-1).models[0].id, "test-high");
});

test("failed refresh retains cached models and does not overwrite the cache", async (t) => {
  const x = setup(t); writeCatalogCache(catalog, x.path, 1); process.env.TEST_CATALOG = '{"families":[{}]}';
  await extension(x.pi);
  const notifications = [];
  await x.commands["devin-refresh"].handler("", { ui: { notify: (...args) => notifications.push(args) } });
  assert.equal(notifications.at(-1)[1], "error"); assert.equal(x.registrations.length, 1);
  assert.deepEqual(JSON.parse(fs.readFileSync(x.path, "utf8")).catalog, catalog);
});

test("offline cold startup uses fallback without running the CLI", async (t) => {
  const x = setup(t); process.env.PI_OFFLINE = "true";
  await extension(x.pi); assert.equal(x.calls(), 0); assert.ok(x.registrations[0].models.length);
});

test("shutdown prevents a late background result from registering a provider", async (t) => {
  const x = setup(t); writeCatalogCache(catalog, x.path, 1);
  await extension(x.pi); await x.hooks.session_shutdown();
  await x.commands["devin-refresh"].handler("", { ui: { notify() {} } });
  assert.equal(x.registrations.length, 1);
});
