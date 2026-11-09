/* api.js — reemplaza al servidor FastAPI (app/main.py) dentro del navegador.
 *
 * Atiende las mismas rutas /api/... con las mismas respuestas, usando engine.js (DuckDB-WASM).
 * Así la interfaz (app.js) es prácticamente la misma que la de la versión Python.
 * Además: ajustes TCE guardados en el navegador (mismo formato que tce_overrides.json),
 * exportación a Excel (SheetJS), apertura del archivo local (.xlsx / .csv; File System Access API o
 * <input type=file>) y el ranking WW con los archivos de las 4 geos.
 * Shipments: el CSV de shipments (todas las geos) se detecta por sus columnas; la geo se elige con selectGeo()
 * y el WW usa las 5 geos del mismo archivo (sin elegir archivos).
 * Carpeta de datos (openFolder): un archivo de quotes por geo + el de shipments WW, en formato CSV (salida cruda de
 * las queries) o XLSX; se identifican por sus columnas (como scan_folder en app/data.py) y se recuerda la carpeta.
 */
import * as engine from "./engine.js";
import { xlsxHeader } from "./xlsx.js";

const SHEETJS_URL = "https://cdn.sheetjs.com/xlsx-0.20.3/package/xlsx.mjs";

export class ApiError extends Error {
  constructor(status, detail) { super(detail); this.status = status; }
}

// Las llamadas al motor se ejecutan de a una (un solo `raw` activo): así una consulta lanzada mientras el WW
// recorre las geos (o mientras se abre un archivo) no lee datos de otra geo / archivo.
let queue = Promise.resolve();
const serial = fn => (...args) => { const p = queue.then(() => fn(...args)); queue = p.catch(() => {}); return p; };

// mensajes de progreso (lectura de archivos grandes): la interfaz registra dónde mostrarlos
let progress = () => {};
export function setProgressHandler(fn) { progress = fn || (() => {}); }

// ============================================================ ajustes (localStorage)
/** Misma lógica que OverrideStore (app/data.py); formato compatible con tce_overrides.json */
export class OverrideStore {
  constructor(key = "tce_overrides_v1") { this.key = key; this.data = this._read(); }
  _read() {
    try {
      const d = JSON.parse(localStorage.getItem(this.key) || "null");
      if (d && typeof d === "object") return { version: 1, overrides: d.overrides || {}, history: d.history || [] };
    } catch { /* datos corruptos o storage bloqueado -> vacío */ }
    return { version: 1, overrides: {}, history: [] };
  }
  _write() {
    try { localStorage.setItem(this.key, JSON.stringify(this.data)); }
    catch (e) { throw new ApiError(500, `Cannot save adjustments in this browser: ${e.message}`); }
  }
  mapping() { return Object.fromEntries(Object.entries(this.data.overrides).map(([fc, o]) => [fc, o.tce])); }
  overrides() { return { ...this.data.overrides }; }
  history() { return [...this.data.history]; }
  static now() {   // como datetime.now().isoformat(timespec="seconds")
    const d = new Date(), p = n => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  }
  set(fc, tce, csvTce, description, note = "") {
    if (!engine.TCE_VALUES.includes(tce)) throw new ApiError(400, `TCE value must be one of: ${engine.TCE_VALUES.join(", ")}`);
    const prev = this.data.overrides[fc];
    const before = prev ? prev.tce : csvTce;
    const now = OverrideStore.now();
    let action;
    if (tce === csvTce) {             // volver al valor del archivo = quitar el ajuste
      if (!prev) return;
      delete this.data.overrides[fc];
      action = "revert";
    } else {
      this.data.overrides[fc] = { tce, csv_tce: csvTce, description, note, updated: now };
      action = prev ? "update" : "create";
    }
    this.data.history.push({ ts: now, featurecode: fc, description, action, from: before, to: tce, note });
    this._write();
  }
  remove(fc, note = "", action = "revert") {
    const prev = this.data.overrides[fc];
    if (!prev) return false;
    delete this.data.overrides[fc];
    this.data.history.push({ ts: OverrideStore.now(), featurecode: fc, description: prev.description || "",
                             action, from: prev.tce, to: prev.csv_tce ?? null, note });
    this._write();
    return true;
  }
  /** Quita los ajustes cuyo valor de origen cambió en los datos nuevos (como drop_stale en Python) */
  dropStale(fileTce, fileName) {
    const stale = Object.entries(this.data.overrides)
      .filter(([fc, o]) => fileTce.has(fc) && (o.csv_tce ?? null) !== fileTce.get(fc)).map(([fc]) => fc);
    for (const fc of stale) {
      const was = this.data.overrides[fc].csv_tce;
      this.remove(fc, `Source value changed: ${was} -> ${fileTce.get(fc)} in ${fileName}`, "auto-revert");
    }
    return stale;
  }
  replaceAll(data) {
    if (!data || typeof data !== "object" || typeof data.overrides !== "object")
      throw new ApiError(400, "Invalid adjustments file (expected the tce_overrides.json format).");
    for (const [fc, o] of Object.entries(data.overrides))
      if (!o || !engine.TCE_VALUES.includes(o.tce)) throw new ApiError(400, `Invalid TCE value for ${fc} in the adjustments file.`);
    this.data = { version: 1, overrides: data.overrides, history: Array.isArray(data.history) ? data.history : [] };
    this._write();
  }
}

