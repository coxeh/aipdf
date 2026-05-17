export type GeocodeStatus = "OK" | "ZERO_RESULTS" | "OVER_QUERY_LIMIT" | "OVER_DAILY_LIMIT" | "REQUEST_DENIED" | "INVALID_REQUEST" | "UNKNOWN_ERROR" | "ERROR";
export type RecordGeocode = {
    query: string;
    status: GeocodeStatus | string;
    formattedAddress: string | null;
    location: {
        lat: number;
        lng: number;
    } | null;
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
    records: Array<Record<string, unknown> & {
        geocode: RecordGeocode | null;
    }>;
};
export type GeoJSONFeature = {
    type: "Feature";
    geometry: {
        type: "Point";
        coordinates: [number, number];
    };
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
export declare function toGeoJSON(geocodeResult: GeocodeResult): GeoJSONFeatureCollection;
export declare function geocodeRecords(records: Array<Record<string, unknown>>, outPath: string, opts?: GeocodeOptions): Promise<GeocodeResult>;
/** Convenience: load a verified or final JSON file, geocode its records. */
export declare function geocodeFromFile(jsonPath: string, outPath: string, opts?: GeocodeOptions): Promise<GeocodeResult>;
