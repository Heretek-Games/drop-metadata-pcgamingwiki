import * as cheerio from "cheerio";
import { DateTime } from "luxon";
import type {
  MetadataDetails,
  MetadataProvider,
  MetadataSearchResult,
  PluginContext,
  ServerPlugin,
} from "@droposs/plugin-sdk";

export type HttpFetch = (
  input: string | URL,
  init?: RequestInit,
) => Promise<Response>;

const API_BASE = "https://www.pcgamingwiki.com/w/api.php";

interface PCGamingWikiParseRawPage {
  parse?: {
    text?: { "*"?: string };
  };
}

interface PCGamingWikiSearchStub {
  PageID: string;
  PageName: string;
  "Cover URL": string | null;
  Released: string | null;
}

type WikiStringList = string | string[] | null;

interface PCGamingWikiGame extends PCGamingWikiSearchStub {
  Developers: WikiStringList;
  Publishers: WikiStringList;
  Genres: WikiStringList;
  Themes: WikiStringList;
  Modes: WikiStringList;
  Perspectives: WikiStringList;
  "Art styles": WikiStringList;
  Pacing: WikiStringList;
}

interface CargoResult<T> {
  cargoquery?: Array<{ title: T }>;
  error?: unknown;
}

/** Parses the wiki's `Company:A,Company:B` / `[A, B]` list format. */
export function parseWikiStringArray(input: string | string[]): string[] {
  const clean = (value: string) => value.replace("Company:", "").trim();
  const items = Array.isArray(input) ? input : input.split(",");
  return items.map(clean).filter((value) => value !== "");
}

/** Extracts the review provider id from a Metacritic/OpenCritic/IGDB href. */
export function parseIdFromHref(href: string): string | undefined {
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return undefined;
  }
  switch (url.hostname.toLowerCase()) {
    case "www.metacritic.com":
      return url.pathname
        .replace("/game/", "")
        .replace("/critic-reviews", "")
        .replace(/\/$/, "");
    case "opencritic.com": {
      const match = /^\/game\/(\d+)\/.+$/.exec(url.pathname);
      return match?.[1];
    }
    case "www.igdb.com":
      return url.pathname.replace("/games/", "").replace(/\/$/, "");
    default:
      return undefined;
  }
}

/** Parses the wiki's `1998-11-30;2000-01-01` multi-date format to a year. */
export function parseFirstYear(released: string | null): number | undefined {
  if (!released) return undefined;
  const first = released.split(";")[0];
  if (!first) return undefined;
  const parsed = DateTime.fromISO(first);
  return parsed.isValid ? parsed.year : undefined;
}

/** Flattens the wiki's tag columns into a single list. */
export function compileTags(game: PCGamingWikiGame): string[] {
  const columns: Array<keyof PCGamingWikiGame> = [
    "Art styles",
    "Genres",
    "Modes",
    "Pacing",
    "Perspectives",
    "Themes",
  ];
  const tags: string[] = [];
  for (const column of columns) {
    const value = game[column];
    if (value === null) continue;
    tags.push(...parseWikiStringArray(value));
  }
  return tags;
}

/** Bot-password credentials (`User@BotName` + bot password). */
export interface PCGamingWikiCredentials {
  username: string;
  password: string;
}

export class PCGamingWikiProvider implements MetadataProvider {
  id = "pcgamingwiki";
  name = "PCGamingWiki";
  private cookie?: string;
  private login?: Promise<void>;

  constructor(
    private readonly fetchFn: HttpFetch,
    private readonly credentials?: PCGamingWikiCredentials,
  ) {}

  private cookieHeader(): Record<string, string> {
    return this.cookie ? { cookie: this.cookie } : {};
  }

  private captureCookies(response: Response): void {
    const headers = response.headers as Headers & {
      getSetCookie?: () => string[];
    };
    const raw =
      typeof headers.getSetCookie === "function"
        ? headers.getSetCookie()
        : [headers.get("set-cookie") ?? ""].filter(Boolean);
    const jar = new Map<string, string>();
    for (const line of [...(this.cookie?.split("; ") ?? []), ...raw]) {
      const pair = line.split(";")[0]?.trim();
      if (!pair) continue;
      const separator = pair.indexOf("=");
      if (separator <= 0) continue;
      jar.set(pair.slice(0, separator), pair.slice(separator + 1));
    }
    this.cookie = [...jar.entries()].map(([key, value]) => `${key}=${value}`).join("; ");
  }

  private async get<T>(params: URLSearchParams): Promise<T> {
    const response = await this.fetchFn(`${API_BASE}?${params.toString()}`, {
      headers: this.cookieHeader(),
    });
    this.captureCookies(response);
    if (!response.ok) {
      throw new Error(`PCGamingWiki request failed: ${response.status}`);
    }
    return (await response.json()) as T;
  }

  /** Log in with the configured bot password (required by `cargoquery`). */
  private async ensureLoggedIn(): Promise<void> {
    if (!this.credentials) return;
    if (!this.login) {
      this.login = this.loginInternal().catch((error) => {
        this.login = undefined;
        throw error;
      });
    }
    return this.login;
  }

