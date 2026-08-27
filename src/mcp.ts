/**
 * MCP server — Model Context Protocol over Streamable HTTP.
 *
 * Lives at POST https://findsaunaplunge.com/mcp and exposes the venue
 * registry to AI assistants as callable tools (search_venues, get_venue,
 * list_cities, get_city_stats, get_data_freshness) rather than as pages to
 * scrape.
 *
 * Design decisions:
 *  - **Stateless.** No sessions, no server-initiated streams. Every request
 *    is a self-contained JSON-RPC message; GET returns documentation for
 *    humans and 405 for SSE clients. This is explicitly allowed by the
 *    Streamable HTTP transport spec and is the right shape for a read-only
 *    public data server on an edge worker.
 *  - **One source of truth.** Data comes from the static /api/v1/venues.json
 *    asset produced by the build, fetched through the ASSETS binding. The MCP
 *    server is structurally incapable of disagreeing with the site.
 *  - **Open CORS.** The data is public by design; browser-based MCP clients
 *    are welcome.
 */

interface AssetsBinding {
  fetch(request: Request): Promise<Response>;
}

export interface McpEnv {
  ASSETS: AssetsBinding;
}

const SERVER_INFO = {
  name: 'findsaunaplunge',
  title: 'FindSaunaPlunge — US cold plunge & sauna studios, checked and dated',
  version: '1.0.0',
};

/** Protocol revisions we know; echo the client's if recognised. */
const KNOWN_PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];
const DEFAULT_PROTOCOL_VERSION = '2025-06-18';

const INSTRUCTIONS = `FindSaunaPlunge lists cold plunge, sauna, and contrast-therapy studios in the United States, with details read from each studio's own published pages and the date they were checked.

Data rules you can rely on:
- Every venue carries lastVerified — the date its details were last checked — and a status: "verified" means every published fact was cross-checked against multiple current public sources in agreement (the studio's own site plus its live booking pages or other public channels); "community"/"brand_import" mean checked against the studio's own published details. Nobody contacts studios; every check is against published pages. Surface both fields when citing a fact.
- An absent field means "not published / unknown", never zero. We do not guess temperatures or prices.
- Venue ids are stable and never reassigned.

Use search_venues for discovery, get_venue for one venue's full record, list_cities to see coverage, get_city_stats for per-city aggregates (medians always carry their denominator), and get_data_freshness for check-date coverage. Corrections: submit@findsaunaplunge.com.`;

/* ------------------------------------------------------------------ *
 * Feed access (memoized per isolate; a deploy recycles isolates)
 * ------------------------------------------------------------------ */

interface FeedVenue {
  id: string;
  name: string;
  url: string;
  status: string;
  lastVerified: string;
  brand?: string;
  address: { street: string; city: string; state: string; zip: string; country: string };
  city?: { slug: string; name: string; state: string; stateSlug: string; url: string };
  geo: { lat: number; lng: number };
  modalities: Array<{ value: string; label: string }>;
  access: string;
  temps?: { plungeF?: [number, number]; saunaF?: [number, number] };
  pricing?: { dropIn?: number; dayPass?: number; membershipMo?: number; note?: string };
  hours?: string;
  website?: string;
  bookingUrl?: string;
  phone?: string;
  featured: boolean;
  summary: string;
}

interface Feed {
  generatedAt: string;
  counts: { venues: number; cities: number; states: number };
  venues: FeedVenue[];
}

let feedPromise: Promise<Feed> | null = null;

function loadFeed(env: McpEnv, requestUrl: string): Promise<Feed> {
  if (!feedPromise) {
    feedPromise = env.ASSETS.fetch(
      new Request(new URL('/api/v1/venues.json', requestUrl).toString()),
    ).then(async (response) => {
      if (!response.ok) {
        feedPromise = null;
        throw new Error(`venue feed unavailable (${response.status})`);
      }
      return (await response.json()) as Feed;
    }).catch((error) => {
      feedPromise = null;
      throw error;
    });
  }
  return feedPromise;
}

/* ------------------------------------------------------------------ *
 * Tools
 * ------------------------------------------------------------------ */

