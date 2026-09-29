import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { clearDevinBinCache, findDevinBin, whichDevin, runDevin } from "../src/cli.ts";

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), "pi devin cli "));
  // Windows environment lookups ignore case; a spread object does not.
  const keys = ["DEVIN_CLI", "LOCALAPPDATA", "ProgramFiles", "PATH"];
  const original = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  clearDevinBinCache();
  t.after(() => {
    for (const key of keys) {
      if (original[key] === undefined) delete process.env[key]; else process.env[key] = original[key];
    }
    clearDevinBinCache(); rmSync(directory, { recursive: true, force: true });
  });
  return directory;
}

test("honors an override set after the discovery cache has already been populated", async (t) => {
  const directory = fixture(t);
  const first = join(directory, "first"), second = join(directory, "second");
  writeFileSync(first, ""); writeFileSync(second, "");
  process.env.DEVIN_CLI = first; assert.equal(findDevinBin(), first);
  process.env.DEVIN_CLI = second; assert.equal(await whichDevin(), second);
});

test("runs a native executable directly with argument boundaries intact", async (t) => {
  fixture(t); process.env.DEVIN_CLI = process.execPath;
  const value = 'spaces & punctuation "stay literal"';
  const result = await runDevin(["-e", "process.stdout.write(process.argv[1])", value]);
  assert.equal(result.code, 0); assert.equal(result.stdout, value);
});

test("finds the Windows installer binary and ignores a directory override", { skip: process.platform !== "win32" }, (t) => {
  const directory = fixture(t); process.env.LOCALAPPDATA = directory;
  process.env.DEVIN_CLI = directory;
  const binary = join(directory, "devin", "cli", "bin", "devin.exe");
  mkdirSync(dirname(binary), { recursive: true }); writeFileSync(binary, "");
  assert.equal(findDevinBin(), binary);
});

test("Windows PATH lookup uses where.exe and reads multiple results", { skip: process.platform !== "win32" }, async (t) => {
  const directory = fixture(t); delete process.env.DEVIN_CLI;
  process.env.LOCALAPPDATA = directory; process.env.ProgramFiles = directory;
  const bin = join(directory, "path bin"); mkdirSync(bin);
  const binary = join(bin, "devin.exe"); writeFileSync(binary, "");
  const otherBin = join(directory, "other bin"); mkdirSync(otherBin);
  writeFileSync(join(otherBin, "devin.exe"), "");
  process.env.PATH = `${bin};${otherBin};${process.env.PATH}`;
  const located = await whichDevin();
  const probe = spawnSync("where.exe", ["devin.exe"], { encoding: "utf8" });
  assert.ok(located, JSON.stringify({ status: probe.status, stdout: probe.stdout, stderr: probe.stderr, error: probe.error?.message }));
  // where.exe expands Windows short paths such as RUNNER~1.
  assert.equal(realpathSync.native(located), realpathSync.native(binary));
  assert.ok(probe.stdout.trim().split(/\r?\n/).length >= 2);
});

test("Windows batch wrappers work in paths with spaces, including inherited stdio", { skip: process.platform !== "win32" }, async (t) => {
  const directory = fixture(t), script = join(directory, "echo.cjs"), wrapper = join(directory, "devin.cmd");
  writeFileSync(script, 'process.stdout.write(JSON.stringify(process.argv.slice(2)));');
  writeFileSync(wrapper, `@echo off\r\n"${process.execPath}" "${script}" %*\r\n`);
  process.env.DEVIN_CLI = wrapper;
  const result = await runDevin(["models", "list", "--format", "json", "a b"]);
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), ["models", "list", "--format", "json", "a b"]);
  assert.equal((await runDevin(["version"], { inheritStdio: true })).code, 0);
  await assert.rejects(runDevin(["%PATH%"]), /Unsupported shell characters/);
});
