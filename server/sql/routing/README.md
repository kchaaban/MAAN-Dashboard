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
| `scripts/generate-route-candidates.js` | both | ro_user reads, PGW_USER writes | up to k diverse routes per residence → entrance pair |
| `04_optimizer.sql` | transport | postgres | `routing.optimization_run`, `routing.plan_dispatch` |
| `scripts/optimize-routes.js` | both | ro_user reads, PGW_USER writes | route + departure slots per plan (MILP, HiGHS) |
| `05_edge_flow.sql` | your_db | postgres | distinct 1446 buses per edge, direction and slot (`routing.edge_flow`, ~8 min, run on the VM) |
| `scripts/calibrate-congestion.js` | your_db | ro_user | fits the BPR congestion curve to 1446 speeds vs bus flow |

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
node scripts/optimize-routes.js                       # saves a run to routing.optimization_run / plan_dispatch
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
no per-slot travel times. Re-run 02b after rebuilding the network in 01 (02a only when the GPS data changes),
because edge ids change.
