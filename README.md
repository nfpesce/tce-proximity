# TCE Proximity — static web version

TCE Proximity dashboard that runs entirely in the browser. It can be hosted on GitHub Pages (or any static web server).

**Data privacy:** the quotes CSV is opened from the user's computer and processed locally by the browser
(DuckDB-WASM). It is never uploaded to any server. This repository contains only the application code;
it must never contain data files (see `.gitignore`).

## Use

1. Open the site (e.g. `https://<user>.github.io/<repo>/`).
2. Click **Open CSV file…** (or drag and drop the CSV on the page). Edge/Chrome remember the file so it can be reopened with one click.
3. Tabs: 1. TCE Classification · 2. Quote Detail · 3. Ranking by FC · 4. Bid-Item Ranking · 5. Adjustments.
4. TCE adjustments are saved in the browser (localStorage). Use **Export adjustments / Import…** in tab 5 to move
   them to another computer or browser (same `tce_overrides.json` format as the Python version).

Requirements: a modern browser (Edge, Chrome, Firefox) and internet access to load the libraries from public CDNs
(DuckDB-WASM from cdn.jsdelivr.net, SheetJS from cdn.sheetjs.com). Large files (~300 MB) open in a few seconds.

## Files

| File | Purpose |
|---|---|
| `index.html`, `styles.css` | page shell and styles |
| `app.js` | user interface (same screens as the Python version) |
| `api.js` | in-browser replacement of the Python API: routes `/api/...`, adjustments store, Excel export, file opening |
| `engine.js` | data engine (DuckDB-WASM SQL): replicates `app/data.py` of the Python version |
| `tests/compare.html` | development only: equivalence test against the Python API |

## Publish on GitHub Pages

```bash
git init
git add .
git commit -m "TCE Proximity static version"
git branch -M main
git remote add origin https://github.com/<user>/<repo>.git
git push -u origin main
```

Then in GitHub: **Settings → Pages → Build and deployment → Deploy from a branch → `main` / `(root)`**.
Before every push, check with `git status` that no `.csv`, `.xlsx` or `tests/expected*.json` file is staged.

## Development / tests

From the parent project folder (the Python version):

```bash
python scripts/make_pages_expected.py
python -m http.server 8020
```

Open `http://localhost:8020/Github_Pages_Version/tests/compare.html`: it loads the NA CSV in the browser engine and
compares 60 API responses (rankings, quote details, FC rankings, adjustments flow, errors) with the Python API.
Expected result: **60/60 OK**.
