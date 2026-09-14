import type {
  MetadataDetails,
  MetadataProvider,
  MetadataSearchResult,
  PluginContext,
  ServerPlugin,
} from "@droposs/plugin-sdk";

export type HttpFetch = (input: string | URL, init?: RequestInit) => Promise<Response>;

const API_BASE = "https://www.pcgamingwiki.com/w/api.php";
const API_KEY_ENV = "PCGAMINGWIKI_API_KEY";

interface RawRecord {
  id?: string | number;
  name?: string;
  title?: string;
  releaseYear?: number;
  released?: string;
  cover?: { url?: string };
  coverUrl?: string;
  bannerUrl?: string;
  iconUrl?: string;
  description?: string;
  summary?: string;
}

/** Maps provider payloads (arrays under `data`, `results`, or bare) to results. */
export function mapSearchResults(payload: unknown): MetadataSearchResult[] {
  const container = payload as Record<string, unknown> | undefined;
  const raw = (Array.isArray(payload)
    ? payload
    : (container?.data ?? container?.results ?? container?.games ?? [])) as RawRecord[];
  return (Array.isArray(raw) ? raw : []).map((record) => ({
    id: String(record.id ?? record.name ?? record.title ?? ""),
    title: String(record.name ?? record.title ?? "Unknown"),
    releaseYear: record.releaseYear ?? parseYear(record.released),
    coverUrl: record.cover?.url ?? record.coverUrl,
    bannerUrl: record.bannerUrl,
    iconUrl: record.iconUrl,
    description: record.description ?? record.summary,
    provider: "pcgamingwiki",
  }));
}

function parseYear(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const match = /\d{4}/.exec(value);
  return match ? Number.parseInt(match[0], 10) : undefined;
}

export class PCGamingWikiProvider implements MetadataProvider {
  id = "pcgamingwiki";
  name = "PCGamingWiki";

  constructor(
    private readonly apiKey: string | undefined,
    private readonly fetchFn: HttpFetch,
  ) {}

  async search(query: string): Promise<MetadataSearchResult[]> {
    const url = new URL(`${API_BASE}`);
    url.searchParams.set("search", query);
    const payload = await this.request(url);
    return mapSearchResults(payload);
  }

  async getDetails(id: string): Promise<MetadataDetails | null> {
    const url = new URL(`${API_BASE}/page/${id}`.replace("${id}", id));
    const payload = await this.request(url);
    const results = mapSearchResults(payload);
    return results[0] ? { ...results[0], screenshots: [] } : null;
  }

  private async request(url: URL): Promise<unknown> {
    const headers: Record<string, string> = { Accept: "application/json" };
    if (this.apiKey) headers.Authorization = `Bearer ${this.apiKey}`;
    const response = await this.fetchFn(url.toString(), { headers });
    if (!response.ok) {
      throw new Error(`PCGamingWiki request failed: ${response.status}`);
    }
    return response.json();
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
    const apiKey = process.env[API_KEY_ENV];
    ctx.registerMetadataProvider(
      new PCGamingWikiProvider(apiKey, ctx.fetch.bind(ctx)),
    );
    ctx.logger.info(
      `PCGamingWiki metadata provider registered${apiKey ? "" : " (no API key configured)"}`,
    );
  }
}