const MODALITY_VALUES = [
  'cold_plunge',
  'traditional_sauna',
  'infrared_sauna',
  'steam_room',
  'cryotherapy',
  'red_light',
  'pemf',
  'compression',
  'float',
];

const TOOLS = [
  {
    name: 'search_venues',
    title: 'Search venues',
    description:
      'Search cold plunge / sauna venues. All filters are optional and AND-combined. Absent fields in results mean "not published", never zero.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Substring match on venue name (case-insensitive).' },
        citySlug: { type: 'string', description: 'City slug, e.g. "dallas-tx". Use list_cities to discover.' },
        modality: { type: 'string', enum: MODALITY_VALUES, description: 'Venue must offer this modality.' },
        access: {
          type: 'string',
          enum: ['private_suite', 'communal', 'mixed'],
          description:
            'private_suite = your own room; communal = shared areas; mixed matches either request. Venues that do not publish their access model are excluded whenever this filter is used — absence of the fact is not a match.',
        },
        maxDropInUsd: {
          type: 'number',
          description: 'Only venues with a PUBLISHED drop-in price at or below this. Excludes venues with no published price.',
        },
        limit: { type: 'number', description: 'Max results, default 10, cap 25.' },
      },
    },
  },
  {
    name: 'get_venue',
    title: 'Get one venue',
    description: 'Fetch the full record for one venue by its stable id.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'Venue id, e.g. "alive-and-well-dallas-tx".' } },
      required: ['id'],
    },
  },
  {
    name: 'list_cities',
    title: 'List covered cities',
    description: 'Cities with live venues, with counts and available modalities.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'get_city_stats',
    title: 'Get city statistics',
    description:
      'Aggregate figures for one covered city: venue count, modality and access breakdowns, contrast-capable count, and median published prices and plunge temperature. Every median carries its denominator (n) — absent fields are excluded, never treated as zero.',
    inputSchema: {
      type: 'object',
      properties: {
        citySlug: { type: 'string', description: 'City slug, e.g. "dallas-tx". Use list_cities to discover.' },
      },
      required: ['citySlug'],
    },
  },
  {
    name: 'get_data_freshness',
    title: 'Get dataset freshness',
    description:
      'When the dataset was generated and how recently venues were checked: oldest and newest lastVerified dates, counts by age bucket, and the newest check date per city.',
    inputSchema: { type: 'object', properties: {} },
  },
];

function compactVenue(venue: FeedVenue) {
  return {
    id: venue.id,
    name: venue.name,
    url: venue.url,
    city: venue.city?.slug,
    address: `${venue.address.street}, ${venue.address.city}, ${venue.address.state} ${venue.address.zip}`,
    modalities: venue.modalities.map((m) => m.value),
    access: venue.access,
    ...(venue.temps ? { temps: venue.temps } : {}),
    ...(venue.pricing ? { pricing: venue.pricing } : {}),
    lastVerified: venue.lastVerified,
    status: venue.status,
    summary: venue.summary,
  };
}

