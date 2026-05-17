import { writeFile, readFile, stat } from "node:fs/promises";
/**
 * Convert a GeocodeResult into a GeoJSON FeatureCollection.
 * Records without a resolved location are omitted.
 * Properties carry the original record fields (minus the nested geocode object)
 * plus flat geocode metadata: formattedAddress, placeId, locationType,
 * partialMatch, geocodeStatus.
 */
export function toGeoJSON(geocodeResult) {
    const features = [];
    for (const rec of geocodeResult.records) {
        const g = rec.geocode;
        if (!g || !g.location)
            continue;
        const { geocode: _stripped, ...rest } = rec;
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
function isTransientResult(r) {
    if (r.status === "OK")
        return false;
    if (TRANSIENT_GEOCODE_STATUSES.has(r.status))
        return true;
    if (r.status === "ERROR") {
        const e = r.error ?? "";
        if (/HTTP\s+(408|429|5\d{2})/i.test(e))
            return true;
        if (/ECONN|ETIMEDOUT|fetch failed|socket hang up|ENETUNREACH|UND_ERR/i.test(e))
            return true;
    }
    return false;
}
/**
 * Promise-chain rate limiter. Each acquire() resolves no sooner than
 * 1000/qps ms after the previous acquire(), even with parallel callers.
 */
function makeRateLimiter(qps) {
    if (!qps || qps <= 0)
        return async () => { };
    const minIntervalMs = 1000 / qps;
    let chain = Promise.resolve();
    let nextSlot = 0;
    return () => {
        const acquired = chain.then(async () => {
            const now = Date.now();
            const wait = Math.max(0, nextSlot - now);
            nextSlot = Math.max(now, nextSlot) + minIntervalMs;
            if (wait > 0)
                await new Promise((r) => setTimeout(r, wait));
        });
        chain = acquired.catch(() => undefined);
        return acquired;
    };
}
function pickAddress(rec) {
    const v = rec.verification?.matchedAddress;
    if (typeof v === "string" && v.trim())
        return v.trim();
    const addr = rec.address;
    if (typeof addr === "string" && addr.trim())
        return addr.trim();
    const full = rec.fullAddress;
    if (typeof full === "string" && full.trim())
        return full.trim();
    return null;
}
async function geocodeOne(address, apiKey) {
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
        const json = (await res.json());
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
    }
    catch (err) {
        return {
            query: address,
            status: "ERROR",
            formattedAddress: null,
            location: null,
            placeId: null,
            locationType: null,
            partialMatch: false,
            types: [],
            error: err.message,
        };
    }
}
export async function geocodeRecords(records, outPath, opts = {}) {
    const apiKey = opts.apiKey ??
        process.env.GOOGLE_GEOCODING_API_KEY ??
        process.env.GOOGLE_MAPS_API_KEY;
    if (!apiKey) {
        throw new Error("Google Geocoding API key not set. Pass { apiKey } or set GOOGLE_GEOCODING_API_KEY (or GOOGLE_MAPS_API_KEY).");
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
                return JSON.parse(await readFile(outPath, "utf8"));
            }
        }
        catch { }
    }
    // Build a dedup'd queue of unique queries.
    const queries = [];
    const inQueue = new Set();
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
    console.log(`[geocode] ${records.length} record(s); ${queries.length} unique address(es); ${skipped} skipped; concurrency=${concurrency}${qps > 0 ? `, qps=${qps}` : ""}, maxRetries=${maxRetries}.`);
    const cache = new Map();
    let apiCalls = 0;
    let retries = 0;
    let next = 0;
    async function geocodeWithRetry(q) {
        let last = null;
        for (let attempt = 1; attempt <= maxRetries; attempt++) {
            await acquire();
            apiCalls++;
            const result = await geocodeOne(q, apiKey);
            if (!isTransientResult(result))
                return result;
            last = result;
            if (attempt >= maxRetries)
                break;
            retries++;
            const delay = Math.min(retryMaxMs, retryBaseMs * 2 ** (attempt - 1)) +
                Math.random() * (retryBaseMs / 2);
            console.log(`[geocode]   transient (${result.status}${result.error ? `: ${result.error}` : ""}) for "${q.slice(0, 60)}"; retry ${attempt + 1}/${maxRetries} in ${Math.round(delay)}ms`);
            await new Promise((r) => setTimeout(r, delay));
        }
        return last;
    }
    async function worker() {
        while (true) {
            const i = next++;
            if (i >= queries.length)
                return;
            const q = queries[i];
            const result = await geocodeWithRetry(q);
            cache.set(q, result);
            if (cache.size === queries.length || cache.size % 10 === 0) {
                console.log(`[geocode]   ${cache.size}/${queries.length} done`);
            }
        }
    }
    await Promise.all(Array.from({ length: Math.min(concurrency, queries.length) }, () => worker()));
    // Stitch geocodes back onto every record (including duplicates of the same address).
    let cacheHits = 0;
    const out = [];
    const seen = new Set();
    for (const rec of records) {
        const q = pickAddress(rec);
        if (!q) {
            out.push({ ...rec, geocode: null });
            continue;
        }
        if (seen.has(q))
            cacheHits++;
        else
            seen.add(q);
        out.push({ ...rec, geocode: cache.get(q) ?? null });
    }
    const costUsd = (apiCalls / 1000) * pricePer1000Calls;
    const result = {
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
    console.log(`[geocode] Done. calls=${apiCalls} (retries=${retries}) cacheHits=${cacheHits} skipped=${skipped} cost=$${costUsd.toFixed(4)}`);
    // Companion GeoJSON, unless explicitly disabled.
    if (opts.geoJsonPath !== null) {
        const geoJsonPath = opts.geoJsonPath ?? outPath.replace(/\.json$/i, ".geojson");
        if (geoJsonPath === outPath) {
            console.warn(`[geocode] geoJsonPath equals outPath; skipping GeoJSON write to avoid overwrite.`);
        }
        else {
            const fc = toGeoJSON(result);
            await writeFile(geoJsonPath, JSON.stringify(fc, null, 2));
            const dropped = result.records.length - fc.features.length;
            console.log(`[geocode] Wrote ${geoJsonPath}: ${fc.features.length} feature(s)${dropped > 0 ? ` (${dropped} record(s) without location omitted)` : ""}.`);
        }
    }
    return result;
}
/** Convenience: load a verified or final JSON file, geocode its records. */
export async function geocodeFromFile(jsonPath, outPath, opts = {}) {
    const parsed = JSON.parse(await readFile(jsonPath, "utf8"));
    const records = Array.isArray(parsed)
        ? parsed
        : (parsed.records ?? []);
    if (!records.length) {
        console.warn(`[geocode] No records found in ${jsonPath}`);
    }
    return geocodeRecords(records, outPath, opts);
}
//# sourceMappingURL=geocode.js.map