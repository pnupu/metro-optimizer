# Metro Optimizer

A phone-first trip planner for the Helsinki region that also routes you **inside metro stations**:
which entrance or exit to use, the stairs, escalators and elevators on the way, and which end of
the train to board so you step off next to your exit. All text is in English.

- **Trip planning and live times:** [Transitous](https://transitous.org/) (MOTIS), no API key.
- **Station routing:** computed from [OpenStreetMap](https://www.openstreetmap.org/) indoor data
  for all 30 metro stations: entrances, corridors, stairs, escalators, elevators and platforms.
- **Maps:** [OpenFreeMap](https://openfreemap.org/) street map with English labels, plus an indoor
  and underground layer with a floor picker, drawn from the same OSM data.

## Exit signs

The station steps say "Follow signs for exit D (Kamppi Shopping Centre, Forum Shopping Centre)".
For 11 Helsinki stations the destinations come from the City of Helsinki station guide maps
(`hel.fi/static/hkl/metroasema_opaskartat/<station>.pdf`): the data builder reads the PDF's exit
table by text position, letters the blocks in reading order, and uses them only when the blocks fit
the station's lettered exits in OSM. Elsewhere the sign text is the street the exit opens onto (OSM
address or nearest named street) and the building or shopping centre it leads into. The app links
each station's guide map.

## Route modes

| Mode      | Station paths may use                                        |
| --------- | ------------------------------------------------------------ |
| Fastest   | Anything                                                     |
| No stairs | Escalators and elevators                                     |
| Step-free | Elevators only (also asks Transitous for wheelchair routing) |

Where OSM joins two floors without mapping how (no stairs, escalator or elevator), the app shows
"the map does not show how" and step-free paths avoid that connection.

## Which end of the train

For each platform the data builder finds the platform's two ends in OSM and where each station path
reaches the platform (0..1 along it). At run time the app compares the platform direction with the
direction of travel of the metro leg, so the position becomes back, middle or front of the train.
Trains are about 90 m (4 cars); older platforms are longer, so the advice is the train end, not a car
number.

## Commands

```bash
bun install
bun run dev:web     # http://localhost:3001
bun run test        # unit tests (station graph and guidance)
bun run data        # rebuild apps/web/public/data from HSL GTFS and the OSM API
bun run build       # production build in apps/web/dist
bunx oxlint && bunx oxfmt --check
```

`bun run data` downloads the HSL GTFS feed (about 90 MB) and the OSM data around each station into
`apps/web/.cache/` (kept for a day; `--refresh` downloads again), then writes:

- `public/data/stations.json`: the station index
- `public/data/stations/<id>.json`: entrances, platforms, in-station paths and indoor map features
- `public/data/metro-lines.json`: M1 and M2 line geometry

## Deploy

The app is a static site. Build it and publish `apps/web/dist` to Vinssi Pages:

```bash
bun run build
npx -y vinssi@0.1.4 pages publish apps/web/dist --site <siteId> --json
```

## Data and licences

- Code: MIT, see `LICENSE`.
- `apps/web/public/data/` is derived from OpenStreetMap and is available under the
  [ODbL](https://opendatacommons.org/licenses/odbl/) © OpenStreetMap contributors. Stop data comes
  from HSL open data (CC BY 4.0).
- The Transitous API is for free, open-source, non-commercial use:
  <https://transitous.org/api/>.

Built with [Better-T-Stack](https://www.better-t-stack.dev/) (React, TanStack Router, Tailwind,
PWA, Oxlint), Bun and MapLibre GL.
