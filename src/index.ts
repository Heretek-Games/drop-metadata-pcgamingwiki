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

export class PCGamingWikiProvider implements MetadataProvider {
  id = "pcgamingwiki";
  name = "PCGamingWiki";

  constructor(private readonly fetchFn: HttpFetch) {}

  private async request<T>(params: URLSearchParams): Promise<T> {
    const response = await this.fetchFn(`${API_BASE}?${params.toString()}`);
    if (!response.ok) {
      throw new Error(`PCGamingWiki request failed: ${response.status}`);
    }
    return (await response.json()) as T;
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
      tables: "Infobox_game",
      fields:
        "Infobox_game._pageID=PageID,Infobox_game._pageName=PageName,Infobox_game.Cover_URL,Infobox_game.Released",
      where: `Infobox_game._pageName="${query}"`,
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
      tables: "Infobox_game",
      fields:
        "Infobox_game._pageID=PageID,Infobox_game._pageName=PageName,Infobox_game.Cover_URL,Infobox_game.Developers,Infobox_game.Released,Infobox_game.Genres,Infobox_game.Publishers,Infobox_game.Themes,Infobox_game.Modes,Infobox_game.Perspectives,Infobox_game.Art_styles,Infobox_game.Pacing",
      where: `Infobox_game._pageID="${id}"`,
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
    ctx.registerMetadataProvider(
      new PCGamingWikiProvider(ctx.fetch.bind(ctx)),
    );
    ctx.logger.info("PCGamingWiki metadata provider registered");
  }
}
