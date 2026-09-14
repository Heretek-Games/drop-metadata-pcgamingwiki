import test from "node:test";
import assert from "node:assert/strict";
import { MockPluginContext } from "@droposs/plugin-sdk";
import Plugin, { mapSearchResults } from "../src/index.js";

test("drop-metadata-pcgamingwiki registers a metadata provider", async () => {
  const ctx = new MockPluginContext("drop-metadata-pcgamingwiki", ["metadata:provider", "network"]);
  await new Plugin().init(ctx);
  assert.equal(ctx.metadataProviders.size, 1);
  assert.equal(ctx.metadataProviders.get("pcgamingwiki")?.name, "PCGamingWiki");
});

test("drop-metadata-pcgamingwiki maps a search payload", () => {
  const results = mapSearchResults([{ id: 1, name: "Hollow Knight", released: "2017-02-24" }]);
  assert.equal(results.length, 1);
  assert.equal(results[0].title, "Hollow Knight");
  assert.equal(results[0].releaseYear, 2017);
  assert.equal(results[0].provider, "pcgamingwiki");
});
