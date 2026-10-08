/* engine.js — motor de datos que corre en el navegador (DuckDB-WASM).
 *
 * Réplica fiel de app/data.py (versión Python): mismos cálculos, mismos órdenes y desempates.
 * El CSV se lee directamente desde el disco del usuario: nunca se sube a ningún servidor.
 *
 * TCE Proximity de un bid-item = cantidad de líneas (filas de FC) con TCE = "N".
 * `tce` es el valor efectivo (CSV + ajustes manuales); `tce_csv` el original del archivo.
 */
import * as duckdb from "https://cdn.jsdelivr.net/npm/@duckdb/duckdb-wasm@1.32.0/+esm";

export const EXPECTED_COLUMNS = [
  "quotenumber", "status", "customercontractno", "geo", "country", "featurecode",
  "description", "TCE_Actual", "quantity", "quotelines_quantity", "contractstartdate",
  "opp_number", "forecast_category_name", "quotelines_productcategoryname_2",
  "quotelines_productcategoryname_3", "bid_PN", "quotelines_custompn", "Bid_Item",
  "quotetype", "fulfillmentmethod", "dealreg", "quotelines_marketingdesc", "end_customer",
  "opportunities_parentaccountidname", "createddate", "soldto", "sales_rep_name",
  "currency", "exchangerate", "totalfinalprice", "totaltmc", "quotelines_margin",
  "quotelines_salesprice", "cost_tmc", "uncoveredaccount", "Bid_Item_Is_Express",
];
export const TCE_VALUES = ["N", "Y", "Not Mapped"];
export const NO_OPP = "(no opp)";
export const NO_ACCOUNT = "(no account)";
export const BLANK = "(blank)";   // valor vacío en los filtros de selección múltiple

// Filtros de selección múltiple (como MULTI_FILTERS en app/data.py): nombre en la API -> columna de `raw`
const MULTI_FILTERS = { product: "product", country: "country", forecast: "forecast", status: "status" };
// Orden de las opciones de forecast (como FORECAST_ORDER en app/data.py); otros valores al final, alfabéticos
const FORECAST_ORDER = [BLANK, "Pipeline", "Best Case", "Commit", "Won"].map(x => x.toLowerCase());
const forecastRank = v => { const i = FORECAST_ORDER.indexOf(String(v).toLowerCase()); return i < 0 ? FORECAST_ORDER.length : i; };

export class DataError extends Error {}

// ------------------------------------------------------------------ utils
const sq = v => "'" + String(v).replaceAll("'", "''") + "'";          // literal SQL
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);                      // como sorted() de Python
const num = x => (x === null || x === undefined || Number.isNaN(x)) ? null
  : Number.isInteger(x) ? x : Math.round(x * 100) / 100;               // _num() de Python

/** "XXXXX000000001-12" -> 12 (9999 si no hay sufijo numérico) */
export function itemNumber(bidItem) {
  const parts = String(bidItem).split("-");
  if (parts.length < 2) return 9999;
  const t = parts[parts.length - 1].trim();
  return /^[+-]?\d+$/.test(t) ? parseInt(t, 10) : 9999;
}
const itemLabel = bid => `item-${String(bid).split("-").pop()}`;

/** Clave para ordenar quotes por su parte numérica final (los prefijos alfabéticos no cuentan) */
function quoteKeyCmp(a, b) {            // descendente, como sort(reverse=True) en Python
  const ka = /(\d{9})$/.exec(a), kb = /(\d{9})$/.exec(b);
  const na = ka ? parseInt(ka[1], 10) : -1, nb = kb ? parseInt(kb[1], 10) : -1;
  return (nb - na) || cmp(b, a);
}

// ------------------------------------------------------------------ estado
let db = null, conn = null, seq = 0;
let ds = null;   // dataset activo: { name, reg, rows, fcCsvTce, fcDescription, quotes, bidFirst, overrides }

export function currentFile() { return ds?.name ?? null; }

