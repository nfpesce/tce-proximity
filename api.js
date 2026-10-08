/* api.js — reemplaza al servidor FastAPI (app/main.py) dentro del navegador.
 *
 * Atiende las mismas rutas /api/... con las mismas respuestas, usando engine.js (DuckDB-WASM).
 * Así la interfaz (app.js) es prácticamente la misma que la de la versión Python.
 * Además: ajustes TCE guardados en el navegador (mismo formato que tce_overrides.json),
 * exportación a Excel (SheetJS) y apertura del CSV local (File System Access API o <input type=file>).
 */
import * as engine from "./engine.js";

const SHEETJS_URL = "https://cdn.sheetjs.com/xlsx-0.20.3/package/xlsx.mjs";

export class ApiError extends Error {
  constructor(status, detail) { super(detail); this.status = status; }
}

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
    if (tce === csvTce) {             // volver al valor del CSV = quitar el ajuste
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
  remove(fc, note = "") {
    const prev = this.data.overrides[fc];
    if (!prev) return false;
    delete this.data.overrides[fc];
    this.data.history.push({ ts: OverrideStore.now(), featurecode: fc, description: prev.description || "",
                             action: "revert", from: prev.tce, to: prev.csv_tce ?? null, note });
    this._write();
    return true;
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
export function useStore(s) { store = s; }          // los tests usan una clave propia

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
// filtros de selección múltiple de las vistas 1 y 4 (?country=A&country=B, etc.)
const multi = qs => Object.fromEntries(["product", "country", "forecast", "status"].map(k => [k, values(qs, k)]));

function adjustmentsPayload() {
  const items = Object.entries(store.overrides())
    .sort((a, b) => (a[1].updated < b[1].updated ? 1 : a[1].updated > b[1].updated ? -1 : 0))
    .map(([fc, o]) => ({ featurecode: fc, ...o, in_file: engine.fcExists(fc), csv_tce_current_file: engine.fcCsvTce(fc) }));
  return { file: engine.currentFile(), storage: "this browser", adjustments: items,
           history: store.history().reverse().slice(0, 200) };
}

/** Atiende una ruta de la API. Devuelve el JSON o lanza ApiError(status, detail). */
export async function api(url, opts = {}) {
  const u = new URL(url, location.href);
  const path = u.pathname.replace(/^.*?\/api\//, "/api/");
  const qs = u.searchParams, method = (opts.method || "GET").toUpperCase();
  const body = opts.body ? JSON.parse(opts.body) : null;
  const seg = path.split("/").filter(Boolean).map(decodeURIComponent);   // ["api", ...]

  if (!engine.currentFile()) throw new ApiError(404, "No data loaded. Open a CSV file.");
  await engine.applyOverrides(store.mapping());
  try {
    if (method === "GET" && path === "/api/meta") {
      const m = await engine.meta();
      m.adjustments = Object.entries(store.overrides()).map(([fc, o]) => ({ featurecode: fc, from: o.csv_tce ?? null, to: o.tce }));
      return m;
    }
    if (method === "GET" && path === "/api/ranking")
      return engine.ranking(opt(param(qs, "express", "No")), opt(param(qs, "currency", "USD")), tceParam(param(qs, "tce", "N")), multi(qs));
    if (method === "GET" && path === "/api/bids")
      return engine.bids(opt(param(qs, "express", "No")), opt(param(qs, "currency", "USD")), tceParam(param(qs, "tce", "N")), multi(qs));
    if (method === "GET" && seg[1] === "quote" && seg.length === 3) {
      const q = await engine.quoteDetail(seg[2]);
      if (!q) throw new ApiError(404, `Quote ${seg[2]} not found`);
      return q;
    }
    if (method === "GET" && path === "/api/search") return engine.searchQuotes(param(qs, "q", ""));
    if (method === "GET" && path === "/api/fc-ranking") {
      const p = param(qs, "proximity", "1");
      if (!/^\d+$/.test(p) || Number(p) < 1) throw new ApiError(422, "proximity must be an integer >= 1");
      return await engine.fcRanking(Number(p), param(qs, "criteria", "exactly"), opt(param(qs, "express", "No")),
                                    opt(param(qs, "currency", "USD")), products(qs));
    }
    if (method === "GET" && path === "/api/fc-search") return engine.searchFc(param(qs, "q", ""));
    if (method === "GET" && seg[1] === "fc" && seg.length === 3) {
      const r = await engine.fcLookup(seg[2], opt(param(qs, "express", "No")), opt(param(qs, "currency", "USD")));
      if (!r) throw new ApiError(404, `Feature code ${seg[2]} not found in ${engine.currentFile()}`);
      r.adjustment = store.overrides()[r.featurecode] ?? null;
      return r;
    }
    if (method === "GET" && path === "/api/adjustments") return adjustmentsPayload();
    if (seg[1] === "adjustments" && seg.length === 3) {
      if (method === "PUT") {
        const info = await engine.fcLookup(seg[2], null, null);
        if (!info) throw new ApiError(404, `Feature code ${seg[2]} not found in ${engine.currentFile()}`);
        const fc = info.featurecode;
        store.set(fc, body?.tce, engine.fcCsvTce(fc), engine.fcDescription(fc), String(body?.note ?? "").trim());
        await engine.applyOverrides(store.mapping());
        return adjustmentsPayload();
      }
      if (method === "DELETE") {
        if (!store.remove(seg[2])) throw new ApiError(404, `No active adjustment for ${seg[2]}`);
        await engine.applyOverrides(store.mapping());
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

// ============================================================ exportación a Excel
let XLSX = null;
async function sheetjs() { return XLSX || (XLSX = await import(SHEETJS_URL)); }

async function writeXlsx(sheets, filename) {
  const X = await sheetjs();
  const adj = store.overrides();
  if (Object.keys(adj).length) {   // deja registrado que la base tiene ajustes
    sheets = { ...sheets, "TCE Adjustments": Object.entries(adj).map(([fc, o]) => ({
      featurecode: fc, description: o.description || "", "TCE in CSV": o.csv_tce ?? null,
      "TCE adjusted": o.tce, note: o.note || "", updated: o.updated })) };
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

/** Genera la exportación que corresponde a una URL /api/export/... (mismas hojas que la versión Python) */
export async function exportUrl(url) {
  const u = new URL(url, location.href), qs = u.searchParams;
  const path = decodeURIComponent(u.pathname.replace(/^.*?\/api\//, "/api/"));
  const base = new URL(url, location.href);
  base.pathname = base.pathname.replace("/export/", "/").replace(/\.xlsx$/, "");
  if (path === "/api/export/ranking.xlsx") {
    const r = await api(base.href);
    const rows = r.opps.flatMap(o => o.quotes.flatMap(q => q.bids.map(b => ({
      opp_number: o.opp_number, forecast_category_name: o.forecast, account: o.account, opp_total: o.total, quotenumber: q.quotenumber,
      Bid_Item: b.bid_item, product: b.product, "TCE Proximity": b.proximity }))));
    return writeXlsx({ "TCE Proximity": rows }, "TCE_Proximity_ranking.xlsx");
  }
  if (path === "/api/export/bids.xlsx") return writeXlsx({ Bids: await api(base.href) }, "TCE_Proximity_bids.xlsx");
  if (path === "/api/export/fc-ranking.xlsx") {
    const r = await api(base.href);
    return writeXlsx({
      "FC ranking": r.rows.map(x => ({ featurecode: x.featurecode, description: x.description, configs: x.configs })),
      Configs: r.rows.flatMap(x => x.bids.map(b => ({ featurecode: x.featurecode, ...b }))),
    }, `TCE_by_FC_${r.filters.criteria}_${r.filters.proximity}.xlsx`);
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
  const blob = new Blob([JSON.stringify({ version: 1, overrides: store.overrides(), history: store.history() }, null, 1)],
                        { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob); a.download = "tce_overrides.json";
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
export async function importAdjustmentsFile(file) {
  let data;
  try { data = JSON.parse(await file.text()); } catch { throw new ApiError(400, "The file is not valid JSON."); }
  store.replaceAll(data);
  await engine.applyOverrides(store.mapping());
}

// ============================================================ apertura del CSV local
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
const saveHandle = h => idb("readwrite", s => s.put(h, "last")).catch(() => {});
export const lastHandle = () => idb("readonly", s => s.get("last")).catch(() => null);
export const canPickFiles = () => typeof window.showOpenFilePicker === "function";

/** Abre el selector de archivos del sistema (recuerda el archivo para reabrirlo la próxima vez) */
export async function pickFile() {
  const [h] = await window.showOpenFilePicker({
    types: [{ description: "Quotes CSV", accept: { "text/csv": [".csv"] } }], multiple: false });
  await saveHandle(h);
  return h.getFile();
}
/** Reabre el último archivo (requiere un clic del usuario para el permiso de lectura) */
export async function reopenLast() {
  const h = await lastHandle();
  if (!h) return null;
  if ((await h.queryPermission?.({ mode: "read" })) !== "granted"
      && (await h.requestPermission?.({ mode: "read" })) !== "granted") return null;
  return h.getFile();
}
export async function loadFile(file) {
  try { return await engine.loadFile(file); }
  catch (e) { throw new ApiError(422, e.message); }
}
export const initEngine = () => engine.init();
