# TCE Proximity — static web version

TCE Proximity dashboard that runs entirely in the browser. It can be hosted on GitHub Pages (or any static web server).

**Data privacy:** the quotes data file (.xlsx extraction workbook or .csv) is opened from the user's computer and
processed locally by the browser (DuckDB-WASM). It is never uploaded to any server. This repository contains only the application code;
it must never contain data files (see `.gitignore`).

## Use

1. Open the site (e.g. `https://<user>.github.io/<repo>/`).
2. Click **Open data file…** (or drag and drop the file on the page): an LUDP extraction workbook such as
   `NA Quotes Oct28.xlsx` (data in the first sheet) or a .csv export. Edge/Chrome remember the file so it can be
   reopened with one click. The first time, a large .xlsx takes 25 s – 2 min to read; it is then kept in this browser
   (IndexedDB, as Parquet) and reopens in a few seconds.
3. Tabs: 1. TCE Classification · 2. Quote Detail · 3. Proximity by FC · 4. Dependency by FC · 5. Bid-Item Ranking ·
   6. WW Ranking · 7. Adjustments. Values are in USD (bid-item value = `bid_item_value_usd`); revenue contribution of an
   FC = value of every configuration that includes it (TCE Sel = only fully TCE configurations).
4. WW Ranking: choose the data files of NA, AP, LA and EMEA at once (the geo is taken from the start of each file name).
5. TCE adjustments are saved in the browser (localStorage). Use **Export adjustments / Import…** in tab 7 to move
   them to another computer or browser (same `tce_overrides.json` format as the Python version). An adjustment is
   removed automatically when a newer data file brings a different source value for that feature code.

Requirements: a modern browser (Edge, Chrome, Firefox) and internet access to load the libraries from public CDNs
(DuckDB-WASM from cdn.jsdelivr.net, SheetJS from cdn.sheetjs.com). Reading .xlsx files needs Edge/Chrome 103+ or
Firefox 113+ (DecompressionStream).

## Files

| File | Purpose |
|---|---|
| `index.html`, `styles.css` | page shell and styles |
| `app.js` | user interface (same screens as the Python version) |
| `api.js` | in-browser replacement of the Python API: routes `/api/...`, adjustments store, Excel export, file opening |
| `engine.js` | data engine (DuckDB-WASM SQL): replicates `app/data.py` of the Python version |
| `xlsx.js` | streaming reader for large .xlsx files (first sheet only, no external library) |
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

Open `http://localhost:8020/Github_Pages_Version/tests/compare.html` (NA CSV of Oct 4, **68/68 OK**) and
`compare.html?set=na28` (`DATA/Quotes October/NA Quotes Oct28.xlsx`, **64/64 OK**; add `&nocache=1` to test the
.xlsx conversion instead of the browser cache). They compare the API responses of the browser engine (rankings,
dependency, quote details, revenue contribution, adjustments flow, errors) with the Python API.
