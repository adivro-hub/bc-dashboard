# BC Dashboard (public build)

Self-contained weekly comparison dashboard for BlackCab operations: income
structure, fleet utilisation, hour statistics, job-level pivot, and user
registrations.

> **This is the public, anonymised build.** Customer-facing account names
> are stripped (the pivot's Account filter shows numeric IDs only). Raw
> exports and the full dashboard are not in this repository.

## Output

`index.html` — single-page HTML dashboard with all data embedded inline.
Open it in any modern browser (it pulls Chart.js from a CDN).

If GitHub Pages is enabled for this repo, it is served live at:
`https://<owner>.github.io/<repo>/`

### Upload your own reports

Open `upload.html` in any browser and drop any number of Excel exports
onto the single drop zone. Files are classified by content (Income
Structure / Job Analogue / Hour Statistics / Registration Info) and
parsed in your browser — **files never leave your machine**.

After upload, pick **any two date ranges** to compare (day-vs-day,
week-vs-week, month-vs-month, anything). Income Structure exports are
file-level aggregates; when your range doesn't tile cleanly to a file
boundary, the income KPIs are synthesised from per-row Job Analogue
data instead.

Re-pick periods freely without re-uploading.

Live URL: `https://<owner>.github.io/<repo>/upload.html`

### Deploy to Vercel

The repo is a pure static site, so Vercel deploys it as-is. `vercel.json`
sets cache headers for the HTML/CSS/JS assets. Connect the GitHub repo
on Vercel and push to deploy — no build step needed.

## Layout

1. **Headline KPIs** — total sales, jobs, earnings, avg/job, VAT.
2. **User registrations** — current vs previous week count, status mix,
   daily breakdown.
3. **Sales composition** — donuts of payment type, customer grade, service,
   fleet (current-week share %).
4. **Week-over-week comparisons** — grouped bar chart + table per income
   slice. Tables show jobs (cur/prev), totals (cur/prev), Δ abs, Δ %, share.
5. **Driver Login Time by Fleet** — total online hours per fleet.
6. **Hours per job by Fleet** — `online hours ÷ jobs done` ratio with WoW Δ%.
7. **Hour Statistics — Fleet availability vs demand**
   - KPIs: peak available (online − on break), peak busy (doing job),
     average utilisation.
   - Average-by-hour-of-day chart.
   - Per-week 168-hour timeline (stacked busy / idle / on break + online line).
8. **Job Analogue — Pivot by Service** — interactive pivot with filters
   (Account Number, Urgency, Status, Hour of day) and rows by Service;
   values: jobs count, Σ Total Price, Σ Driver Total Price.

## Source files

| File | Purpose |
|---|---|
| `Income Structure - …110207.794.xls` | Current week income (03–09 May 2026) |
| `Income Structure - …110214.270.xls` | Previous week income (26 Apr–02 May 2026) |
| `Job Analogue 03.05.26 - 09.05.26.xls` | Current week job log |
| `Job Analogue 26.04.26 - 02.05.26.xls` | Previous week job log |
| `Hour Statistics (23).xlsx` | Current week hourly fleet stats |
| `Hour Statistics (24).xlsx` | Previous week hourly fleet stats |
| `Registration Info (48).xls` | Current week user registrations |
| `Registration Info (49).xls` | Previous week user registrations |

## Build

Requires Python 3 + `pandas`, `xlrd`, `openpyxl`.

```bash
python build_dashboard.py        # → data.json (income structure)
python build_jobs.py             # → jobs.json (excluded from public repo)
python build_hours.py            # → hours.json
python build_reg.py              # → registrations.json
python build_otp.py              # → otp.json (OTP airport pickup/destination)
python build_top_clients.py      # → top_clients.json (top 25 retail + corp)
python embed_data.py             # → dashboard.html (full, with names)
python embed_data.py --public    # → index.html (anonymised public build)
```

`dashboard.template.html` holds the markup, CSS and JS; `embed_data.py`
inlines the four JSON payloads in place of placeholders. In `--public`
mode it also strips Account Name from each job row and shows a banner.
