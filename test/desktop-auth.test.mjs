import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readDevinDesktopApiKey } from '../src/desktop-auth.ts';

test('does not resurrect a logged-out Desktop token from freed SQLite pages', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'devin-desktop-test-'));
  const path = join(dir, 'state.vscdb'); const previous = process.env.DEVIN_DESKTOP_STATE_DB;
  process.env.DEVIN_DESKTOP_STATE_DB = path;
  t.after(() => { if (previous === undefined) delete process.env.DEVIN_DESKTOP_STATE_DB; else process.env.DEVIN_DESKTOP_STATE_DB = previous; rmSync(dir, {recursive:true, force:true}); });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA secure_delete=OFF; CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value TEXT)');
  const key = 'synthetic-desktop-token-for-test';
  db.prepare('INSERT INTO ItemTable VALUES (?, ?)').run('windsurfAuthStatus', JSON.stringify({apiKey:key}));
  assert.equal((await readDevinDesktopApiKey()).apiKey, key);
  db.prepare('DELETE FROM ItemTable WHERE key=?').run('windsurfAuthStatus');
  db.close();
  assert.equal(await readDevinDesktopApiKey(), null);
});