function runTool(name: string, args: Record<string, unknown>, feed: Feed): unknown {
  switch (name) {
    case 'search_venues': {
      /*
       * Reject unknown argument keys instead of ignoring them.
       *
       * Found live: a client calling with `{"city": "phoenix-az"}` — a
       * perfectly reasonable guess at the parameter name — got every venue in
       * the registry back, because the misnamed filter was silently dropped.
       * For a human that is a confusing result; for an AI client it is a
       * factual error factory, because the model has no idea its filter never
       * applied and will happily present Austin studios as the answer to a
       * Phoenix question. A named error makes the client self-correct on the
       * next call.
       */
      const VALID_KEYS = ['query', 'citySlug', 'modality', 'access', 'maxDropInUsd', 'limit'];
      const unknown = Object.keys(args).filter((k) => !VALID_KEYS.includes(k));
      if (unknown.length > 0) {
        return {
          error: `Unknown argument(s): ${unknown.join(', ')}. Valid arguments are: ${VALID_KEYS.join(', ')}. Did you mean "citySlug"? Use list_cities to discover slugs.`,
        };
      }

      const query = typeof args.query === 'string' ? args.query.toLowerCase() : null;
      const citySlug = typeof args.citySlug === 'string' ? args.citySlug : null;
      const modality = typeof args.modality === 'string' ? args.modality : null;
      const access = typeof args.access === 'string' ? args.access : null;
      const maxDropIn = typeof args.maxDropInUsd === 'number' ? args.maxDropInUsd : null;
      const limit = Math.min(Math.max(Number(args.limit) || 10, 1), 25);

      const matches = feed.venues.filter((venue) => {
        if (query && !venue.name.toLowerCase().includes(query)) return false;
        if (citySlug && venue.city?.slug !== citySlug) return false;
        if (modality && !venue.modalities.some((m) => m.value === modality)) return false;
        if (access && venue.access !== access && venue.access !== 'mixed') return false;
        if (maxDropIn !== null) {
          const dropIn = venue.pricing?.dropIn;
          if (typeof dropIn !== 'number' || dropIn > maxDropIn) return false;
        }
        return true;
      });

      return {
        total: matches.length,
        returned: Math.min(matches.length, limit),
        note: 'Absent fields mean the venue does not publish that detail. Cite lastVerified when quoting facts.',
        venues: matches.slice(0, limit).map(compactVenue),
      };
    }

    case 'get_venue': {
      const id = typeof args.id === 'string' ? args.id : '';
      const venue = feed.venues.find((v) => v.id === id);
      if (!venue) {
        return {
          found: false,
          error: `No venue with id "${id}". Ids are stable slugs — use search_venues to find one.`,
        };
      }
      return { found: true, venue };
    }

    case 'list_cities': {
      const byCity = new Map<string, { city: NonNullable<FeedVenue['city']>; venues: FeedVenue[] }>();
      for (const venue of feed.venues) {
        if (!venue.city) continue;
        const entry = byCity.get(venue.city.slug);
        if (entry) entry.venues.push(venue);
        else byCity.set(venue.city.slug, { city: venue.city, venues: [venue] });
      }
      return {
        generatedAt: feed.generatedAt,
        cities: [...byCity.values()]
          .sort((a, b) => b.venues.length - a.venues.length)
          .map(({ city, venues }) => ({
            slug: city.slug,
            name: city.name,
            state: city.state,
            url: city.url,
            venueCount: venues.length,
            modalities: [...new Set(venues.flatMap((v) => v.modalities.map((m) => m.value)))],
          })),
      };
    }

    case 'get_city_stats': {
      const citySlug = typeof args.citySlug === 'string' ? args.citySlug : '';
      const venues = feed.venues.filter((v) => v.city?.slug === citySlug);
      if (venues.length === 0) {
        return {
          found: false,
          error: `No venues for city slug "${citySlug}". Use list_cities to see coverage.`,
        };
      }
      const median = (nums: number[]): number | undefined => {
        if (nums.length === 0) return undefined;
        const sorted = [...nums].sort((a, b) => a - b);
        const mid = Math.floor(sorted.length / 2);
        return sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
      };
      const heat = new Set(['traditional_sauna', 'infrared_sauna', 'steam_room']);
      const singleVisit = venues
        .map((v) => v.pricing?.dropIn ?? v.pricing?.dayPass)
        .filter((n): n is number => typeof n === 'number');
      const memberships = venues
        .map((v) => v.pricing?.membershipMo)
        .filter((n): n is number => typeof n === 'number');
      const plungeFloors = venues
        .map((v) => v.temps?.plungeF?.[0])
        .filter((n): n is number => typeof n === 'number');
      const modalities: Record<string, number> = {};
      const access: Record<string, number> = {};
      for (const v of venues) {
        for (const m of v.modalities) modalities[m.value] = (modalities[m.value] ?? 0) + 1;
        access[v.access] = (access[v.access] ?? 0) + 1;
      }
      const dates = venues.map((v) => v.lastVerified).sort();
      return {
        found: true,
        city: venues[0].city,
        venueCount: venues.length,
        modalities,
        access,
        contrastCapable: venues.filter(
          (v) =>
            v.modalities.some((m) => m.value === 'cold_plunge') &&
            v.modalities.some((m) => heat.has(m.value)),
        ).length,
        // Medians are only over venues that PUBLISH the figure; n says how many.
        medianSingleVisitUsd:
          singleVisit.length > 0 ? { value: median(singleVisit), n: singleVisit.length } : null,
        medianMembershipUsdPerMonth:
          memberships.length > 0 ? { value: median(memberships), n: memberships.length } : null,
        medianPlungeFloorF:
          plungeFloors.length > 0 ? { value: median(plungeFloors), n: plungeFloors.length } : null,
        lastVerifiedRange: { oldest: dates[0], newest: dates[dates.length - 1] },
        note: 'Absent fields mean "not published", never zero. Medians exclude venues that publish nothing.',
      };
    }

    case 'get_data_freshness': {
      const dates = feed.venues.map((v) => v.lastVerified).sort();
      const now = Date.parse(feed.generatedAt);
      const ageDays = (iso: string) => Math.floor((now - Date.parse(iso)) / 86_400_000);
      const buckets = { within30Days: 0, within60Days: 0, within90Days: 0, older: 0 };
      for (const v of feed.venues) {
        const age = ageDays(v.lastVerified);
        if (age <= 30) buckets.within30Days++;
        else if (age <= 60) buckets.within60Days++;
        else if (age <= 90) buckets.within90Days++;
        else buckets.older++;
      }
      const newestByCity: Record<string, string> = {};
      for (const v of feed.venues) {
        if (!v.city) continue;
        const prev = newestByCity[v.city.slug];
        if (!prev || v.lastVerified > prev) newestByCity[v.city.slug] = v.lastVerified;
      }
      return {
        generatedAt: feed.generatedAt,
        venueCount: feed.venues.length,
        oldestVerified: dates[0],
        newestVerified: dates[dates.length - 1],
        checkedWithin: buckets,
        newestCheckByCity: newestByCity,
        note: 'lastVerified is the date a person or supervised agent last read the venue’s own pages. It is never advanced automatically.',
      };
    }

    default:
      throw new JsonRpcError(-32602, `Unknown tool: ${name}`);
  }
}