  private async loginInternal(): Promise<void> {
    const credentials = this.credentials;
    if (!credentials) return;
    const tokenData = await this.get<{
      query?: { tokens?: { logintoken?: string } };
    }>(
      new URLSearchParams({
        action: "query",
        meta: "tokens",
        type: "login",
        format: "json",
      }),
    );
    const logintoken = tokenData.query?.tokens?.logintoken;
    if (!logintoken) {
      throw new Error("PCGamingWiki login token missing");
    }

    const response = await this.fetchFn(API_BASE, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        ...this.cookieHeader(),
      },
      body: new URLSearchParams({
        action: "login",
        lgname: credentials.username,
        lgpassword: credentials.password,
        lgtoken: logintoken,
        format: "json",
      }),
    });
    this.captureCookies(response);
    if (!response.ok) {
      throw new Error(`PCGamingWiki login failed: ${response.status}`);
    }
    const result = (await response.json()) as {
      login?: { result?: string };
    };
    if (result.login?.result !== "Success") {
      throw new Error(
        `PCGamingWiki login failed: ${result.login?.result ?? "unknown"}`,
      );
    }
  }

  private async request<T>(params: URLSearchParams): Promise<T> {
    // Since 2026-08-23 the wiki requires a bot-password session for cargoquery.
    if (params.get("action") === "cargoquery") {
      await this.ensureLoggedIn();
    }
    return this.get<T>(params);
  }

  private async cargoQuery<T>(params: URLSearchParams): Promise<T[]> {
    const result = await this.request<CargoResult<T>>(params);
    if (result.error !== undefined) {
      throw new Error("PCGamingWiki cargo query failed");
    }
    return (result.cargoquery ?? []).map((entry) => entry.title);
  }

  private async pageContent(pageId: string): Promise<{
    shortIntro: string;
    introduction: string;
  }> {
    const params = new URLSearchParams({
      action: "parse",
      format: "json",
      pageid: pageId,
    });
    const result = await this.request<PCGamingWikiParseRawPage>(params);
    const html = result.parse?.text?.["*"] ?? "";
    const $ = cheerio.load(html);
    const introduction = $(".introduction").first();
    introduction.find("sup").remove();
    return {
      shortIntro: introduction.find("p").first().text().trim(),
      introduction: introduction.text().trim(),
    };
  }

  async search(query: string): Promise<MetadataSearchResult[]> {
    const params = new URLSearchParams({
      action: "cargoquery",
      tables: "Game",
      fields:
        "Game._pageID=PageID,Game._pageName=PageName,Game.Cover_URL,Game.Released",
      where: `Game._pageName="${query}"`,
      format: "json",
    });

    const rows = await this.cargoQuery<PCGamingWikiSearchStub>(params);
    const results: MetadataSearchResult[] = [];
    for (const row of rows) {
      const content = await this.pageContent(row.PageID);
      results.push({
        id: row.PageID,
        title: row.PageName,
        coverUrl: row["Cover URL"] ?? undefined,
        description: content.shortIntro,
        releaseYear: parseFirstYear(row.Released),
        provider: this.id,
      });
    }
    return results;
  }

  async getDetails(id: string): Promise<MetadataDetails | null> {
    const params = new URLSearchParams({
      action: "cargoquery",
      tables: "Game",
      fields:
        "Game._pageID=PageID,Game._pageName=PageName,Game.Cover_URL,Game.Developers,Game.Released,Game.Genres,Game.Publishers,Game.Themes,Game.Modes,Game.Perspectives,Game.Art_styles,Game.Pacing",
      where: `Game._pageID="${id}"`,
      format: "json",
    });

    const [rows, content] = await Promise.all([
      this.cargoQuery<PCGamingWikiGame>(params),
      this.pageContent(id),
    ]);

    const game = rows[0];
    if (!game) return null;

    return {
      id: game.PageID,
      title: game.PageName,
      provider: this.id,
      coverUrl: game["Cover URL"] ?? undefined,
      description: content.introduction || content.shortIntro,
      releaseYear: parseFirstYear(game.Released),
      genres: compileTags(game),
      developers:
        game.Developers !== null ? parseWikiStringArray(game.Developers) : [],
      publishers:
        game.Publishers !== null ? parseWikiStringArray(game.Publishers) : [],
      screenshots: [],
    };
  }
}

export default class PCGamingWikiPlugin implements ServerPlugin {
  metadata = {
    id: "drop-metadata-pcgamingwiki",
    name: "PCGamingWiki",
    version: "0.1.0",
    apiVersion: 2,
    capabilities: ["metadata:provider" as const, "network" as const],
  };

  async init(ctx: PluginContext): Promise<void> {
    const username = process.env.PCGAMINGWIKI_BOT_USERNAME;
    const password = process.env.PCGAMINGWIKI_BOT_PASSWORD;
    const credentials =
      username && password ? { username, password } : undefined;
    ctx.registerMetadataProvider(
      new PCGamingWikiProvider(ctx.fetch.bind(ctx), credentials),
    );
    if (!credentials) {
      ctx.logger.warn(
        "PCGamingWiki bot credentials are not configured " +
          "(set PCGAMINGWIKI_BOT_USERNAME/PCGAMINGWIKI_BOT_PASSWORD); " +
          "cargoquery searches will be rejected by the wiki",
      );
    }
    ctx.logger.info("PCGamingWiki metadata provider registered");
  }
}
