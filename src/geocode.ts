import { writeFile, readFile, stat } from "node:fs/promises";

export type GeocodeStatus =
  | "OK"
  | "ZERO_RESULTS"
  | "OVER_QUERY_LIMIT"
  | "OVER_DAILY_LIMIT"
  | "REQUEST_DENIED"
  | "INVALID_REQUEST"
  | "UNKNOWN_ERROR"
  | "ERROR";

export type RecordGeocode = {
  query: string;
  status: GeocodeStatus | string;
  formattedAddress: string | null;
  location: { lat: number; lng: number } | null;
  placeId: string | null;
  locationType: string | null;
  partialMatch: boolean;
  types: string[];
  error?: string;
};

export type GeocodeOptions = {
  apiKey?: string;
  /** Max concurrent requests. Default 5. */
  concurrency?: number;
  /** Queries-per-second cap (0 = no cap). Default 0. */
  qps?: number;
  /** Max attempts per address on transient errors. Default 5. */
  maxRetries?: number;
  /** Initial backoff (ms) for transient retries. Doubles each attempt. Default 1000. */
  retryBaseMs?: number;
  /** Cap on individual backoff sleep (ms). Default 30000. */
  retryMaxMs?: number;
  /** Re-geocode even if cached output exists. Default false. */
  force?: boolean;
  /** USD per 1000 calls. Default 5.0 (verify against current Geocoding API pricing). */
  pricePer1000Calls?: number;
  /**
   * Path to write a GeoJSON FeatureCollection alongside the JSON output.
   * Defaults to `outPath` with `.json` swapped for `.geojson`. Set null to skip.
   */
  geoJsonPath?: string | null;
};

export type GeocodeResult = {
  meta: {
    totalRecords: number;
    uniqueQueries: number;
    apiCalls: number;
    retries: number;
    cacheHits: number;
    skipped: number;
    costUsd: number;
    geocodedAt: string;
  };
  records: Array<Record<string, unknown> & { geocode: RecordGeocode | null }>;
};

export type GeoJSONFeature = {
  type: "Feature";
  geometry: { type: "Point"; coordinates: [number, number] };
  properties: Record<string, unknown>;
};

export type GeoJSONFeatureCollection = {
  type: "FeatureCollection";
  features: GeoJSONFeature[];
};

/**
 * Convert a GeocodeResult into a GeoJSON FeatureCollection.
 * Records without a resolved location are omitted.
 * Properties carry the original record fields (minus the nested geocode object)
 * plus flat geocode metadata: formattedAddress, placeId, locationType,
 * partialMatch, geocodeStatus.
 */
export function toGeoJSON(geocodeResult: GeocodeResult): GeoJSONFeatureCollection {
  const features: GeoJSONFeature[] = [];
  for (const rec of geocodeResult.records) {
    const g = rec.geocode;
    if (!g || !g.location) continue;
    const { geocode: _stripped, ...rest } = rec as { geocode: RecordGeocode | null } & Record<string, unknown>;
    void _stripped;
    features.push({
      type: "Feature",
      geometry: {
        type: "Point",
        // GeoJSON coordinate order is [longitude, latitude] - intentional.
        coordinates: [g.location.lng, g.location.lat],
      },
      properties: {
        ...rest,
        formattedAddress: g.formattedAddress,
        placeId: g.placeId,
        locationType: g.locationType,
        partialMatch: g.partialMatch,
        geocodeStatus: g.status,
      },
    });
  }
  return { type: "FeatureCollection", features };
}

const TRANSIENT_GEOCODE_STATUSES = new Set(["OVER_QUERY_LIMIT", "UNKNOWN_ERROR"]);

function isTransientResult(r: RecordGeocode): boolean {
  if (r.status === "OK") return false;
  if (TRANSIENT_GEOCODE_STATUSES.has(r.status)) return true;
  if (r.status === "ERROR") {
    const e = r.error ?? "";
    if (/HTTP\s+(408|429|5\d{2})/i.test(e)) return true;
    if (/ECONN|ETIMEDOUT|fetch failed|socket hang up|ENETUNREACH|UND_ERR/i.test(e)) return true;
  }
  return false;
}

/**
 * Promise-chain rate limiter. Each acquire() resolves no sooner than
 * 1000/qps ms after the previous acquire(), even with parallel callers.
 */