/* ------------------------------------------------------------------ *
 * JSON-RPC plumbing
 * ------------------------------------------------------------------ */

class JsonRpcError extends Error {
  constructor(
    public code: number,
    message: string,
  ) {
    super(message);
  }
}

interface JsonRpcMessage {
  jsonrpc?: string;
  id?: number | string | null;
  method?: string;
  params?: Record<string, unknown>;
}

async function handleMessage(
  message: JsonRpcMessage,
  env: McpEnv,
  requestUrl: string,
): Promise<Record<string, unknown> | null> {
  const { id, method, params = {} } = message;
  const isNotification = id === undefined || id === null;

  const respond = (result: unknown) =>
    isNotification ? null : { jsonrpc: '2.0', id, result };
  const respondError = (code: number, msg: string) =>
    isNotification ? null : { jsonrpc: '2.0', id, error: { code, message: msg } };

  try {
    switch (method) {
      case 'initialize': {
        const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
        const protocolVersion = KNOWN_PROTOCOL_VERSIONS.includes(requested)
          ? requested
          : DEFAULT_PROTOCOL_VERSION;
        return respond({
          protocolVersion,
          capabilities: { tools: { listChanged: false } },
          serverInfo: SERVER_INFO,
          instructions: INSTRUCTIONS,
        });
      }

      case 'ping':
        return respond({});

      case 'tools/list':
        return respond({ tools: TOOLS });

      case 'tools/call': {
        const name = typeof params.name === 'string' ? params.name : '';
        const args = (params.arguments ?? {}) as Record<string, unknown>;
        const feed = await loadFeed(env, requestUrl);
        const result = runTool(name, args, feed);
        return respond({
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
          structuredContent: result as Record<string, unknown>,
          isError: false,
        });
      }

      // Notifications we accept silently.
      case 'notifications/initialized':
      case 'notifications/cancelled':
        return null;

      default:
        return respondError(-32601, `Method not found: ${method}`);
    }
  } catch (error) {
    if (error instanceof JsonRpcError) return respondError(error.code, error.message);
    return respondError(-32603, `Internal error: ${(error as Error).message}`);
  }
}

