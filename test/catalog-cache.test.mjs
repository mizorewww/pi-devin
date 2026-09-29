import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  catalogCachePath,
  isUsableCatalog,
  isCatalogCacheFresh,
  readCatalogCache,
  writeCatalogCache,
} from "../src/catalog-cache.ts";

const catalog = {
  families: [{
    family_label: "SWE-2",
    family_uid: "swe-2",
    slug: "swe-2",
    variants: [{ model_uid: "swe-2-high", label: "SWE-2 High" }],
  }],
};

test("writes and reads a validated catalog atomically", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "pi-devin-cache-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, "nested", "models.json");
  writeCatalogCache(catalog, path, 1_000);
  assert.deepEqual(readCatalogCache(path), { catalog, fetchedAt: 1_000 });
  assert.equal(JSON.parse(readFileSync(path, "utf8")).version, 1);
});

test("rejects malformed cache content", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "pi-devin-cache-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, "models.json");
  writeFileSync(path, JSON.stringify({ version: 1, fetchedAt: 1_000, catalog: { families: [{}] } }));
  assert.throws(() => readCatalogCache(path), /Invalid Devin model catalog cache/);
});

test("rejects catalogs without usable model families", () => {
  assert.equal(isUsableCatalog({ families: [] }), false);
  assert.equal(isUsableCatalog({
    families: [{ family_label: "Empty", family_uid: "empty", slug: "empty", variants: [] }],
  }), false);
});

test("checks cache age and future timestamps", () => {
  const cached = { catalog, fetchedAt: 1_000 };
  assert.equal(isCatalogCacheFresh(cached, 1_500, 500), true);
  assert.equal(isCatalogCacheFresh(cached, 1_501, 500), false);
  assert.equal(isCatalogCacheFresh(cached, 999, 500), false);
});

test("uses XDG cache directory when configured", () => {
  assert.equal(catalogCachePath({ XDG_CACHE_HOME: "/cache" }, "/home/test"), join("/cache", "pi-devin", "models.json"));
  assert.equal(catalogCachePath({}, "/home/test"), join("/home/test", ".cache", "pi-devin", "models.json"));
});

for (const [field, value] of Object.entries({ cost_summary: {}, max_context_tokens: "1000", max_output_tokens: -1, model_uid: "", is_beta: "yes" })) {
  test(`rejects invalid ${field} before model conversion`, () => {
    const malformed = structuredClone(catalog);
    malformed.families[0].variants[0][field] = value;
    assert.equal(isUsableCatalog(malformed), false);
  });
}