export async function init() {
  if (db) return;
  const bundle = await duckdb.selectBundle(duckdb.getJsDelivrBundles());
  const workerUrl = URL.createObjectURL(new Blob([`importScripts("${bundle.mainWorker}");`], { type: "text/javascript" }));
  db = new duckdb.AsyncDuckDB(new duckdb.VoidLogger(), new Worker(workerUrl));
  await db.instantiate(bundle.mainModule, bundle.pthreadWorker);
  URL.revokeObjectURL(workerUrl);
  conn = await db.connect();
}

async function rows(sql) {
  const t = await conn.query(sql);
  return t.toArray().map(r => r.toJSON());
}

// ------------------------------------------------------------------ carga
/** Carga un CSV (File/Blob). Valida columnas y valores de TCE_Actual como la versión Python. */
export async function loadFile(file, name = file.name) {
  await init();
  const reg = `src_${++seq}.csv`;
  await db.registerFileHandle(reg, file, duckdb.DuckDBDataProtocol.BROWSER_FILEREADER, true);
  const src = `read_csv(${sq(reg)}, header=true, all_varchar=true, delim=',', quote='"', escape='"')`;
  try {
    const header = (await rows(`DESCRIBE SELECT * FROM ${src}`)).map(r => r.column_name);
    const missing = EXPECTED_COLUMNS.filter(c => !header.includes(c));
    if (missing.length) throw new DataError(`Missing columns in ${name}: ${missing.join(", ")}`);

    const v = c => `COALESCE("${c}", '')`;
    await conn.query(`CREATE OR REPLACE TABLE raw_new AS SELECT
        (row_number() OVER ()) - 1 AS rid,
        ${v("quotenumber")} AS quotenumber, ${v("status")} AS status, ${v("country")} AS country,
        ${v("featurecode")} AS featurecode, ${v("description")} AS description,
        ${v("TCE_Actual")} AS tce_csv, ${v("TCE_Actual")} AS tce,
        COALESCE(TRY_CAST("quantity" AS DOUBLE), 0) AS quantity,
        TRY_CAST("quotelines_quantity" AS DOUBLE) AS quotelines_quantity,
        ${v("contractstartdate")} AS contractstartdate, ${v("opp_number")} AS opp_number,
        ${v("forecast_category_name")} AS forecast, ${v("quotelines_productcategoryname_3")} AS product,
        ${v("bid_PN")} AS bid_pn, ${v("Bid_Item")} AS bid_item, ${v("quotetype")} AS quotetype,
        ${v("fulfillmentmethod")} AS fulfillment, ${v("end_customer")} AS end_customer,
        ${v("opportunities_parentaccountidname")} AS account, ${v("createddate")} AS created,
        ${v("sales_rep_name")} AS sales_rep, ${v("currency")} AS currency,
        TRY_CAST("totalfinalprice" AS DOUBLE) AS totalfinalprice,
        ${v("Bid_Item_Is_Express")} AS express,
        CASE WHEN ${v("opp_number")} = '' THEN ${sq(NO_OPP)} ELSE "opp_number" END AS opp_label,
        CASE WHEN ${v("opportunities_parentaccountidname")} = '' THEN ${sq(NO_ACCOUNT)}
             ELSE "opportunities_parentaccountidname" END AS account_label
      FROM ${src}`);
    const n = (await rows(`SELECT CAST(count(*) AS INTEGER) n FROM raw_new`))[0].n;
    if (!n) throw new DataError(`${name} has no rows`);
    const bad = (await rows(`SELECT DISTINCT tce_csv v FROM raw_new WHERE tce_csv NOT IN ('N', 'Y', 'Not Mapped') ORDER BY 1`))
      .map(r => r.v);
    if (bad.length) throw new DataError(`Unrecognized TCE_Actual values: ${bad.join(", ")}`);
  } catch (e) {
    await conn.query("DROP TABLE IF EXISTS raw_new");
    await db.dropFile(reg);
    throw e instanceof DataError ? e : new DataError(`Cannot read ${name}: ${e.message || e}`);
  }
  await conn.query("DROP TABLE IF EXISTS raw");
  await conn.query("ALTER TABLE raw_new RENAME TO raw");
  if (ds?.reg) await db.dropFile(ds.reg);

  // Cachés (como los diccionarios de Dataset en Python)
  const fc = await rows(`SELECT featurecode, arg_min(description, rid) AS d, arg_min(tce_csv, rid) AS t, min(rid) AS r
                         FROM raw GROUP BY featurecode ORDER BY r`);
  const firsts = await rows(`SELECT * FROM raw WHERE rid IN (SELECT min(rid) FROM raw GROUP BY bid_item)`);
  ds = {
    name, reg,
    fcCsvTce: new Map(fc.map(r => [r.featurecode, r.t])),
    fcDescription: new Map(fc.map(r => [r.featurecode, r.d])),
    quotes: (await rows(`SELECT DISTINCT quotenumber q FROM raw`)).map(r => r.q),
    bidFirst: new Map(firsts.map(r => [r.bid_item, r])),
    overrides: {},
  };
  return meta();
}