let store = new OverrideStore();
let shipStore = new OverrideStore("tce_overrides_ship_v1");   // shipments: ajustes por SBB, aparte de los de quotes
export function useStore(s, ship = s) { store = s; shipStore = ship; }   // los tests usan una clave propia
const S = () => engine.currentSource() === "shipments" ? shipStore : store;

// ============================================================ router /api/...
const opt = v => (v === null || v === undefined || v === "" || v === "all" || v === "(todos)") ? null : v;
function param(qs, name, def) { return qs.has(name) ? qs.get(name) : def; }
function tceParam(v) {
  v = opt(v);
  if (v !== null && !engine.TCE_VALUES.includes(v))
    throw new ApiError(400, `tce must be one of: ${engine.TCE_VALUES.join(", ")} or all`);
  return v;
}
const values = (qs, name) => { const v = qs.getAll(name).filter(x => x && x !== "all"); return v.length ? v : null; };
const products = qs => values(qs, "product");
// filtros de selección múltiple de las vistas 1 y 5 (?country=A&country=B, etc.)
const multi = qs => Object.fromEntries(["product", "country", "forecast", "status"].map(k => [k, values(qs, k)]));
const express = qs => opt(param(qs, "express", "all"));
const currency = qs => opt(param(qs, "currency", "all"));
/** ?proximity=1&proximity=3 (selección múltiple); sin parámetro = [1]; "all" = null (todas) */
function proximityParam(qs) {
  const ps = qs.getAll("proximity");
  if (ps.includes("all")) return null;
  if (!ps.length) return [1];
  if (ps.some(x => !/^\d+$/.test(x) || Number(x) < 1)) throw new ApiError(422, "proximity must be an integer >= 1");
  return ps.map(Number);
}

function adjustmentsPayload() {
  const items = Object.entries(S().overrides())
    .sort((a, b) => (a[1].updated < b[1].updated ? 1 : a[1].updated > b[1].updated ? -1 : 0))
    .map(([fc, o]) => ({ featurecode: fc, ...o, in_file: engine.fcExists(fc), csv_tce_current_file: engine.fcCsvTce(fc) }));
  return { file: engine.currentFile(), storage: "this browser", adjustments: items,
           history: S().history().reverse().slice(0, 200) };
}

