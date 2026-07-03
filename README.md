# MOP Planner

Monthly operating plan dashboard for SolarSquare's Referral channel. Static site, no build step — deploy as-is via GitHub Pages.

## Files
- `index.html` — page shell and layout
- `styles.css` — light theme (see brief: minimal color, professional)
- `core.js` — pure calculation engine (data filtering, trend projection, funnel/overwrite logic, share splitting). No DOM code — kept separate so it can be unit tested.
- `app.js` — state, GitHub data fetch, rendering, event wiring

## Data source
Fetches `https://raw.githubusercontent.com/yashk-SSE/Referral-Dashboard/main/data/referral_effort.json` directly at page load — no copy of the data lives in this repo. If that fetch fails (wrong path, repo made private, offline), a manual file-upload fallback appears.

## Master config (edit in `core.js`)
- `CITIES` — 27 cities with cluster mapping. **5 clusters are best-guess placeholders** (Jalgaon, Solapur, Faridabad, Agra, Coimbatore) — confirm and correct if needed. Cluster only affects the grouping display, not any calculation.
- `SUB_CHANNELS` — current 5-channel taxonomy (Sales, Online, Ops / AMC, Customer_App, Referral_Others). `BTL` is tracked and shown but excluded from every projection. When the sub-channel taxonomy is reworked (Sales / WhatsApp / Ops / AMC / Customer App / BTL / Others), update this array and the underlying BigQuery export — the rest of the app doesn't need to change.
- `DEFAULT_SETTINGS` — default field mappings (BQL_New, First_MS, First_MD), default trailing window (n=3), default campaign months, default Order→HOTO policy rate (95%).

## Known limitations / things to watch
- **Small-volume cities produce noisy rates.** Several of the smaller cities (e.g. Solapur, Jalgaon, Ahmedabad) show 0% or 100% conversion rates in some views because their absolute monthly volume is low enough that one or two leads swing the ratio. This is real small-sample noise, not a bug — worth deciding whether to blend low-volume cities' rates toward their cluster or pan-India average in a future pass.
- Rates are floored at 0% but have no ceiling — they can legitimately exceed 100% (e.g. a backlog of orders converting to HOTO in one month). Only a negative rate is treated as invalid and floored to 0.
- City-level BQL is *share-derived* from the pan-India total (not independently trended per city); city-level *rates* are independently trended per city. This matches the existing spreadsheet's methodology.

## Version history
Settings tab lets you store a GitHub personal access token (browser-local only) to save dated snapshots straight to `history/{planning-month}/*.json` in this repo via the GitHub API. "Export JSON" always works with no setup, for a local download instead.
