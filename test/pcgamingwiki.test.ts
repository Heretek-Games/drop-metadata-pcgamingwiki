import test from "node:test";
import assert from "node:assert/strict";
import { MockPluginContext } from "@droposs/plugin-sdk";
import Plugin, {
  compileTags,
  parseFirstYear,
  parseIdFromHref,
  parseWikiStringArray,
} from "../src/index.js";

test("drop-metadata-pcgamingwiki registers a metadata provider", async () => {
  const ctx = new MockPluginContext("drop-metadata-pcgamingwiki", [
    "metadata:provider",
    "network",
  ]);
  await new Plugin().init(ctx);
  assert.equal(ctx.metadataProviders.size, 1);
  assert.equal(ctx.metadataProviders.get("pcgamingwiki")?.name, "PCGamingWiki");
});

test("parseWikiStringArray handles comma strings, arrays, and prefixes", () => {
  assert.deepEqual(
    parseWikiStringArray("Company:Digerati Distribution,Company:Greylock Studio"),
    ["Digerati Distribution", "Greylock Studio"],
  );
  assert.deepEqual(parseWikiStringArray(["Company:A", "", "B"]), ["A", "B"]);
});

test("parseIdFromHref extracts ids for known review providers", () => {
  assert.equal(
    parseIdFromHref("https://opencritic.com/game/12090/elden-ring"),
    "12090",
  );
  assert.equal(
    parseIdFromHref("https://www.igdb.com/games/elden-ring"),
    "elden-ring",
  );
  assert.equal(parseIdFromHref("https://example.com/x"), undefined);
});

test("parseFirstYear reads multi-date fields", () => {
  assert.equal(parseFirstYear("1998-11-30;2000-01-01"), 1998);
  assert.equal(parseFirstYear(null), undefined);
});

test("compileTags flattens the wiki tag columns", () => {
  const tags = compileTags({
    PageID: "1",
    PageName: "Game",
    "Cover URL": null,
    Released: null,
    Developers: null,
    Publishers: null,
    Genres: ["Action", "FPS"],
    Themes: "Sci-fi",
    Modes: null,
    Perspectives: null,
    "Art styles": null,
    Pacing: null,
  });
  assert.deepEqual(tags, ["Action", "FPS", "Sci-fi"]);
});