/** Atiende una ruta de la API. Devuelve el JSON o lanza ApiError(status, detail). */
export const api = serial(apiImpl);
async function apiImpl(url, opts = {}) {
  const u = new URL(url, location.href);
  const path = u.pathname.replace(/^.*?\/api\//, "/api/");
  const qs = u.searchParams, method = (opts.method || "GET").toUpperCase();
  const body = opts.body ? JSON.parse(opts.body) : null;
  const seg = path.split("/").filter(Boolean).map(decodeURIComponent);   // ["api", ...]

  if (!engine.currentFile()) throw new ApiError(404, "No data loaded. Open a data file.");
  await engine.applyOverrides(S().mapping());
  try {
    if (method === "GET" && path === "/api/meta") {
      const m = await engine.meta();
      m.adjustments = Object.entries(S().overrides()).map(([fc, o]) => ({ featurecode: fc, from: o.csv_tce ?? null, to: o.tce }));
      return m;
    }
    if (method === "GET" && path === "/api/ranking")
      return engine.ranking(express(qs), currency(qs), tceParam(param(qs, "tce", "N")), multi(qs));
    if (method === "GET" && path === "/api/bids")
      return engine.bids(express(qs), currency(qs), tceParam(param(qs, "tce", "N")), multi(qs));
    if (method === "GET" && seg[1] === "quote" && seg.length === 3) {
      const q = await engine.quoteDetail(seg[2]);
      if (!q) throw new ApiError(404, `Quote ${seg[2]} not found`);
      return q;
    }
    if (method === "GET" && path === "/api/search") return engine.searchQuotes(param(qs, "q", ""));
    if (method === "GET" && path === "/api/fc-ranking")
      return await engine.fcRanking(proximityParam(qs), param(qs, "criteria", "exactly"), express(qs), currency(qs), products(qs));
    if (method === "GET" && path === "/api/dependency")
      return await engine.dependency(express(qs), currency(qs), products(qs));
    if (method === "GET" && seg[1] === "dependency" && seg.length === 3) {
      const r = await engine.dependencyConfigs(seg[2], express(qs), currency(qs), products(qs));
      if (!r) throw new ApiError(404, `Feature code ${seg[2]} not found in ${engine.currentFile()}`);
      return r;
    }
    if (method === "GET" && path === "/api/ww")
      return engine.currentSource() === "shipments" ? await shipWw(proximityParam(qs)) : await ww(proximityParam(qs));
    if (method === "GET" && path === "/api/fc-search") return engine.searchFc(param(qs, "q", ""));
    if (method === "GET" && seg[1] === "fc" && seg.length === 3) {
      const r = await engine.fcLookup(seg[2], express(qs), currency(qs));
      if (!r) throw new ApiError(404, `Feature code ${seg[2]} not found in ${engine.currentFile()}`);
      r.adjustment = S().overrides()[r.featurecode] ?? null;
      return r;
    }
    if (method === "GET" && path === "/api/adjustments") return adjustmentsPayload();
    if (seg[1] === "adjustments" && seg.length === 3) {
      if (method === "PUT") {
        const info = await engine.fcLookup(seg[2], null, null);
        if (!info) throw new ApiError(404, `Feature code ${seg[2]} not found in ${engine.currentFile()}`);
        const fc = info.featurecode;
        S().set(fc, body?.tce, engine.fcCsvTce(fc), engine.fcDescription(fc), String(body?.note ?? "").trim());
        await engine.applyOverrides(S().mapping());
        return adjustmentsPayload();
      }
      if (method === "DELETE") {
        if (!S().remove(seg[2])) throw new ApiError(404, `No active adjustment for ${seg[2]}`);
        await engine.applyOverrides(S().mapping());
        return adjustmentsPayload();
      }
    }
  } catch (e) {
    if (e instanceof ApiError) throw e;
    if (e instanceof engine.DataError) throw new ApiError(400, e.message);
    throw e;
  }
  throw new ApiError(404, `Not found: ${method} ${path}`);
}

// ============================================================ WW (archivos de las 4 geos)
let currentFileObj = null;      // archivo activo (para volver a él después de armar el WW)
let wwFiles = [];               // archivos elegidos para el WW
let wwMemo = null;              // { key, result }
const fileKey = f => `${f.name}|${f.size}|${f.lastModified}`;

/** Archivo usado para cada geo: el más reciente de cada una (por el prefijo del nombre, como ww_files en Python) */
function wwPick() {
  const pick = {};
  for (const f of [...wwFiles].sort((a, b) => b.lastModified - a.lastModified)) {
    const g = engine.geoFromName(f.name);
    if (engine.GEOS.includes(g) && !pick[g]) pick[g] = f;
  }
  return pick;
}
export function wwFileNames() { return Object.fromEntries(Object.entries(wwPick()).map(([g, f]) => [g, f.name])); }

async function ww(prox) {
  const pick = wwPick();
  if (!Object.keys(pick).length)
    throw new ApiError(428, "Choose the data files of the geos (NA, AP, LA, EMEA) to build the WW ranking.");
  const key = JSON.stringify([Object.entries(pick).map(([g, f]) => [g, fileKey(f)]), prox, S().mapping()]);
  if (wwMemo?.key === key) return wwMemo.result;
  const perGeo = {}, files = {};
  const restore = currentFileObj;
  let reloaded = false;
  try {
    for (const g of engine.GEOS) {
      const f = pick[g];
      if (!f) continue;
      if (!(restore && fileKey(f) === fileKey(restore) && !reloaded)) {
        progress(`WW ranking: reading ${g} (${f.name})…`);
        await engine.loadFile(f, f.name, { onProgress: p => progress(`WW ranking: reading ${g} (${f.name})… ${Math.round(100 * p)}%`) });
        reloaded = true;
        S().dropStale(engine.fcCsvMap(), f.name);
      }
      await engine.applyOverrides(S().mapping());
      perGeo[g] = [await engine.fcRanking(prox, "exactly", null, null, null, false), await engine.dependency()];
      files[g] = f.name;
    }
  } finally {
    if (reloaded && restore) {
      progress(`Reopening ${restore.name}…`);
      await engine.loadFile(restore, restore.name);
      await engine.applyOverrides(S().mapping());
    }
  }
  const result = engine.combineWw(perGeo, files, prox ?? []);
  if (!prox) result.filters.proximity = null;
  wwMemo = { key, result };
  return result;
}

/** WW de shipments: las 5 geos del archivo cargado (como ShipmentStore en Python) */
async function shipWw(prox) {
  const key = JSON.stringify(["ship", engine.shipFile(), prox, S().mapping()]);
  if (wwMemo?.key === key) return wwMemo.result;
  const active = engine.currentGeo(), perGeo = {}, files = {}, revAll = {}, units = {};
  try {
    for (const g of engine.SHIP_GEOS) {
      progress(`WW ranking: ${g}…`);
      await engine.selectGeo(g);
      S().dropStale(engine.fcCsvMap(), engine.shipFile());
      await engine.applyOverrides(S().mapping());
      perGeo[g] = [await engine.fcRanking(prox, "exactly", null, null, null, false), await engine.dependency()];
      files[g] = engine.shipFile();
      revAll[g] = engine.fcRevAll();
      units[g] = engine.fcUnits();
    }
  } finally {
    await engine.selectGeo(active);
    await engine.applyOverrides(S().mapping());
  }
  const result = engine.combineWw(perGeo, files, prox ?? [], { geoList: engine.SHIP_GEOS, revAll, units, source: "shipments" });
  if (!prox) result.filters.proximity = null;
  wwMemo = { key, result };
  return result;
}

// ============================================================ exportación a Excel
let XLSX = null;
async function sheetjs() { return XLSX || (XLSX = await import(SHEETJS_URL)); }

const SHIP_EXPORT_NAMES = {
  featurecode: "SBB", FC: "SBB", ref_fc: "FC(s)", basicname: "Basic name",
  opp_number: "end_customer_number", account: "end_customer_name", opp_total: "customer_total",
  opp_value_usd: "customer_value_usd", forecast_category_name: "segment1", forecast: "segment1",
  quotenumber: "so", Bid_Item: "mfgsoline", bid_item: "mfgsoline", product: "family",
  bid_pn: "mtm", status: "sc_status", contract_start: "ship_date", quotelines_quantity: "qty",
  tot_lines_qty: "so_total_qty", total_final_price: "so_value_usd", end_customer: "end_customer_name",
  "Bid Item Price (USD)": "Config value (USD)", value_usd: "config_value_usd", item: null,
  express: null, sales_rep: null,
};
const SHIP_SHEET_NAMES = { "FC ranking": "SBB ranking", "Quote Detail": "Order Detail", Bids: "Configs" };
function shipRows(rows) {
  return rows.map(r => {
    const o = {};
    for (const [k, v] of Object.entries(r)) {
      const name = k in SHIP_EXPORT_NAMES ? SHIP_EXPORT_NAMES[k] : k;
      if (name !== null && !(name in o)) o[name] = v;
    }
    return o;
  });
}
const refCols = x => "ref_fc" in x ? { ref_fc: x.ref_fc, basicname: x.basicname } : {};

async function writeXlsx(sheets, filename) {
  const X = await sheetjs();
  const adj = S().overrides();
  if (Object.keys(adj).length) {   // deja registrado que la base tiene ajustes
    sheets = { ...sheets, "TCE Adjustments": Object.entries(adj).map(([fc, o]) => ({
      featurecode: fc, description: o.description || "", "TCE in file": o.csv_tce ?? null,
      "TCE adjusted": o.tce, note: o.note || "", updated: o.updated })) };
  }
  if (engine.currentSource() === "shipments") {
    sheets = Object.fromEntries(Object.entries(sheets).map(([n, d]) => [SHIP_SHEET_NAMES[n] || n, shipRows(d)]));
    filename = filename.replace("TCE_", "TCE_Shipments_").replace("_FC", "_SBB").replace("Quote_", "Order_");
  }
  const wb = X.utils.book_new();
  for (const [name, data] of Object.entries(sheets)) {
    const ws = X.utils.json_to_sheet(data);
    if (ws["!ref"]) ws["!autofilter"] = { ref: ws["!ref"] };
    const cols = data.length ? Object.keys(data[0]) : [];
    ws["!cols"] = cols.map(c => ({ wch: Math.min(Math.max(10, Math.max(c.length, ...data.slice(0, 200).map(r => String(r[c] ?? "").length)) + 2), 70) }));
    X.utils.book_append_sheet(wb, ws, name.slice(0, 31));
  }
  X.writeFile(wb, filename.replace(/[^A-Za-z0-9_.-]/g, "_"));
}

const depRows = rows => rows.map((x, i) => ({
  Rank: i + 1, featurecode: x.featurecode, description: x.description, ...refCols(x), "Nbr of TCE Configs": x.configs, "% of TCE Configs": x.pct,
  "Rev Contrib All Configs (USD)": x.rev_all_usd, "Rev Contrib TCE Sel (USD)": x.rev_tce_usd, "TCE Sel / All": x.tce_share,
  "Rank by Rev Contrib TCE Sel": x.rev_tce_rank }));

/** Genera la exportación que corresponde a una URL /api/export/... (mismas hojas que la versión Python) */
export async function exportUrl(url) {
  const u = new URL(url, location.href), qs = u.searchParams;
  const path = decodeURIComponent(u.pathname.replace(/^.*?\/api\//, "/api/"));
  const base = new URL(url, location.href);
  base.pathname = base.pathname.replace("/export/", "/").replace(/\.xlsx$/, "");
  if (path === "/api/export/ranking.xlsx") {
    const r = await api(base.href);
    const rows = r.opps.flatMap(o => o.quotes.flatMap(q => q.bids.map(b => ({
      opp_number: o.opp_number, forecast_category_name: o.forecast, account: o.account, opp_total: o.total, opp_value_usd: o.value_usd,
      quotenumber: q.quotenumber, Bid_Item: b.bid_item, product: b.product, "TCE Proximity": b.proximity, "Bid Item Price (USD)": b.value_usd }))));
    return writeXlsx({ "TCE Proximity": rows }, "TCE_Proximity_ranking.xlsx");
  }
  if (path === "/api/export/bids.xlsx") return writeXlsx({ Bids: await api(base.href) }, "TCE_Proximity_bids.xlsx");
  if (path === "/api/export/fc-ranking.xlsx") {
    const r = await api(base.href);
    return writeXlsx({
      "FC ranking": r.rows.map((x, i) => ({ Rank: i + 1, featurecode: x.featurecode, description: x.description, ...refCols(x),
        "Nbr of Configs": x.configs, "% of Configs in Scope": r.configs_in_scope ? x.configs / r.configs_in_scope : 0,
        "Rev Contrib (USD)": x.rev_contrib_usd, "% of Rev Contrib": x.rev_pct, "Rank by Rev Contrib": x.rev_rank,
        "Value of configs in scope (USD)": x.value_in_scope_usd })),
      Configs: r.rows.flatMap(x => x.bids.map(b => ({ featurecode: x.featurecode, ...b }))),
    }, `TCE_by_FC_${r.filters.proximity === null ? "all" : [].concat(r.filters.proximity).join("-")}.xlsx`);
  }
  if (path === "/api/export/dependency.xlsx")
    return writeXlsx({ "TCE Dependency": depRows((await api(base.href)).rows) }, "TCE_Dependency_by_FC.xlsx");
  if (path === "/api/export/ww.xlsx") {
    const r = await api(base.href), geos = r.geos;
    // shipments: unidades despachadas del SBB (sbbqty) por geo y WW (como export_ww en main.py)
    const unitCols = x => !("units" in x) ? {} :
      { "Shipped units WW": x.units_ww, ...Object.fromEntries(geos.map(g => [`Shipped units ${g}`, x.units[g] || 0])) };
    const p = r.proximity.rows.map((x, i) => ({
      Rank: i + 1, FC: x.featurecode, Description: x.description, ...refCols(x), "Total Configs WW": x.configs_ww,
      ...Object.fromEntries(geos.map(g => [g, x.configs[g] || 0])), "# of Geos": x.n_geos, "% of WW Configs": x.pct,
      "Cumulative %": x.cum_pct, "Rev Contrib WW (USD)": x.rev_contrib_usd_ww,
      ...Object.fromEntries(geos.map(g => [`Rev Contrib ${g}`, x.rev_contrib_usd[g] || 0])),
      "% of WW Rev Contrib": x.rev_pct, "Rank by Rev Contrib": x.rev_rank, ...unitCols(x) }));
    const d = r.dependency.rows.map((x, i) => ({
      Rank: i + 1, FC: x.featurecode, Description: x.description, ...refCols(x), "Total TCE Configs WW": x.configs_ww,
      ...Object.fromEntries(geos.map(g => [g, x.configs[g] || 0])), "# of Geos": x.n_geos, "% of WW TCE Configs": x.pct,
      "Rev Contrib All WW (USD)": x.rev_all_usd_ww, ...Object.fromEntries(geos.map(g => [`Rev Contrib All ${g}`, x.rev_all_usd[g] || 0])),
      "Rev Contrib TCE Sel WW (USD)": x.rev_tce_usd_ww, ...Object.fromEntries(geos.map(g => [`Rev Contrib TCE Sel ${g}`, x.rev_tce_usd[g] || 0])),
      "TCE Sel / All": x.tce_share, "Rank by Rev Contrib TCE Sel": x.rev_tce_rank, ...unitCols(x) }));
    const files = geos.map(g => ({ geo: g, file: r.files[g], "Configs in scope (proximity)": r.proximity.configs_by_geo[g],
                                   "TCE configs in scope (dependency)": r.dependency.configs_by_geo[g] }));
    const label = r.filters.proximity === null ? "all" : [].concat(r.filters.proximity).join("-");
    return writeXlsx({ "WW Proximity Ranking": p, "WW Dependency Ranking": d, "Source files": files }, `TCE_WW_Ranking_prox${label}.xlsx`);
  }
  const m = /^\/api\/export\/quote\/(.+)\.xlsx$/.exec(path);
  if (m) {
    const quote = m[1], bid = qs.get("bid");
    const q = await api(`/api/quote/${encodeURIComponent(quote)}`);
    const rows = q.rows.filter(r => !bid || r.bid_item === bid).map(({ bid_item, ...r }) => r);
    return writeXlsx({ "Quote Detail": rows }, `Quote_${quote}${bid ? "_" + bid : ""}.xlsx`);
  }
  throw new ApiError(404, `Unknown export: ${path}`);
}

// ============================================================ ajustes: exportar / importar JSON
export function exportAdjustmentsFile() {
  const blob = new Blob([JSON.stringify({ version: 1, overrides: S().overrides(), history: S().history() }, null, 1)],
                        { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob); a.download = engine.currentSource() === "shipments" ? "tce_overrides_shipments.json" : "tce_overrides.json";
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
export async function importAdjustmentsFile(file) {
  let data;
  try { data = JSON.parse(await file.text()); } catch { throw new ApiError(400, "The file is not valid JSON."); }
  S().replaceAll(data);
  await engine.applyOverrides(S().mapping());
}

// ============================================================ apertura del archivo local
const IDB = { name: "tce-proximity", store: "handles" };
function idb(mode, fn) {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open(IDB.name, 1);
    open.onupgradeneeded = () => open.result.createObjectStore(IDB.store);
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const tx = open.result.transaction(IDB.store, mode);
      const req = fn(tx.objectStore(IDB.store));
      tx.oncomplete = () => resolve(req?.result);
      tx.onerror = () => reject(tx.error);
    };
  });
}
const saveHandle = (h, key = "last") => idb("readwrite", s => s.put(h, key)).catch(() => {});
export const lastHandle = (source = "quotes") => idb("readonly", s => s.get(source === "shipments" ? "last-ship" : "last")).catch(() => null);
export const lastWwHandles = () => idb("readonly", s => s.get("ww")).catch(() => null);
export const canPickFiles = () => typeof window.showOpenFilePicker === "function";
const PICKER_TYPES = [{ description: "Quotes data (.xlsx, .csv)", accept: {
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": [".xlsx"], "text/csv": [".csv"] } }];

/** Abre el selector de archivos del sistema (al cargarlo bien se recuerda para reabrirlo la próxima vez) */
let pendingHandle = null;
export async function pickFile() {
  const [h] = await window.showOpenFilePicker({ types: PICKER_TYPES, multiple: false });
  pendingHandle = h;
  return h.getFile();
}
async function granted(h) {
  return (await h.queryPermission?.({ mode: "read" })) === "granted" || (await h.requestPermission?.({ mode: "read" })) === "granted";
}
/** Reabre el último archivo (requiere un clic del usuario para el permiso de lectura) */
export async function reopenLast(source = "quotes") {
  const h = await lastHandle(source);
  if (!h || !(await granted(h))) return null;
  return h.getFile();
}
const fileBySource = { quotes: null, shipments: null };   // último archivo cargado de cada origen
export const loadFile = serial(loadFileImpl);
async function loadFileImpl(file) {
  const handle = pendingHandle;
  pendingHandle = null;
  try {
    const big = /\.xlsx$/i.test(file.name) && !(await engine.isCached(file));
    const m = await engine.loadFile(file, file.name, { onProgress: p => progress(`Reading ${file.name}… ${Math.round(100 * p)}%${big ? " (first time only; then it is cached in this browser)" : ""}`) });
    const source = engine.currentSource();
    if (source === "quotes") currentFileObj = file;
    fileBySource[source] = file;
    if (handle) await saveHandle(handle, source === "shipments" ? "last-ship" : "last");
    S().dropStale(engine.fcCsvMap(), file.name);
    return m;
  } catch (e) { throw new ApiError(422, e.message); }
}
/** Shipments: cambia la geo activa (el archivo ya está cargado en el navegador) */
export const selectGeo = serial(selectGeoImpl);
async function selectGeoImpl(geo) {
  try {
    const m = await engine.selectGeo(geo);
    S().dropStale(engine.fcCsvMap(), engine.shipFile());
    return m;
  } catch (e) { throw new ApiError(422, e.message); }
}
/** Vuelve a un origen ya abierto en esta sesión (true) o indica que hay que abrir un archivo (false) */
export const switchSource = serial(async (source, geo) => {
  if (source === engine.currentSource()) return true;
  if (source === "shipments" && engine.shipFile() && (!fileBySource.shipments || engine.shipFile() === fileBySource.shipments.name)) {
    await selectGeoImpl(geo || engine.SHIP_GEOS[0]); return true;
  }
  if (fileBySource[source]) { await loadFileImpl(fileBySource[source]); return true; }   // ej. shipments de la carpeta
  return false;
});

// ============================================================ carpeta de datos (CSV de las queries o .xlsx)
export const IMPORT_FORMATS = {
  csv: { label: "CSV (raw query output)", quotes: [".csv"], shipments: [".csv"] },
  xlsx: { label: "Excel workbooks (.xlsx)", quotes: [".xlsx"], shipments: [".xlsx", ".csv"] },
};
const QUOTE_COLS = engine.EXPECTED_COLUMNS, SHIP_COLS = engine.SHIP_COLUMNS;
const suffix = name => (/\.[^.]+$/.exec(name)?.[0] || "").toLowerCase();
/** CSV: encabezado (primera línea) y geo de las primeras filas, leyendo sólo el principio del archivo */
async function csvHead(file) {
  const text = await file.slice(0, 1 << 18).text();
  const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/);
  const split = l => { const out = []; let cur = "", q = false;
    for (let i = 0; i < l.length; i++) { const c = l[i];
      if (q) { if (c === '"') { if (l[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += c; }
      else if (c === '"') q = true; else if (c === ",") { out.push(cur); cur = ""; } else cur += c; }
    out.push(cur); return out; };
  const header = split(lines[0] || "");
  const gi = header.indexOf("geo"), count = {};
  if (gi >= 0) for (const l of lines.slice(1, -1)) { const g = split(l)[gi]; if (engine.GEOS.includes(g)) count[g] = (count[g] || 0) + 1; }
  const geo = Object.entries(count).sort((a, b) => b[1] - a[1])[0]?.[0] || "";
  return { header, sheets: [], geo };
}
/** Identifica los archivos de la carpeta (misma lógica que scan_folder en Python) */
export async function scanFiles(files, format = "csv", folderName = "") {
  const spec = IMPORT_FORMATS[format];
  if (!spec) throw new ApiError(400, `format must be one of: ${Object.keys(IMPORT_FORMATS).join(", ")}`);
  const list = [...files].filter(f => !f.name.startsWith("~$") && [".csv", ".xlsx"].includes(suffix(f.name)))
    .sort((a, b) => b.lastModified - a.lastModified);
  const quotes = {}, found = [], ignored = [];
  let shipments = null;
  const other = (kind, suf) => Object.keys(IMPORT_FORMATS).find(k => IMPORT_FORMATS[k][kind].includes(suf)) || "";
  for (const f of list) {
    const suf = suffix(f.name);
    let head;
    try { head = suf === ".csv" ? await csvHead(f) : { ...(await xlsxHeader(f)), geo: "" }; }
    catch (e) { ignored.push({ name: f.name, reason: `cannot be read (${e.message})` }); continue; }
    const size = Math.round(f.size / 1e5) / 10;
    const isSummary = head.sheets.some(s => s.toLowerCase().includes("ranking"));
    const isQuotes = QUOTE_COLS.every(c => head.header.includes(c));
    const isShip = SHIP_COLS.every(c => head.header.includes(c)) && !isSummary;
    const kind = isQuotes ? "quotes" : isShip ? "shipments" : null;
    if (kind && !spec[kind].includes(suf)) { ignored.push({ name: f.name, reason: `${kind} data as ${suf}: used with the ${other(kind, suf).toUpperCase()} format` }); continue; }
    if (isQuotes) {
      const geo = engine.geoFromName(f.name) || head.geo;
      if (!engine.GEOS.includes(geo)) { ignored.push({ name: f.name, reason: "quotes data, but the geo is unknown (name it 'NA ...', 'AP ...', 'LA ...' or 'EMEA ...')" }); continue; }
      const used = !(geo in quotes);
      if (used) quotes[geo] = f;
      found.push({ name: f.name, kind: "quotes", geo, size_mb: size, used });
    } else if (isShip) {
      const used = !shipments;
      shipments = shipments || f;
      found.push({ name: f.name, kind: "shipments", geo: "WW", size_mb: size, used });
    } else if (isSummary) ignored.push({ name: f.name, reason: "analysis workbook (ranking sheets); the app reproduces it" });
    else ignored.push({ name: f.name, reason: "not a quotes or shipments extraction (columns do not match)" });
  }
  const geos = engine.GEOS.filter(g => g in quotes);
  return {
    report: { folder: folderName, format, format_label: spec.label, quotes: Object.fromEntries(geos.map(g => [g, quotes[g].name])),
              missing_geos: engine.GEOS.filter(g => !(g in quotes)), shipments: shipments?.name ?? null, files: found, ignored },
    quoteFiles: geos.map(g => quotes[g]), shipmentsFile: shipments,
  };
}

let folder = null;   // carpeta activa: { name, format, report, quoteFiles }
export const currentFolder = () => folder;
const FORMAT_KEY = "tce_folder_format";
export const lastFolderFormat = () => { try { return localStorage.getItem(FORMAT_KEY) || "csv"; } catch { return "csv"; } };
export const lastFolderHandle = () => idb("readonly", s => s.get("dir")).catch(() => null);
export const canPickFolder = () => typeof window.showDirectoryPicker === "function";
async function dirFiles(dir) {
  const out = [];
  for await (const h of dir.values()) if (h.kind === "file") out.push(await h.getFile());
  return out;
}
/** Abre una carpeta (FileSystemDirectoryHandle o lista de archivos): identifica los archivos, carga quotes
 *  (la geo que estaba activa o NA) y deja shipments y el WW listos sin volver a elegir archivos. */
export const openFolder = serial(async (dirOrFiles, format = "csv", { remember = true } = {}) => {
  const isHandle = typeof dirOrFiles?.values === "function" && dirOrFiles.kind === "directory";
  const files = isHandle ? await dirFiles(dirOrFiles) : [...dirOrFiles];
  const name = isHandle ? dirOrFiles.name : (files[0]?.webkitRelativePath || "").split("/")[0] || "folder";
  const { report, quoteFiles, shipmentsFile } = await scanFiles(files, format, name);
  if (!quoteFiles.length && !shipmentsFile)
    throw new ApiError(422, `No ${format.toUpperCase()} quotes or shipments data files found in ${name}`);
  const prevGeo = engine.currentSource() === "quotes" ? engine.geoFromName(engine.currentFile() || "") : "";
  const start = quoteFiles.find(f => engine.geoFromName(f.name) === (prevGeo || "NA")) || quoteFiles[0];
  const wantShip = engine.currentSource() === "shipments" || !start;
  fileBySource.quotes = start || null;
  fileBySource.shipments = shipmentsFile || null;
  setWwFiles(quoteFiles);
  await loadFileImpl(wantShip && shipmentsFile ? shipmentsFile : start);
  folder = { name, format, report, quoteFiles };
  if (remember) {
    if (isHandle) await saveHandle(dirOrFiles, "dir");
    try { localStorage.setItem(FORMAT_KEY, format); } catch { /* sin storage */ }
  }
  return report;
});
/** Reabre la última carpeta (requiere un clic del usuario para el permiso de lectura) */
export async function reopenFolder(format) {
  const h = await lastFolderHandle();
  if (!h || !(await granted(h))) return null;
  return openFolder(h, format || lastFolderFormat());
}
/** Otra geo de quotes de la carpeta activa */
export const selectQuotesFile = serial(async name => {
  const f = folder?.quoteFiles.find(x => x.name === name);
  if (!f) throw new ApiError(404, `${name} not found in the folder`);
  fileBySource.quotes = f;
  return loadFileImpl(f);
});
export const currentSource = () => engine.currentSource();
export const currentGeo = () => engine.currentGeo();
export const SHIP_GEOS = engine.SHIP_GEOS;
export const initEngine = () => engine.init();

/** WW: el usuario elige los archivos de las geos (se recuerdan para la próxima vez) */
export async function pickWwFiles() {
  const hs = await window.showOpenFilePicker({ types: PICKER_TYPES, multiple: true });
  await saveHandle(hs, "ww");
  setWwFiles(await Promise.all(hs.map(h => h.getFile())));
}
export async function reopenWwFiles() {
  const hs = await lastWwHandles();
  if (!hs?.length) return false;
  for (const h of hs) if (!(await granted(h))) return false;
  setWwFiles(await Promise.all(hs.map(h => h.getFile())));
  return true;
}
export function setWwFiles(files) { wwFiles = [...files]; wwMemo = null; }