function makeRateLimiter(qps: number): () => Promise<void> {
  if (!qps || qps <= 0) return async () => {};
  const minIntervalMs = 1000 / qps;
  let chain: Promise<void> = Promise.resolve();
  let nextSlot = 0;
  return () => {
    const acquired = chain.then(async () => {
      const now = Date.now();
      const wait = Math.max(0, nextSlot - now);
      nextSlot = Math.max(now, nextSlot) + minIntervalMs;
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    });
    chain = acquired.catch(() => undefined);
    return acquired;
  };
}

function pickAddress(rec: Record<string, unknown>): string | null {
  const v = (rec as { verification?: { matchedAddress?: unknown } }).verification?.matchedAddress;
  if (typeof v === "string" && v.trim()) return v.trim();
  const addr = (rec as { address?: unknown }).address;
  if (typeof addr === "string" && addr.trim()) return addr.trim();
  const full = (rec as { fullAddress?: unknown }).fullAddress;
  if (typeof full === "string" && full.trim()) return full.trim();
  return null;
}

type GoogleGeocodeResponse = {
  status: string;
  error_message?: string;
  results?: Array<{
    formatted_address?: string;
    place_id?: string;
    types?: string[];
    partial_match?: boolean;
    geometry?: {
      location?: { lat: number; lng: number };
      location_type?: string;
    };
  }>;
};