function need() { if (!ds) throw new DataError("No data loaded. Open a CSV file."); return ds; }

// ------------------------------------------------------------------ ajustes
/** Aplica ajustes de TCE por feature code ({fc: 'Y'|'N'|'Not Mapped'}) sin tocar el CSV. */
export async function applyOverrides(overrides) {
  need();
  const o = Object.fromEntries(Object.entries(overrides).filter(([, v]) => TCE_VALUES.includes(v)));
  const same = Object.keys(o).length === Object.keys(ds.overrides).length
    && Object.entries(o).every(([k, v]) => ds.overrides[k] === v);
  if (same) return;
  await conn.query("UPDATE raw SET tce = tce_csv WHERE tce <> tce_csv");
  const entries = Object.entries(o);
  if (entries.length) {
    await conn.query(`CREATE OR REPLACE TEMP TABLE ov AS SELECT * FROM (VALUES ${entries.map(([k, v]) => `(${sq(k)}, ${sq(v)})`).join(", ")}) t(fc, tce)`);
    await conn.query("UPDATE raw SET tce = ov.tce FROM ov WHERE raw.featurecode = ov.fc");
  }
  ds.overrides = o;
}

export function fcExists(fc) { return need().fcCsvTce.has(fc); }
export function fcCsvTce(fc) { return need().fcCsvTce.get(fc) ?? null; }
export function fcDescription(fc) { return need().fcDescription.get(fc) ?? ""; }

// ------------------------------------------------------------------ meta
export async function meta() {
  need();
  const m = (await rows(`SELECT CAST(count(*) AS INTEGER) AS n_rows,
      CAST(count(DISTINCT quotenumber) AS INTEGER) AS quotes, CAST(count(DISTINCT bid_item) AS INTEGER) AS bids,
      min(contractstartdate) FILTER (WHERE contractstartdate <> '') AS dmin,
      max(contractstartdate) FILTER (WHERE contractstartdate <> '') AS dmax FROM raw`))[0];
  const distinct = async col => (await rows(`SELECT DISTINCT ${col} v FROM raw`)).map(r => r.v).sort(cmp);
  const distinctBlank = async col => (await rows(`SELECT DISTINCT ${col} v FROM raw`)).map(r => r.v || BLANK).sort(cmp);
  const counts = Object.fromEntries(TCE_VALUES.map(v => [v, 0]));
  for (const r of await rows(`SELECT tce, CAST(count(*) AS INTEGER) n FROM raw GROUP BY tce`)) counts[r.tce] = r.n;
  return {
    file: ds.name, rows: m.n_rows, quotes: m.quotes, bids: m.bids,
    contract_start_min: m.dmin ?? null, contract_start_max: m.dmax ?? null,
    express_values: await distinct("express"), currency_values: await distinct("currency"),
    tce_counts: counts, product_values: await distinct("product"),
    country_values: await distinctBlank("country"), forecast_values: (await distinctBlank("forecast")).sort((a, b) => forecastRank(a) - forecastRank(b) || cmp(a, b)),
    status_values: await distinctBlank("status"),
  };
}

