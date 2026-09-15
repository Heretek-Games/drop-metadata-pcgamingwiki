# PCGamingWiki

PCGamingWiki metadata and fix-list provider plugin for Drop (#310).

## Build

```sh
pnpm install
pnpm build
pnpm test
pnpm typecheck
```

## Configuration

Since 2026-08-23 PCGamingWiki requires a **bot-password session** for
`action=cargoquery`. Set the bot credentials to enable searches:

| Environment variable | Value |
| :--- | :--- |
| `PCGAMINGWIKI_BOT_USERNAME` | Bot username in `User@BotName` form |
| `PCGAMINGWIKI_BOT_PASSWORD` | The bot password from Special:BotPasswords |
| `PCG_USER_AGENT` | Optional User-Agent override; defaults to the repo URL advertised by the plugin |

The wiki rejects generic or absent User-Agent strings, so every request sends
`drop-metadata-pcgamingwiki/<version> (+<repo URL>)` unless `PCG_USER_AGENT`
overrides it.

Without credentials the provider still registers, but `search`/`getDetails`
cargo queries will be rejected by the wiki. The provider logs in lazily (token
request, then `action=login`) and keeps the session cookie for subsequent
calls.

The Cargo table was renamed `Infobox_game` → `Game` on 2026-08-25; queries use
`tables=Game`.