/* ------------------------------------------------------------------ *
 * HTTP transport
 * ------------------------------------------------------------------ */

const CORS_HEADERS: Record<string, string> = {
  // This endpoint is for MCP clients; the documentation page it serves to a
  // browser is a convenience, not a page to rank. Without this it was being
  // served as indexable HTML on every host variant with no canonical at all.
  'x-robots-tag': 'noindex',
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'POST, GET, OPTIONS',
  'access-control-allow-headers':
    'Content-Type, Accept, Authorization, Mcp-Session-Id, MCP-Protocol-Version, Last-Event-ID',
  'access-control-expose-headers': 'MCP-Protocol-Version',
  'access-control-max-age': '86400',
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...CORS_HEADERS },
  });
}

/** Human-readable documentation served to browsers that GET /mcp. */
const DOC_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<link rel="canonical" href="https://findsaunaplunge.com/api/">
<title>MCP server — FindSaunaPlunge</title>
<style>
  body{font-family:ui-sans-serif,system-ui,sans-serif;max-width:42rem;margin:3rem auto;padding:0 1rem;line-height:1.6;color:#232323;background:#fdfcfa}
  code,pre{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;background:#f1efec;border-radius:6px}
  code{padding:.1rem .35rem}pre{padding:1rem;overflow-x:auto}
  h1{letter-spacing:-.02em}a{color:#b45a1d}
  @media(prefers-color-scheme:dark){body{background:#161d26;color:#cfd8e0}code,pre{background:#212a35}a{color:#e8955c}}
</style></head><body>
<h1>FindSaunaPlunge MCP server</h1>
<p>This endpoint speaks the <strong>Model Context Protocol</strong> (Streamable HTTP transport).
Point an MCP client at:</p>
<pre>https://findsaunaplunge.com/mcp</pre>
<p>Tools: <code>search_venues</code>, <code>get_venue</code>, <code>list_cities</code>,
<code>get_city_stats</code>, <code>get_data_freshness</code>. Documentation for humans is on
<a href="/api/">the API page</a>.
Every venue record carries <code>lastVerified</code> — the date its details were last checked —
and a <code>status</code> stating how. Absent fields mean "not published", never zero.</p>
<p>Prefer plain JSON? The same data is at <a href="/api/v1/venues.json">/api/v1/venues.json</a>,
and <a href="/llms.txt">/llms.txt</a> describes the site.</p>
<p>Example call:</p>
<pre>curl -X POST https://findsaunaplunge.com/mcp \\
  -H 'Content-Type: application/json' \\
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call",
       "params":{"name":"search_venues","arguments":{"citySlug":"dallas-tx"}}}'</pre>
<p>Corrections and listings: <a href="mailto:submit@findsaunaplunge.com">submit@findsaunaplunge.com</a></p>
</body></html>`;

export async function handleMcp(request: Request, env: McpEnv): Promise<Response> {
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  if (request.method === 'GET') {
    const accept = request.headers.get('accept') ?? '';
    if (accept.includes('text/html')) {
      return new Response(DOC_HTML, {
        headers: { 'content-type': 'text/html; charset=utf-8', ...CORS_HEADERS },
      });
    }
    // No server-initiated SSE stream — the spec allows a stateless server to
    // decline with 405.
    return new Response(null, { status: 405, headers: { allow: 'POST, OPTIONS', ...CORS_HEADERS } });
  }

  if (request.method !== 'POST') {
    return new Response(null, { status: 405, headers: { allow: 'POST, GET, OPTIONS', ...CORS_HEADERS } });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }, 400);
  }

  const url = request.url;

  // Batch support (protocol revisions <= 2025-03-26).
  if (Array.isArray(body)) {
    const responses = (
      await Promise.all(body.map((m) => handleMessage(m as JsonRpcMessage, env, url)))
    ).filter((r): r is Record<string, unknown> => r !== null);
    if (responses.length === 0) return new Response(null, { status: 202, headers: CORS_HEADERS });
    return json(responses);
  }

  const response = await handleMessage(body as JsonRpcMessage, env, url);
  if (response === null) return new Response(null, { status: 202, headers: CORS_HEADERS });
  return json(response);
}
