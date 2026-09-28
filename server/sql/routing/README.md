# Residence → entrance routing

The road network and GPS-derived speeds are built in `your_db`, next to the OSM
import and the 76M-point bus history. The candidate routes plans choose from
are stored in `transport`, next to the plans. A script connects to both
databases, so no cross-database link (postgres_fdw/dblink) is needed.

| Step | Where | Run as | What |
|---|---|---|---|
| `01_network.sql` | your_db | postgres | pgRouting + `routing.edge` / `routing.vertex`, built from OSM ways |
| `02a_gps_bins.sql` | your_db | postgres | GPS points binned to ~20 m cell × heading × 15-min slot (`routing.gps_bin`, ~9 min) |
| `02b_speed_profiles.sql` | your_db | postgres | bins matched to edges; observed speed per edge, direction and slot (`routing.edge_speed_profile`, ~2 min) |
| `03_candidates.sql` | transport | postgres | `routing.od_pair`, `route_candidate`, `route_candidate_slot`, `plan_route` |
| `scripts/generate-route-candidates.js` | both | ro_user reads, PGW_USER writes | up to k diverse routes per residence → entrance pair. Road hierarchy: major roads (motorway/trunk/primary) priced by 1446 time, other roads by free-flow time × `--local-weight` (default 3); keeps out of `data/geofences_to_avoid_v2.geojson` (Mina, Arafat): roads touching them are banned by default (`--avoid-penalty 0`; a positive value makes them that many × dearer instead); the optimizer drops any candidate running more than `--avoid-max-m` (default 0 m) inside. `--residence` / `--geojson-out` for testing |
| `04_optimizer.sql` | transport | postgres | `routing.optimization_run`, `routing.plan_dispatch`, `routing.plan_skipped` (plans a run could not route, with the reason) |
| `scripts/optimize-routes.js` | both | ro_user reads, PGW_USER writes | route + departure slots per plan (MILP, HiGHS) |
| `05_edge_flow.sql` | your_db | postgres | distinct 1446 buses per edge, direction and slot (`routing.edge_flow`, ~8 min, run on the VM) |
| `scripts/calibrate-congestion.js` | your_db | ro_user | fits the BPR congestion curve to 1446 speeds vs bus flow |
| `06_entrance_flow.sql` | your_db | postgres | buses entering each entrance per 15-min slot in 1446 (`routing.entrance_entry`, `entrance_flow_slot`; run on the VM) |
| `06b_entrance_entries.sql` | your_db | postgres | pass 2 of step 6, run by it: gate entries only (bus slowed to ≤ 15 km/h), each bus once per hour; rerun alone while `routing.entrance_pts` exists |
| `07_backtest_trips.sql`, `07b_backtest_trip_detail.sql` | your_db | postgres | real 1446 residence → entrance trips (`routing.backtest_trip`, `backtest_trip_detail`) for `scripts/backtest-travel-times.js`; only needed to re-test the speed model |
| `08_edge_travel_time.sql` | your_db | postgres | stop-inclusive travel time per edge, direction and slot, queueing included (`routing.edge_speed_static_v2`, `edge_speed_profile_v2`; full GPS scan, ~11 min, run on the VM) |
| `09_edge_cost_v2.sql` | your_db | postgres | the costs the generator routes on: `routing.edge_cost` (stop-inclusive, falling back to `edge_cost_v1` = moving-only 02b speeds, then free flow) and `routing.edge_slot_speed` (per-slot) |
| `scripts/estimate-entrance-capacity.js` | both | PGW_USER | `--step prepare` writes entrance zones to your_db; `--step estimate` writes `transport.routing.entrance_capacity_estimate` for review (never `entrances.capacity`) |
| `scripts/h3-cluster-analysis.js` | both | ro_user | read-only: how residences group into H3 cells and what a cell-level route would cost (needs the `h3` extension in transport) |

