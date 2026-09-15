import test from "node:test";
import assert from "node:assert/strict";
import { MockPluginContext } from "@droposs/plugin-sdk";
import Plugin, {
  DEFAULT_USER_AGENT,
  PCGamingWikiProvider,
  compileTags,
  parseFirstYear,
  parseIdFromHref,
  parseWikiStringArray,
  type HttpFetch,
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

function stubWiki() {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const row = {
    PageID: "42",
    PageName: "Test Game",
    "Cover URL": null,
    Released: "2001-01-01",
    Developers: null,
    Publishers: null,
    Genres: null,
    Themes: null,
    Modes: null,
    Perspectives: null,
    "Art styles": null,
    Pacing: null,
  };
  const fetchFn: HttpFetch = async (url, init) => {
    calls.push({ url: String(url), init });
    const parsed = new URL(String(url));
    const action = parsed.searchParams.get("action");
    if (action === "query" && parsed.searchParams.get("meta") === "tokens") {
      return new Response(
        JSON.stringify({ query: { tokens: { logintoken: "login-token" } } }),
        {
          status: 200,
          headers: { "set-cookie": "wiki_session=abc; Path=/; HttpOnly" },
        },
      );
    }
    if (init?.method === "POST" && String(init.body).includes("action=login")) {
      return new Response(JSON.stringify({ login: { result: "Success" } }), {
        status: 200,
      });
    }
    if (action === "cargoquery") {
      return new Response(JSON.stringify({ cargoquery: [{ title: row }] }), {
        status: 200,
      });
    }
    if (action === "parse") {
      return new Response(
        JSON.stringify({
          parse: { text: { "*": '<div class="introduction"><p>Intro</p></div>' } },
        }),
        { status: 200 },
      );
    }
    return new Response("{}", { status: 200 });
  };
  return { calls, fetchFn };
}

test("search queries the renamed Game table and logs in when configured", async () => {
  const { calls, fetchFn } = stubWiki();
  const provider = new PCGamingWikiProvider(fetchFn, {
    username: "User@Bot",
    password: "secret",
  });

  const results = await provider.search("Test Game");
  assert.equal(results.length, 1);
  assert.equal(results[0].id, "42");
  assert.equal(results[0].title, "Test Game");

  const cargoQueryIndex = calls.findIndex((call) =>
    call.url.includes("action=cargoquery"),
  );
  assert.ok(cargoQueryIndex >= 0, "expected a cargoquery request");
  assert.equal(
    new URL(calls[cargoQueryIndex].url).searchParams.get("tables"),
    "Game",
  );

  const loginIndex = calls.findIndex(
    (call) =>
      call.init?.method === "POST" &&
      String(call.init.body).includes("action=login"),
  );
  assert.ok(loginIndex >= 0, "expected a login POST");
  assert.match(String(calls[loginIndex].init?.body), /lgname=User%40Bot/);

  const tokenIndex = calls.findIndex((call) => call.url.includes("meta=tokens"));
  assert.ok(tokenIndex < loginIndex && loginIndex < cargoQueryIndex);
});

test("search does not log in when no credentials are configured", async () => {
  const { calls, fetchFn } = stubWiki();
  const provider = new PCGamingWikiProvider(fetchFn);
  await provider.search("Test Game");
  assert.equal(
    calls.filter((call) => call.init?.method === "POST").length,
    0,
    "no login POST without credentials",
  );
});

test("getDetails reads the Game table by page id", async () => {
  const { calls, fetchFn } = stubWiki();
  const provider = new PCGamingWikiProvider(fetchFn);
  const details = await provider.getDetails("42");
  assert.ok(details);
  assert.equal(details.id, "42");
  assert.equal(details.description, "Intro");

  const cargo = calls.find((call) => call.url.includes("action=cargoquery"));
  assert.ok(cargo);
  assert.equal(new URL(cargo.url).searchParams.get("tables"), "Game");
});

async function withUserAgentEnv<T>(
  value: string | undefined,
  fn: () => Promise<T>,
): Promise<T> {
  const previous = process.env.PCG_USER_AGENT;
  if (value === undefined) {
    delete process.env.PCG_USER_AGENT;
  } else {
    process.env.PCG_USER_AGENT = value;
  }
  try {
    return await fn();
  } finally {
    if (previous === undefined) {
      delete process.env.PCG_USER_AGENT;
    } else {
      process.env.PCG_USER_AGENT = previous;
    }
  }
}

function requestHeader(
  call: { init?: RequestInit },
  name: string,
): string | undefined {
  return (call.init?.headers as Record<string, string> | undefined)?.[name];
}

test("sends the default User-Agent on every API request", async () => {
  await withUserAgentEnv(undefined, async () => {
    const { calls, fetchFn } = stubWiki();
    const provider = new PCGamingWikiProvider(fetchFn, {
      username: "User@Bot",
      password: "secret",
    });
    await provider.search("Test Game");
    assert.ok(
      calls.length >= 4,
      "expected login token, login, cargoquery, and parse requests",
    );
    for (const call of calls) {
      assert.equal(
        requestHeader(call, "user-agent"),
        DEFAULT_USER_AGENT,
        `missing User-Agent on ${call.url}`,
      );
    }
  });
});

test("PCG_USER_AGENT overrides the User-Agent", async () => {
  const override = "custom-agent/9.9 (contact@example.com)";
  await withUserAgentEnv(override, async () => {
    const { calls, fetchFn } = stubWiki();
    await new PCGamingWikiProvider(fetchFn).search("Test Game");
    assert.ok(calls.length > 0);
    for (const call of calls) {
      assert.equal(requestHeader(call, "user-agent"), override);
    }
  });
});

test("search escapes quotes, backslashes, and entities in the where clause", async () => {
  const { calls, fetchFn } = stubWiki();
  const provider = new PCGamingWikiProvider(fetchFn);
  await provider.search('Elden "Ring" & Co\\Ltd');

  const cargo = calls.find((call) => call.url.includes("action=cargoquery"));
  assert.ok(cargo);
  const where = new URL(cargo.url).searchParams.get("where");
  assert.equal(where, 'Game._pageName="Elden \\"Ring\\" &amp; Co\\\\Ltd"');

  const unescaped = where?.replace(/\\"/g, "") ?? "";
  assert.equal(
    unescaped.match(/"/g)?.length,
    2,
    "only the two delimiters may remain unescaped",
  );
});

test("getDetails escapes quotes in the page-id where clause", async () => {
  const { calls, fetchFn } = stubWiki();
  const provider = new PCGamingWikiProvider(fetchFn);
  await provider.getDetails('42" OR "1"="1');

  const cargo = calls.find((call) => call.url.includes("action=cargoquery"));
  assert.ok(cargo);
  assert.equal(
    new URL(cargo.url).searchParams.get("where"),
    'Game._pageID="42\\" OR \\"1\\"=\\"1"',
  );
});
