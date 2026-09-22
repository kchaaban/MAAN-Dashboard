// Thin client for the MAAN Routing API (see "MAAN Routing API" OpenAPI doc).
//
// It computes a driving route between two lon/lat points and returns the route
// as an array of [lon, lat] coordinates (a GeoJSON LineString's coordinates).
//
// Configuration (server/.env):
//   ROUTE_API_URL   Base URL of the routing service, e.g. https://routing.example.com
//                   The route endpoint is `${ROUTE_API_URL}/v1/route`.
//   ROUTE_API_KEY   Optional. Sent as `Authorization: Bearer <key>` when present.
//   ROUTE_API_TIMEOUT_MS  Optional per-request timeout (default 15000).
//
// When ROUTE_API_URL is not set, or a call fails, the client falls back to a
// straight line between origin and destination so the import pipeline still
// produces geometry. Callers can tell the two apart via the returned `source`.

const ROUTE_API_URL = (process.env.ROUTE_API_URL || '').replace(/\/+$/, '');
const ROUTE_API_KEY = process.env.ROUTE_API_KEY || '';
const TIMEOUT_MS = Number(process.env.ROUTE_API_TIMEOUT_MS) || 15000;

function isConfigured() {
    return Boolean(ROUTE_API_URL);
}

const isCoord = (p) =>
    Array.isArray(p) && p.length >= 2 &&
    Number.isFinite(p[0]) && Number.isFinite(p[1]);

// Pull the first LineString coordinate array out of whatever the API returns.
// The documented response is a GeoJSON FeatureCollection; be liberal about shape.
function extractLine(payload) {
    if (!payload || typeof payload !== 'object') return null;
    if (Array.isArray(payload.features)) {
        for (const f of payload.features) {
            const g = f && f.geometry;
            if (g && g.type === 'LineString' && Array.isArray(g.coordinates)) {
                return g.coordinates.filter(isCoord);
            }
        }
    }
    if (payload.geometry && Array.isArray(payload.geometry.coordinates)) {
        return payload.geometry.coordinates.filter(isCoord);
    }
    if (payload.type === 'LineString' && Array.isArray(payload.coordinates)) {
        return payload.coordinates.filter(isCoord);
    }
    return null;
}

// origin and destination are [lon, lat]. waypoints is an optional [[lon,lat],...].
// Returns { coordinates: [[lon,lat],...], source: 'api' | 'fallback' }.
async function route(origin, destination, waypoints = []) {
    if (!isCoord(origin) || !isCoord(destination)) {
        throw new Error('route(): origin and destination must be [lon, lat]');
    }

    const straightLine = () => ({
        coordinates: [origin, ...waypoints.filter(isCoord), destination],
        source: 'fallback',
    });

    if (!isConfigured()) return straightLine();

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
        const res = await fetch(`${ROUTE_API_URL}/v1/route`, {
            method: 'POST',
            signal: controller.signal,
            headers: {
                'Content-Type': 'application/json',
                ...(ROUTE_API_KEY ? { Authorization: `Bearer ${ROUTE_API_KEY}` } : {}),
            },
            body: JSON.stringify({
                origin,
                destination,
                ...(waypoints.length ? { waypoints: waypoints.filter(isCoord) } : {}),
            }),
        });

        if (!res.ok) {
            console.warn(`[routing] ${res.status} from route API; using fallback line`);
            return straightLine();
        }

        const line = extractLine(await res.json());
        if (!line || line.length < 2) {
            console.warn('[routing] route API returned no usable LineString; using fallback');
            return straightLine();
        }
        return { coordinates: line, source: 'api' };
    } catch (err) {
        console.warn(`[routing] route API call failed (${err.message}); using fallback line`);
        return straightLine();
    } finally {
        clearTimeout(timer);
    }
}

// GeoJSON LineString string for ST_GeomFromGeoJSON.
function toLineStringGeoJSON(coordinates) {
    return JSON.stringify({ type: 'LineString', coordinates });
}

module.exports = { route, isConfigured, toLineStringGeoJSON };
