# FindSaunaPlunge MCP server

Model Context Protocol server for [findsaunaplunge.com](https://findsaunaplunge.com): cold plunge, sauna and contrast-therapy venues across 23 US metros (548 venues, August 2026). Every published temperature and price is read from the venue's own pages and carries its source URL, capture date and verbatim quote. **Absent fields mean the venue does not publish that detail — never zero.**

- **Endpoint:** `https://findsaunaplunge.com/mcp` — Streamable HTTP, stateless, no auth, open CORS. `GET` serves human documentation; `POST` is JSON-RPC.
- **Registry:** [`com.findsaunaplunge/findsaunaplunge`](https://registry.modelcontextprotocol.io) (domain-verified).
- **Data:** same records as the CC BY 4.0 feed [`/api/v1/venues.json`](https://findsaunaplunge.com/api/v1/venues.json); archived monthly at [github.com/findsaunaplunge/data](https://github.com/findsaunaplunge/data), DOI [10.5281/zenodo.22132913](https://doi.org/10.5281/zenodo.22132913).

## Tools

| Tool | Arguments | Returns |
| --- | --- | --- |
| `search_venues` | `query?`, `citySlug?`, `modality?`, `access?`, `maxDropInUsd?`, `limit?` | Compact venue records; filters AND-combine. `maxDropInUsd` matches only venues with a **published** drop-in price. |
| `get_venue` | `id` | The full feed record, including per-fact `sources`. |
| `list_cities` | — | Covered cities with venue counts and available modalities. |
| `get_city_stats` | `citySlug` | Counts, published price and temperature ranges, contrast-capable venues. |
| `get_data_freshness` | — | When the feed was built and the newest/oldest `lastVerified`. |

## Connect

```bash
# Claude Code
claude mcp add --transport http findsaunaplunge https://findsaunaplunge.com/mcp

# Any client, by hand
curl -s -X POST https://findsaunaplunge.com/mcp -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"search_venues","arguments":{"citySlug":"austin-tx","modality":"cold_plunge","limit":3}}}'
```

## How it runs

`src/mcp.ts` is the whole server: one `handleMcp(request, env)` function mounted at `/mcp` inside the site's Cloudflare Worker. It has no dependencies. Tool results come from the static `/api/v1/venues.json` asset produced by the site build (fetched through the Worker's `ASSETS` binding and memoized per isolate), so the server can never disagree with the site and a deploy refreshes it automatically. `server.json` is the registry manifest.

This repository is the published source of that server. The site itself is not open source.

## Design rules

- Stateless: no sessions, no server-initiated SSE. Every `POST` is self-contained.
- Unknown arguments are rejected with a message naming the valid ones, rather than silently ignored.
- Nothing here is, or will be, a paid placement.
