# v2.4 — upload fixes (CSV + Excel, comment changes)

## Fixed
- **"Could not process this CSV"** — parse errors (unquoted commas, odd quotes,
  semicolon-delimited Excel exports, UTF-16 files) used to escape as a generic
  500. They now upload when possible, or return the exact row + reason.
  Any remaining server failure shows a stage reference, e.g. `[ref: db/P2022]`.
- Delayed comments are now created in the same DB transaction as the posts and
  BEFORE anything is queued (a post that fired immediately could publish before
  its comment rows existed).
- DB transaction timeout raised (5 s default is too short for big files).
- A failing disk copy of the upload (volume permissions) no longer blocks the upload.
- Worker containers now mount `upload-data`, so CSV/XLSX retention cleanup works.
- After a failed upload the form keeps the chosen file.

## New
- `.csv` and `.xlsx` upload (Google Sheets: File → Download → CSV / Excel).
- Demo files: `GET /api/upload/template?format=csv|xlsx` (buttons in the upload form).

## Changed
- Comment 3 removed. Columns: `comment_1` (+`comment_1_delay_minutes`),
  `comment_2` (+`comment_2_delay_minutes`). Old `comment` column = comment_1.
  Old files with `comment_3` columns still upload; those columns are ignored
  and a warning is shown.
- Limits: 25 MB per file (CSV and XLSX), 10,000 rows, 10,000 columns
  (only the 7 known columns are kept in memory, the rest are dropped while
  parsing). Env: `MAX_CSV_BYTES`, `MAX_XLSX_BYTES`, `MAX_CSV_ROWS`, `MAX_CSV_COLUMNS`.
- Upload rate limit now `UPLOAD_LIMIT_PER_HOUR` (default 300, was 20) so one CSV per
  page for 200 pages works.
- Memory gate: big uploads are processed one at a time (`UPLOAD_INFLIGHT_BYTES`, 30 MB).
- Queue guard: uploads are refused when more than `MAX_PENDING_POSTS` (150,000)
  posts are scheduled system-wide (protects Redis, 224 MB / noeviction).
- Web container: 768 MB limit, 448 MB heap (was 352 / 256). Stack total ≈ 1.85 GB → VPS needs ≥ 2 GB RAM.
- next.config: `middlewareClientMaxBodySize: 30mb` (Next truncates bodies > 10 MB otherwise).
- Job "View posts" is paginated (1000 per page + Load more) so a 10,000-row job doesn't hang the browser.

## Deploy
Only new dependency: `exceljs` (already in web/package.json + lock). No DB
migration needed. Rebuild web + worker images (worker Dockerfile changed).
