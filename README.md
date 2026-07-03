# MOP Planner

Monthly operating plan dashboard for SolarSquare's Referral channel. Static site, no build step — deploy as-is via GitHub Pages.

## Files
- `index.html` — page shell and layout
- `styles.css` — light theme, rounded/modern styling built around the SolarSquare logo's blue
- `logo.png` — used as both the browser tab favicon and the header mark
- `core.js` — pure calculation engine (data filtering, trend projection, funnel/overwrite logic, share splitting). No DOM code — kept separate so it can be unit tested.
- `app.js` — state, GitHub data fetch, rendering, event wiring

## Data source
Fetches `https://raw.githubusercontent.com/yashk-SSE/Referral-Dashboard/main/data/referral_effort.json` directly at page load — no copy of the data lives in this repo. If that fetch fails (wrong path, repo made private, offline), a manual file-upload fallback appears.

## Master config (edit in `core.js`)
- `CITIES` — 27 cities with cluster mapping. **5 clusters are best-guess placeholders** (Jalgaon, Solapur, Faridabad, Agra, Coimbatore) — confirm and correct if needed. Cluster only affects the grouping display, not any calculation.
- `SUB_CHANNELS` — current 5-channel taxonomy (Sales, Online, Ops / AMC, Customer_App, Referral_Others). `BTL` is tracked and shown but excluded from every projection. When the sub-channel taxonomy is reworked (Sales / WhatsApp / Ops / AMC / Customer App / BTL / Others), update this array and the underlying BigQuery export — the rest of the app doesn't need to change.
- `DEFAULT_SETTINGS` — default field mappings (BQL_New, First_MS, First_MD), default trailing window (n=3), default campaign months, default Order→HOTO policy rate (95%).

## Known limitations / things to watch
- **Small-volume cities can still show noisy rates** for lower-volume cells within the 3 complete months used (e.g. a city with 10 leads a month can swing between 40% and 100% on a single lead). This is real small-sample noise, not a bug — worth deciding whether to blend low-volume cities' rates toward their cluster or pan-India average in a future pass. Use the **Historical** tab to see the raw monthly numbers behind any rate before trusting it.
- Rates are floored at 0% but have no ceiling — they can legitimately exceed 100% (this is cohort data, not calendar-month data, so a backlog converting to HOTO in one month is expected, not an error).
- City-level BQL is *share-derived* from the pan-India total (not independently trended per city); city-level *rates* are independently trended per city. This matches the existing spreadsheet's methodology.
- The in-progress month joins the trend automatically once it has at least **N days of data** (default 5, adjustable via "Min. days to trust current month" in the header) — using seasonally-adjusted estimates for every metric independently, not a shared day-count factor. Below that threshold it's excluded entirely and shown separately as a "too early to trust" pace box instead. Why 5, not fewer or more: diagnostic on real data showed day-2 estimates could swing ±22pp on a test month, while day-5-and-later estimates consistently landed within ~1-4pp of the eventual true rate.

## Historical tab
Shows the raw BQL/MS/MD/Order/HOTO and all 4 funnel rates for every trailing month, by city or by sub-channel — this is what feeds the trend calculation, laid out so any projected number can be traced back to its source months.

## Excel export
"Export Excel" builds a workbook shaped like the existing MOP file (Summary, Sub-Channel Funnel, City Funnel, CityxSub Channel sheets) from the live computed numbers, named `{Month}_MOP_Referral.xlsx`. It's a fresh computation each time, not a template fill — the elaborate prose assumption notes from the original file aren't reproduced verbatim, but the settings used (field mappings, trailing window, Order→HOTO mode, active initiatives) are listed on the Summary sheet instead.

## Version history
Settings tab lets you store a GitHub personal access token (browser-local only) to save dated snapshots straight to `history/{planning-month}/*.json` in this repo via the GitHub API. "Export JSON" always works with no setup, for a local download instead.