// ------------------------------------------------------------------ helpers
function where({ express, currency, tce, products, multi = {} } = {}) {
  const w = ["TRUE"];
  if (tce) {
    if (!TCE_VALUES.includes(tce)) throw new DataError(`TCE_Actual must be one of: ${TCE_VALUES.join(", ")}`);
    w.push(`tce = ${sq(tce)}`);
  }
  if (express) w.push(`express = ${sq(express)}`);
  if (currency) w.push(`currency = ${sq(currency)}`);
  if (products && products.length) w.push(`product IN (${products.map(sq).join(", ")})`);
  for (const [k, vals] of Object.entries(multi))
    if (vals && vals.length) w.push(`${MULTI_FILTERS[k]} IN (${vals.map(v => sq(v === BLANK ? "" : v)).join(", ")})`);
  return w.join(" AND ");
}

/** Una fila por bid-item con su proximity (sólo los que tienen >= 1 línea con TCE = tce), en orden de aparición */
async function bidTable(express, currency, tce = "N", multi = {}) {
  return rows(`SELECT opp_label, account_label, quotenumber, bid_item, product,
                 CAST(count(*) AS INTEGER) AS proximity, min(rid) AS r
               FROM raw WHERE ${where({ express, currency, tce, multi })}
               GROUP BY opp_label, account_label, quotenumber, bid_item, product ORDER BY r`);
}

// ---------------------------------------------------------- 1. ranking
// multi: { product, country, forecast, status } -> lista de valores o null (sin filtro)
const multiOut = multi => Object.fromEntries(Object.keys(MULTI_FILTERS).map(k => [k, multi[k] && multi[k].length ? multi[k] : null]));

export async function ranking(express = "No", currency = "USD", tce = "N", multi = {}) {
  need();
  const g = await bidTable(express, currency, tce, multi);
  g.forEach(x => (x._item = itemNumber(x.bid_item)));
  g.sort((a, b) => a.proximity - b.proximity || a._item - b._item);   // estable

  const tree = new Map();
  for (const x of g) {
    const key = x.opp_label + "\u0000" + x.account_label;
    // forecast_category_name es constante por quote y por oportunidad
    if (!tree.has(key)) tree.set(key, { opp: x.opp_label, account: x.account_label, q: new Map(),
                                        forecast: ds.bidFirst.get(x.bid_item)?.forecast ?? "" });
    const qmap = tree.get(key).q;
    if (!qmap.has(x.quotenumber)) qmap.set(x.quotenumber, []);
    qmap.get(x.quotenumber).push({ bid_item: x.bid_item, product: x.product, proximity: x.proximity });
  }
  const opps = [];
  for (const { opp, account, q, forecast } of tree.values()) {
    const quotes = [...q.entries()].map(([quotenumber, bids]) =>
      ({ quotenumber, total: bids.reduce((a, b) => a + b.proximity, 0), bids }));
    quotes.sort((a, b) => quoteKeyCmp(a.quotenumber, b.quotenumber));
    const all = quotes.flatMap(x => x.bids);
    opps.push({ opp_number: opp, account, forecast: opp === NO_OPP ? "" : forecast, total: quotes.reduce((a, x) => a + x.total, 0),
                min_proximity: Math.min(...all.map(b => b.proximity)), n_bids: all.length, quotes });
  }
  opps.sort((a, b) => ((a.opp_number === NO_OPP) - (b.opp_number === NO_OPP)) || (a.total - b.total)
    || cmp(a.opp_number, b.opp_number) || cmp(a.account, b.account));

  const withOpp = g.filter(x => x.opp_label !== NO_OPP);
  const dist = {};
  for (const p of [...new Set(g.map(x => x.proximity))].sort((a, b) => a - b))
    dist[String(p)] = g.filter(x => x.proximity === p).length;
  return {
    filters: { express, currency, tce, ...multiOut(multi) },
    summary: {
      opps: new Set(withOpp.map(x => x.opp_label)).size,
      quotes: new Set(g.map(x => x.quotenumber)).size,
      bids: g.length, bids_with_opp: withOpp.length, bids_without_opp: g.length - withOpp.length,
      distribution: dist,
    },
    opps,
  };
}