```sh
psql -h 127.0.0.1 -p 5431 -U postgres -d your_db   -f sql/routing/01_network.sql
psql -h 127.0.0.1 -p 5431 -U postgres -d your_db   -f sql/routing/02a_gps_bins.sql
psql -h 127.0.0.1 -p 5431 -U postgres -d your_db   -f sql/routing/02b_speed_profiles.sql
psql -h 127.0.0.1 -p 5431 -U postgres -d transport -f sql/routing/03_candidates.sql
node scripts/generate-route-candidates.js --dry-run --limit 20   # check first
node scripts/generate-route-candidates.js
psql -h 127.0.0.1 -p 5431 -U postgres -d transport -f sql/routing/04_optimizer.sql
brew install highs                                    # native solver; the npm build only copes with small models
node scripts/optimize-routes.js --dry-run             # prints baseline vs optimized KPIs
node scripts/optimize-routes.js                       # saves a run to routing.optimization_run / plan_dispatch / plan_skipped
```

The optimizer works in Hajj-relative time (Hijri day + local time) and uses the
1446 travel time of the same Hijri slot. Congestion is a BPR penalty on the
buses the plans put on each road bundle per 15-min slot; its capacity
(`--capacity-share`) and strength (`--alpha`, `--beta`) are engineering
defaults; `calibrate-congestion.js` fits them to the 1446 GPS. To compare
settings on one yardstick, score saved runs under several models:

```sh
node scripts/optimize-routes.js --score-runs 3,4,5,6 --score-models "4:0.4,1:1.83,2:0.99,4:0.3"
```

A run never changes `public.plans`.

The SSH tunnel drops during long, silent statements, and the server then
cancels them. Run 02a/02b on the VM itself so they survive that:

```sh
scp sql/routing/02a_gps_bins.sql oci:/tmp/
ssh oci 'nohup sudo -u postgres psql -d your_db -v ON_ERROR_STOP=1 -f /tmp/02a_gps_bins.sql > /tmp/02a.log 2>&1 < /dev/null &'
```

The generator works without step 02: it then uses free-flow speeds and writes
no per-slot travel times.

## Rebuilding after a network change

Rebuilding the network in 01 changes every edge id and drops the cost views
that depend on it, so run, in order: 01 → 02b → 05 → 08 → 09, then generate
routes and optimize. 02a (GPS bins), 06 and 06b (entrance flow) do not depend
on the network; re-run 02a only when the GPS data changes. Generation runs
made before the rebuild keep their route geometry but not their edge ids, so
they can no longer be re-optimized or rescored; delete them once a new run is
checked (`DELETE FROM routing.generation_run WHERE id = …` cascades to their
routes and optimization runs).

## Refreshing the OSM import

`public.planet_osm_*` in your_db is an osm2pgsql import of the Makkah area.
The current one is the Geofabrik GCC extract of 2026-09-27. Refresh it on the
VM with the same settings (slim, new middle format with jsonb tags, which 01
reads; lat/lon; hstore), then rebuild as above:

```sh
sudo apt-get install -y osm2pgsql osmium-tool          # 1.11 / 1.16 on Ubuntu 24.04
wget -O ~/osm/gcc-states-latest.osm.pbf https://download.geofabrik.de/asia/gcc-states-latest.osm.pbf
osmium extract -b 39.35,21.15,40.10,21.70 --strategy complete_ways \
    ~/osm/gcc-states-latest.osm.pbf -o /tmp/makkah.osm.pbf --overwrite
sudo -u postgres osm2pgsql --create --slim --middle-database-format=new --latlong --hstore \
    --style /usr/share/osm2pgsql/default.style --database your_db /tmp/makkah.osm.pbf
# restore the owner of public.planet_osm_* and osm2pgsql_properties (khaledchaabane)
```

A stale import shows up as plans with no route although a mapping service
finds one: the 2025-05-29 import lacked the interchange east of ASMARF3/ASMARF4,
which left their plans unroutable under the zone ban.
