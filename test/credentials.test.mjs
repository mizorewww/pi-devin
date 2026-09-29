import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { syncBuiltinESMExports } from 'node:module';
import { authStatus } from '../src/credentials.ts';
import { clearDevinBinCache } from '../src/cli.ts';

test('an existing credential file cannot turn CLI Not logged in into a successful status', async (t) => {
  const dir = fs.mkdtempSync(join(tmpdir(), 'devin-auth-test-'));
  const script = join(dir, 'status.cjs');
  fs.writeFileSync(script, 'console.log("Not logged in");');
  const cli = join(dir, process.platform === 'win32' ? 'devin.cmd' : 'devin');
  fs.writeFileSync(cli, process.platform === 'win32' ? `@echo off\r\n"${process.execPath}" "${script}"\r\n` : `#!/bin/sh\nexec "${process.execPath}" "${script}"\n`, {mode: 0o700});
  const previous = process.env.DEVIN_CLI;
  process.env.DEVIN_CLI = cli; clearDevinBinCache();
  const read = fs.readFileSync, exists = fs.existsSync;
  const isCredentials = (path) => String(path).replaceAll('\\', '/').endsWith('devin/credentials.toml');
  t.mock.method(fs, 'readFileSync', (path, ...args) => isCredentials(path) ? 'api_key = "synthetic-test-key"\n' : read(path, ...args));
  t.mock.method(fs, 'existsSync', (path) => isCredentials(path) || exists(path));
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); if (previous === undefined) delete process.env.DEVIN_CLI; else process.env.DEVIN_CLI = previous; clearDevinBinCache(); fs.rmSync(dir, {recursive:true, force:true}); });
  const status = await authStatus();
  assert.equal(status.loggedIn, false);
  assert.equal(status.summary, 'Not logged in');
});