// ------------------------------------------------------------ bids flat
export async function bids(express = "No", currency = "USD", tce = "N", multi = {}) {
  need();
  const g = await bidTable(express, currency, tce, multi);
  g.forEach(x => (x._item = itemNumber(x.bid_item)));
  g.sort((a, b) => a.proximity - b.proximity || cmp(a.quotenumber, b.quotenumber) || a._item - b._item);
  // tot_lines_qty = suma de quotelines_quantity de todos los bid-items del quote (sin filtros)
  const totQty = new Map();
  for (const f of ds.bidFirst.values()) {
    const v = f.quotelines_quantity;
    totQty.set(f.quotenumber, (totQty.get(f.quotenumber) ?? 0) + (v === null || v === undefined || Number.isNaN(v) ? 0 : v));
  }
  return g.map((x, i) => {
    const f = ds.bidFirst.get(x.bid_item) || {};
    return {
      rank: i + 1, bid_item: x.bid_item, quotenumber: x.quotenumber,
      opp_number: x.opp_label, account: x.account_label, product: x.product, bid_pn: f.bid_pn ?? "",
      proximity: x.proximity, forecast: f.forecast ?? "", sales_rep: f.sales_rep ?? "",
      country: f.country ?? "", status: f.status ?? "", contract_start: f.contractstartdate ?? "",
      quotelines_quantity: num(f.quotelines_quantity ?? null), tot_lines_qty: num(totQty.get(x.quotenumber) ?? null),
      total_final_price: num(f.totalfinalprice), end_customer: f.end_customer ?? "",
    };
  });
}

// ------------------------------------------------------ 2. quote detail
export async function quoteDetail(quote) {
  need();
  quote = String(quote).trim();
  if (!ds.quotes.includes(quote)) return null;
  const q = await rows(`SELECT * FROM raw WHERE quotenumber = ${sq(quote)} ORDER BY rid`);

  // Orden de los niveles = primera aparición dentro del quote (como groupby(sort=False) + unstack en pandas)
  const firstPos = col => { const m = new Map(); q.forEach((r, i) => { if (!m.has(r[col])) m.set(r[col], i); }); return m; };
  const fcPos = firstPos("featurecode"), descPos = firstPos("description"), bidPos = firstPos("bid_item");

  const groups = new Map();
  for (const r of q) {
    const key = [r.bid_item, r.bid_pn, r.product, r.express, r.featurecode, r.description].join("\u0000");
    if (!groups.has(key)) groups.set(key, { r, N: 0, Y: 0, NM: 0, qlq: null });
    const g = groups.get(key);
    // quotelines_quantity: constante por bid-item; max() como en pandas (ignora vacíos)
    const qq = r.quotelines_quantity;
    if (qq !== null && qq !== undefined && !Number.isNaN(qq) && (g.qlq === null || qq > g.qlq)) g.qlq = qq;
    if (r.tce === "N") g.N += r.quantity; else if (r.tce === "Y") g.Y += r.quantity; else g.NM += r.quantity;
  }
  const list = [...groups.values()];
  list.sort((a, b) => (bidPos.get(a.r.bid_item) - bidPos.get(b.r.bid_item))
    || (fcPos.get(a.r.featurecode) - fcPos.get(b.r.featurecode))
    || (descPos.get(a.r.description) - descPos.get(b.r.description)));
  list.sort((a, b) => (itemNumber(a.r.bid_item) - itemNumber(b.r.bid_item)) || (b.N - a.N) || (b.Y - a.Y) || (b.NM - a.NM));
  const rowsOut = list.map(({ r, N, Y, NM, qlq }) => ({
    item: itemLabel(r.bid_item), bid_item: r.bid_item, bid_pn: r.bid_pn, product: r.product, express: r.express,
    featurecode: r.featurecode, description: r.description, quotelines_quantity: num(qlq), N: num(N), Y: num(Y), "Not Mapped": num(NM),
    adjusted_from: r.featurecode in ds.overrides ? (ds.fcCsvTce.get(r.featurecode) ?? null) : null,
  }));

  const byBid = new Map();
  for (const r of q) { if (!byBid.has(r.bid_item)) byBid.set(r.bid_item, []); byBid.get(r.bid_item).push(r); }
  const bidsOut = [...byBid.entries()].map(([b, br]) => ({
    bid_item: b, item: itemLabel(b), product: br[0].product, bid_pn: br[0].bid_pn, express: br[0].express,
    proximity: br.filter(r => r.tce === "N").length,
    lines: Object.fromEntries(TCE_VALUES.map(v => [v, br.filter(r => r.tce === v).length])),
  }));
  bidsOut.sort((a, b) => itemNumber(a.bid_item) - itemNumber(b.bid_item));

  const f = q[0];
  return {
    quote,
    header: {
      opp_number: f.opp_number, account: f.account, status: f.status, country: f.country, currency: f.currency,
      sales_rep: f.sales_rep, end_customer: f.end_customer, forecast: f.forecast,
      contract_start: f.contractstartdate, created: f.created, quotetype: f.quotetype,
      fulfillment: f.fulfillment, total_final_price: num(f.totalfinalprice),
    },
    bids: bidsOut,
    rows: rowsOut,
  };
}