async function geocodeOne(address: string, apiKey: string): Promise<RecordGeocode> {
  const url = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(address)}&key=${apiKey}`;
  try {
    const res = await fetch(url);
    if (!res.ok) {
      return {
        query: address,
        status: "ERROR",
        formattedAddress: null,
        location: null,
        placeId: null,
        locationType: null,
        partialMatch: false,
        types: [],
        error: `HTTP ${res.status}`,
      };
    }
    const json = (await res.json()) as GoogleGeocodeResponse;
    if (json.status !== "OK") {
      return {
        query: address,
        status: json.status,
        formattedAddress: null,
        location: null,
        placeId: null,
        locationType: null,
        partialMatch: false,
        types: [],
        error: json.error_message,
      };
    }
    const first = json.results?.[0];
    if (!first) {
      return {
        query: address,
        status: "ZERO_RESULTS",
        formattedAddress: null,
        location: null,
        placeId: null,
        locationType: null,
        partialMatch: false,
        types: [],
      };
    }
    return {
      query: address,
      status: "OK",
      formattedAddress: first.formatted_address ?? null,
      location: first.geometry?.location ?? null,
      placeId: first.place_id ?? null,
      locationType: first.geometry?.location_type ?? null,
      partialMatch: !!first.partial_match,
      types: Array.isArray(first.types) ? first.types : [],
    };
  } catch (err) {
    return {
      query: address,
      status: "ERROR",
      formattedAddress: null,
      location: null,
      placeId: null,
      locationType: null,
      partialMatch: false,
      types: [],
      error: (err as Error).message,
    };
  }
}

export async function geocodeRecords(
  records: Array<Record<string, unknown>>,
  outPath: string,
  opts: GeocodeOptions = {},
): Promise<GeocodeResult> {
  const apiKey =
    opts.apiKey ??
    process.env.GOOGLE_GEOCODING_API_KEY ??
    process.env.GOOGLE_MAPS_API_KEY;
  if (!apiKey) {
    throw new Error(
      "Google Geocoding API key not set. Pass { apiKey } or set GOOGLE_GEOCODING_API_KEY (or GOOGLE_MAPS_API_KEY).",
    );
  }
  const concurrency = Math.max(1, opts.concurrency ?? 5);
  const force = opts.force ?? false;
  const pricePer1000Calls = opts.pricePer1000Calls ?? 5.0;
  const qps = opts.qps ?? 0;
  const maxRetries = Math.max(1, opts.maxRetries ?? 5);
  const retryBaseMs = opts.retryBaseMs ?? 1000;
  const retryMaxMs = opts.retryMaxMs ?? 30_000;
  const acquire = makeRateLimiter(qps);

  if (!force) {
    try {
      const s = await stat(outPath);
      if (s.size > 0) {
        console.log(`[geocode] Using cached result at ${outPath}`);
        return JSON.parse(await readFile(outPath, "utf8")) as GeocodeResult;
      }
    } catch {}
  }

  // Build a dedup'd queue of unique queries.
  const queries: string[] = [];
  const inQueue = new Set<string>();
  let skipped = 0;
  for (const rec of records) {
    const q = pickAddress(rec);
    if (!q) {
      skipped++;
      continue;
    }
    if (!inQueue.has(q)) {
      inQueue.add(q);
      queries.push(q);
    }
  }

  console.log(
    `[geocode] ${records.length} record(s); ${queries.length} unique address(es); ${skipped} skipped; concurrency=${concurrency}${qps > 0 ? `, qps=${qps}` : ""}, maxRetries=${maxRetries}.`,
  );

  const cache = new Map<string, RecordGeocode>();
  let apiCalls = 0;
  let retries = 0;
  let next = 0;

  async function geocodeWithRetry(q: string): Promise<RecordGeocode> {
    let last: RecordGeocode | null = null;
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      await acquire();
      apiCalls++;
      const result = await geocodeOne(q, apiKey!);
      if (!isTransientResult(result)) return result;
      last = result;
      if (attempt >= maxRetries) break;
      retries++;
      const delay =
        Math.min(retryMaxMs, retryBaseMs * 2 ** (attempt - 1)) +
        Math.random() * (retryBaseMs / 2);
      console.log(
        `[geocode]   transient (${result.status}${result.error ? `: ${result.error}` : ""}) for "${q.slice(0, 60)}"; retry ${attempt + 1}/${maxRetries} in ${Math.round(delay)}ms`,
      );
      await new Promise((r) => setTimeout(r, delay));
    }
    return last!;
  }

  async function worker(): Promise<void> {
    while (true) {
      const i = next++;
      if (i >= queries.length) return;
      const q = queries[i]!;
      const result = await geocodeWithRetry(q);
      cache.set(q, result);
      if (cache.size === queries.length || cache.size % 10 === 0) {
        console.log(`[geocode]   ${cache.size}/${queries.length} done`);
      }
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(concurrency, queries.length) }, () => worker()),
  );

  // Stitch geocodes back onto every record (including duplicates of the same address).
  let cacheHits = 0;
  const out: Array<Record<string, unknown> & { geocode: RecordGeocode | null }> = [];
  const seen = new Set<string>();
  for (const rec of records) {
    const q = pickAddress(rec);
    if (!q) {
      out.push({ ...rec, geocode: null });
      continue;
    }
    if (seen.has(q)) cacheHits++;
    else seen.add(q);
    out.push({ ...rec, geocode: cache.get(q) ?? null });
  }

  const costUsd = (apiCalls / 1000) * pricePer1000Calls;
  const result: GeocodeResult = {
    meta: {
      totalRecords: records.length,
      uniqueQueries: queries.length,
      apiCalls,
      retries,
      cacheHits,
      skipped,
      costUsd,
      geocodedAt: new Date().toISOString(),
    },
    records: out,
  };
  await writeFile(outPath, JSON.stringify(result, null, 2));
  console.log(
    `[geocode] Done. calls=${apiCalls} (retries=${retries}) cacheHits=${cacheHits} skipped=${skipped} cost=$${costUsd.toFixed(4)}`,
  );

  // Companion GeoJSON, unless explicitly disabled.
  if (opts.geoJsonPath !== null) {
    const geoJsonPath =
      opts.geoJsonPath ?? outPath.replace(/\.json$/i, ".geojson");
    if (geoJsonPath === outPath) {
      console.warn(
        `[geocode] geoJsonPath equals outPath; skipping GeoJSON write to avoid overwrite.`,
      );
    } else {
      const fc = toGeoJSON(result);
      await writeFile(geoJsonPath, JSON.stringify(fc, null, 2));
      const dropped = result.records.length - fc.features.length;
      console.log(
        `[geocode] Wrote ${geoJsonPath}: ${fc.features.length} feature(s)${dropped > 0 ? ` (${dropped} record(s) without location omitted)` : ""}.`,
      );
    }
  }

  return result;
}

/** Convenience: load a verified or final JSON file, geocode its records. */
export async function geocodeFromFile(
  jsonPath: string,
  outPath: string,
  opts: GeocodeOptions = {},
): Promise<GeocodeResult> {
  const parsed = JSON.parse(await readFile(jsonPath, "utf8")) as unknown;
  const records: Array<Record<string, unknown>> = Array.isArray(parsed)
    ? (parsed as Array<Record<string, unknown>>)
    : ((parsed as { records?: Array<Record<string, unknown>> }).records ?? []);
  if (!records.length) {
    console.warn(`[geocode] No records found in ${jsonPath}`);
  }
  return geocodeRecords(records, outPath, opts);
}
