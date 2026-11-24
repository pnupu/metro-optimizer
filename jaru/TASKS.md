# Metro Optimizer tasks

Scope: a phone web app (Helsinki region) that plans trips and routes inside metro stations:
exit, stairs, escalators, lifts, train end, and shops inside joined buildings. All data from the
internet; OpenStreetMap only for indoor data.

Done: every row below is Done, the code is on `origin/main`, and the build is live on Vinssi Pages
(site 01a20f12-9634-71b9-bf3c-95b9ab38f23d).

Next: —

| ID   | Task                                                                              | State | Needs | Evidence                                              |
| ---- | --------------------------------------------------------------------------------- | ----- | ----- | ----------------------------------------------------- |
| T001 | Trip planner on Transitous with station data from OSM and HSL GTFS                | Done  | —     | `9131ac0`; live run Kamppi → Itis                     |
| T002 | Follow-signs directions (city guide PDFs for 11 stations) and clearer indoor maps | Done  | T001  | `bfbb86a`; 19 tests                                   |
| T003 | Floor-by-floor walkthrough of station paths                                       | Done  | T002  | `2bd9f3b`; live run Matinkylä                         |
| T004 | One walkthrough for the whole trip                                                | Done  | T003  | `e35ea38`; 22-step live run                           |
| T005 | Map follows the chosen exit; lift exits; building outlines                        | Done  | T004  | `22e61df`; Rautatientori and Tapiola runs             |
| T006 | Indoor routing to shops in buildings joined to a station (OSM)                    | Done  | T005  | `5980197`; live run Swing House → Dif Döner, 33 tests |

Later: 3D view of multi-floor indoor maps (floors stacked, path drawn through them), when the user
asks for it.