export function searchQuotes(text, limit = 15) {
  need();
  const t = String(text).trim().toUpperCase();
  if (!t) return [];
  const exact = ds.quotes.filter(x => x.toUpperCase() === t);
  const rest = ds.quotes.filter(x => x.toUpperCase().includes(t) && x.toUpperCase() !== t).sort(cmp);
  return exact.concat(rest).slice(0, limit);
}

// ---------------------------------------------------- 3. FC ranking
// proximity: un valor o una lista (selección múltiple); null = todas. "up to" = k <= máximo de la lista
export async function fcRanking(proximity = 1, criteria = "exactly", express = "No", currency = "USD", products = null) {
  need();
  criteria = String(criteria).toLowerCase();
  if (criteria !== "exactly" && criteria !== "up to") throw new DataError("criteria must be 'exactly' or 'up to'");
  const prox = proximity === null || proximity === undefined ? null
    : [...new Set([].concat(proximity).map(Number))].sort((a, b) => a - b);
  const cond = !prox || !prox.length ? "TRUE"
    : criteria === "up to" ? `k.k <= ${Math.max(...prox)}` : `k.k IN (${prox.join(", ")})`;
  const kSql = `WITH n AS (SELECT rid, bid_item, featurecode, description, quotenumber, opp_label, account_label, product
                           FROM raw WHERE ${where({ express, currency, tce: "N", products })}),
                     k AS (SELECT bid_item, CAST(count(*) AS INTEGER) AS k FROM n GROUP BY bid_item)`;
  const n = await rows(`${kSql} SELECT n.*, k.k FROM n JOIN k USING (bid_item) WHERE ${cond} ORDER BY n.rid`);
  const proxValues = (await rows(`${kSql} SELECT DISTINCT k FROM k ORDER BY k`)).map(r => r.k);
  const seen = new Set(), scope = [];
  for (const r of n) {
    const key = r.bid_item + "\u0000" + r.featurecode + "\u0000" + r.description;
    if (!seen.has(key)) { seen.add(key); scope.push(r); }
  }
  const byFc = new Map();
  for (const r of scope) { if (!byFc.has(r.featurecode)) byFc.set(r.featurecode, []); byFc.get(r.featurecode).push(r); }
  const fcs = [...byFc.entries()].map(([fc, list]) => ({ fc, list }));
  fcs.sort((a, b) => (b.list.length - a.list.length) || cmp(a.fc, b.fc));
  return {
    filters: { proximity: prox && prox.length ? (prox.length === 1 ? prox[0] : prox) : null, criteria, express, currency,
               product: products && products.length ? products : null },
    proximity_values: proxValues,
    configs_in_scope: new Set(scope.map(r => r.bid_item)).size,
    lines_in_scope: scope.length,
    rows: fcs.map(({ fc, list }) => ({
      featurecode: fc, description: list[0].description, configs: list.length,
      bids: list.map(b => ({ bid_item: b.bid_item, quotenumber: b.quotenumber, opp_number: b.opp_label,
                             account: b.account_label, product: b.product, proximity: b.k })),
    })),
  };
}

// ------------------------------------------------------ 5. adjustments
function fcSummary(fc) {
  const csv = ds.fcCsvTce.get(fc) ?? null;
  return { featurecode: fc, description: ds.fcDescription.get(fc) ?? "", csv_tce: csv,
           tce: fc in ds.overrides ? ds.overrides[fc] : csv, adjusted: fc in ds.overrides };
}

export function searchFc(text, limit = 25) {
  need();
  const t = String(text).trim().toUpperCase();
  if (!t) return [];
  const exact = [], prefix = [], desc = [];
  for (const [fc, d] of ds.fcDescription) {
    const u = fc.toUpperCase();
    if (u === t) exact.push(fc);
    else if (u.startsWith(t)) prefix.push(fc);
    else if (d.toUpperCase().includes(t)) desc.push(fc);
  }
  return exact.concat(prefix.sort(cmp), desc.sort(cmp)).slice(0, limit).map(fcSummary);
}

/** Ficha de un FC: valor TCE (CSV y efectivo), uso e impacto de cambiarlo sobre la clasificación */
export async function fcLookup(code, express = "No", currency = "USD") {
  need();
  let fc = String(code).trim();
  if (!ds.fcCsvTce.has(fc)) {
    const match = [...ds.fcCsvTce.keys()].find(k => k.toUpperCase() === fc.toUpperCase());
    if (!match) return null;
    fc = match;
  }
  const f = sq(fc), w = where({ express, currency });
  const usage = (await rows(`SELECT CAST(count(*) AS INTEGER) AS lines, CAST(count(DISTINCT quotenumber) AS INTEGER) AS quotes,
                               CAST(count(DISTINCT bid_item) AS INTEGER) AS bids FROM raw WHERE featurecode = ${f}`))[0];
  const descriptions = (await rows(`SELECT DISTINCT description d FROM raw WHERE featurecode = ${f}`)).map(r => r.d).sort(cmp);
  const per = await rows(`WITH fl AS (SELECT bid_item, CAST(count(*) AS INTEGER) AS l FROM raw
                                      WHERE featurecode = ${f} AND ${w} GROUP BY bid_item),
                               nk AS (SELECT bid_item, CAST(count(*) AS INTEGER) AS k FROM raw
                                      WHERE tce = 'N' AND ${w} AND bid_item IN (SELECT bid_item FROM fl) GROUP BY bid_item)
                          SELECT fl.bid_item, fl.l, COALESCE(nk.k, 0) AS k FROM fl LEFT JOIN nk USING (bid_item)`);
  const current = fc in ds.overrides ? ds.overrides[fc] : ds.fcCsvTce.get(fc);
  const impact = {};
  for (const target of TCE_VALUES) {
    let changed = 0, ready = 0, enter = 0, p1 = 0;
    for (const { l, k } of per) {
      const delta = l * ((target === "N") - (current === "N"));
      const kNew = k + delta;
      if (delta !== 0) changed++;
      if (k > 0 && kNew === 0) ready++;
      if (k === 0 && kNew > 0) enter++;
      if (kNew === 1) p1++;
    }
    impact[target] = { bids_changed: changed, become_tce_ready: ready, enter_ranking: enter, proximity_1_after: p1 };
  }
  return {
    ...fcSummary(fc), descriptions,
    usage: { lines: usage.lines, quotes: usage.quotes, bids: usage.bids,
             bids_in_scope: per.length, bids_in_scope_in_ranking: per.filter(x => x.k > 0).length },
    scope: { express, currency },
    impact,
  };
}
