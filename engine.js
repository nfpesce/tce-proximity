/* engine.js — motor de datos que corre en el navegador (DuckDB-WASM).
 *
 * Réplica fiel de app/data.py (versión Python): mismos cálculos, mismos órdenes y desempates.
 * El archivo (.xlsx de la extracción LUDP o .csv) se lee directamente desde el disco del usuario:
 * nunca se sube a ningún servidor. Los .xlsx convertidos se guardan como Parquet en IndexedDB
 * (por nombre, tamaño y fecha) para que la segunda apertura sea inmediata.
 *
 * TCE Proximity de un bid-item = cantidad de líneas (filas de FC) con TCE = "N".
 * `tce` es el valor efectivo (archivo + ajustes manuales); `tce_csv` el original del archivo.
 * Valor del bid-item (USD) = bid_item_value_usd (o salesprice x quotelines_quantity / exchangerate).
 * Revenue contribution de un FC = suma del valor de los bid-items que lo contienen; "TCE Sel" = sólo los full TCE.
 *
 * Shipments (CSV de la query Magellan, un archivo con todas las geos): se normaliza al mismo esquema
 * (SBB -> featurecode, mfgsoline -> bid_item, SO -> quotenumber, sbb_tce_flag -> TCE; como normalize_shipments
 * en Python) en la tabla `ship_all` (sin PRC) y `raw` es la geo elegida (selectGeo). El WW recorre las 5 geos.
 */
import * as duckdb from "https://cdn.jsdelivr.net/npm/@duckdb/duckdb-wasm@1.32.0/+esm";
import { readXlsx, XlsxError } from "./xlsx.js";

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
const VALUE_COLUMN = "bid_item_value_usd";
// columnas que se extraen de un .xlsx (como USED_COLUMNS + VALUE_COLUMN en app/data.py)
const USED_COLUMNS = [
  "quotenumber", "status", "geo", "country", "featurecode", "description", "TCE_Actual", "quantity",
  "quotelines_quantity", "contractstartdate", "opp_number", "forecast_category_name",
  "quotelines_productcategoryname_2", "quotelines_productcategoryname_3", "bid_PN",
  "Bid_Item", "quotetype", "fulfillmentmethod", "dealreg", "end_customer",
  "opportunities_parentaccountidname", "createddate", "sales_rep_name", "currency",
  "exchangerate", "totalfinalprice", "quotelines_salesprice", "uncoveredaccount", "Bid_Item_Is_Express", VALUE_COLUMN,
];
export const TCE_VALUES = ["N", "Y", "Not Mapped"];
export const GEOS = ["NA", "AP", "LA", "EMEA"];
// Shipments (como SHIP_COLUMNS / SHIP_GEOS en app/data.py): Europe + META = EMEA de quotes; PRC excluido
export const SHIP_COLUMNS = [
  "so", "order_type", "geo", "country", "fc", "qty", "sbbusage", "ship_date", "mfgsoline", "brand", "family",
  "mtm", "cto", "plant", "end_customer_name", "end_customer_number", "sc_status", "segment1", "order_date",
  "revenue_num", "productid_des", "sbb", "sbb_tce_flag", "basicname", "tce",
];
export const SHIP_GEOS = ["NA", "AP", "LA", "Europe", "META"];
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
const isNum = x => x !== null && x !== undefined && !Number.isNaN(x);
/** round(x, 2) de Python: redondeo correcto sobre el valor binario exacto (toFixed), y empates exactos
 *  (fracciones .125/.375/.625/.875) al par, como Python. Math.round(x * 100) / 100 difiere en algunos centavos. */
function round2(x) {
  const y = x * 100;
  if (Number.isInteger(x * 8) && !Number.isInteger(x * 4) && Math.abs(y) < 2 ** 50) {
    const f = Math.floor(y);
    return (f % 2 === 0 ? f : f + 1) / 100;
  }
  return Number(x.toFixed(2));
}
const num = x => !isNum(x) ? null : Number.isInteger(x) ? x : round2(x);   // _num() de Python
const usd = x => !isNum(x) ? null : round2(x);                              // _usd() de Python
const sumNum = list => list.reduce((a, x) => a + (isNum(x) ? x : 0), 0);
/** rank descendente estilo Excel (empates = puesto más alto), sobre importes redondeados a centavos */
export function rankDesc(values) {
  const v = values.map(x => Math.round((isNum(x) ? x : 0) * 100) / 100);
  const sorted = [...v].sort((a, b) => b - a);
  return v.map(x => sorted.findIndex(y => y === x) + 1);
}
export const geoFromName = name => { const m = /^\s*(NA|AP|LA|EMEA)\b/i.exec(name); return m ? m[1].toUpperCase() : ""; };

/** "XXXXX000000001-12" -> 12 (9999 si no hay sufijo numérico); un mfgsoline (sin guion) usa sus dígitos finales */
export function itemNumber(bidItem) {
  const parts = String(bidItem).split("-");
  if (parts.length < 2) { const m = /(\d+)$/.exec(String(bidItem)); return m ? Number(m[1]) : 9999; }
  const t = parts[parts.length - 1].trim();
  return /^[+-]?\d+$/.test(t) ? parseInt(t, 10) : 9999;
}
const itemLabel = bid => String(bid).includes("-") ? `item-${String(bid).split("-").pop()}` : String(bid);

/** Clave para ordenar quotes por su parte numérica final (los prefijos alfabéticos no cuentan) */
function quoteKeyCmp(a, b) {            // descendente, como sort(reverse=True) en Python
  const key = q => /^\d+$/.test(q) ? Number(q) : (m => m ? parseInt(m[1], 10) : -1)(/(\d{9})$/.exec(q));   // SO: número entero
  const na = key(a), nb = key(b);
  return (nb - na) || cmp(b, a);
}

// ------------------------------------------------------------------ estado
let db = null, conn = null, seq = 0;
let ds = null;   // dataset activo: { name, source, geo, fcCsvTce, fcDescription, fcRevAll, fcRef, fcBasic, quotes, bidFirst, prox, overrides }
let ship = null; // shipments cargado en `ship_all`: { name, file }

export function currentFile() { return ds?.name ?? null; }
export function currentGeo() { return ds?.geo ?? ""; }
export function currentSource() { return ds?.source ?? null; }
export function shipFile() { return ship?.name ?? null; }

// una sola inicialización aunque se pida varias veces a la vez (precarga + apertura rápida de un archivo)
let initPromise = null;
export function init() {
  return initPromise || (initPromise = (async () => {
    const bundle = await duckdb.selectBundle(duckdb.getJsDelivrBundles());
    const workerUrl = URL.createObjectURL(new Blob([`importScripts("${bundle.mainWorker}");`], { type: "text/javascript" }));
    const d = new duckdb.AsyncDuckDB(new duckdb.VoidLogger(), new Worker(workerUrl));
    await d.instantiate(bundle.mainModule, bundle.pthreadWorker);
    URL.revokeObjectURL(workerUrl);
    conn = await d.connect();
    db = d;
  })().catch(e => { initPromise = null; throw e; }));
}

async function rows(sql) {
  const t = await conn.query(sql);
  return t.toArray().map(r => r.toJSON());
}

// ------------------------------------------------------------------ caché Parquet (IndexedDB)
const PQ = { name: "tce-proximity-cache", store: "parquet", version: 1, keep: 6, tag: "v2" };
function pqDb() {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open(PQ.name, PQ.version);
    open.onupgradeneeded = () => open.result.createObjectStore(PQ.store);
    open.onerror = () => reject(open.error);
    open.onsuccess = () => resolve(open.result);
  });
}
function pqTx(mode, fn) {
  return pqDb().then(d => new Promise((resolve, reject) => {
    const tx = d.transaction(PQ.store, mode);
    const req = fn(tx.objectStore(PQ.store));
    tx.oncomplete = () => { d.close(); resolve(req?.result); };
    tx.onerror = () => { d.close(); reject(tx.error); };
  }));
}
const pqKey = file => `${PQ.tag}|${file.name}|${file.size}|${file.lastModified}`;
async function pqGet(file) {
  try { return (await pqTx("readonly", s => s.get(pqKey(file))))?.data ?? null; } catch { return null; }
}
async function pqPut(file, data) {
  try {
    // índice liviano en la propia base ("__index": [{k, name, t}]) para no leer los Parquet al decidir qué borrar
    const index = (await pqTx("readonly", s => s.get("__index"))) || [];
    // se borran las versiones anteriores del mismo archivo y, si hay muchas, las más viejas
    const drop = index.filter(x => x.name === file.name).map(x => x.k);
    const rest = index.filter(x => x.name !== file.name).sort((a, b) => b.t - a.t);
    const keep = rest.slice(0, PQ.keep - 1);
    const evict = [...drop, ...rest.slice(PQ.keep - 1).map(x => x.k)];
    const entry = { k: pqKey(file), name: file.name, t: Date.now() };
    await pqTx("readwrite", s => {
      evict.forEach(k => s.delete(k));
      s.put([...keep, entry], "__index");
      return s.put({ name: file.name, t: entry.t, data }, entry.k);
    });
  } catch { /* sin caché: sigue funcionando, sólo más lento la próxima vez */ }
}
export async function isCached(file) { return /\.xlsx$/i.test(file.name) && !!(await pqGet(file)); }

// ------------------------------------------------------------------ carga
/** Fuente SQL de un .xlsx: Parquet de la caché o conversión en streaming (lotes CSV -> tabla `stage`) */
async function xlsxSource(file, name, onProgress) {
  const cached = await pqGet(file);
  if (cached) {
    const reg = `src_${++seq}.parquet`;
    await db.registerFileBuffer(reg, cached);
    const src = `read_parquet(${sq(reg)})`;
    const header = (await rows(`DESCRIBE SELECT * FROM ${src}`)).map(r => r.column_name);
    return { src, regs: [reg], hasValue: header.includes(VALUE_COLUMN), hasRid: true };
  }
  await conn.query("DROP TABLE IF EXISTS stage");
  let part = 0;
  const enc = new TextEncoder();
  const info = await readXlsx(file, {
    name, columns: USED_COLUMNS, required: EXPECTED_COLUMNS, onProgress,
    onBatch: async text => {
      const reg = `part_${++seq}.csv`;
      await db.registerFileBuffer(reg, enc.encode(text));
      const rd = `read_csv(${sq(reg)}, header=true, all_varchar=true, delim=',', quote='"', escape='"')`;
      await conn.query(part++ ? `INSERT INTO stage BY NAME SELECT * FROM ${rd}` : `CREATE TABLE stage AS SELECT * FROM ${rd}`);
      await db.dropFile(reg);
    },
  });
  if (!info.rows) throw new DataError(`${name} has no rows`);
  // caché: la tabla convertida en Parquet (columnas como texto, igual que la caché .pkl de Python)
  try {
    const reg = `cache_${++seq}.parquet`;
    await conn.query(`COPY stage TO ${sq(reg)} (FORMAT parquet, COMPRESSION zstd)`);
    const buf = await db.copyFileToBuffer(reg);
    await db.dropFile(reg);
    await pqPut(file, buf);
  } catch { /* sin caché */ }
  return { src: "stage", regs: [], hasValue: info.header.includes(VALUE_COLUMN), hasRid: true, stage: true };
}

/** Carga un .xlsx / .csv (File/Blob). Valida columnas y valores de TCE_Actual como la versión Python. */
export async function loadFile(file, name = file.name, { onProgress } = {}) {
  await init();
  let regs = [], src, hasValue, hasRid = false, stage = false;
  try {
    if (/\.xlsx$/i.test(name)) {
      ({ src, regs, hasValue, hasRid, stage } = await xlsxSource(file, name, onProgress));
    } else {
      const reg = `src_${++seq}.csv`;
      regs = [reg];
      await db.registerFileHandle(reg, file, duckdb.DuckDBDataProtocol.BROWSER_FILEREADER, true);
      src = `read_csv(${sq(reg)}, header=true, all_varchar=true, delim=',', quote='"', escape='"')`;
      const header = (await rows(`DESCRIBE SELECT * FROM ${src}`)).map(r => r.column_name);
      if (SHIP_COLUMNS.every(c => header.includes(c)) && !EXPECTED_COLUMNS.every(c => header.includes(c))) {
        regs = [];
        return await loadShipments(file, name, reg, src, header.includes("sbbqty"));
      }
      const missing = EXPECTED_COLUMNS.filter(c => !header.includes(c));
      if (missing.length) throw new DataError(`Missing columns in ${name}: ${missing.join(", ")}`);
      hasValue = header.includes(VALUE_COLUMN);
    }

    const v = c => `COALESCE("${c}", '')`;
    const n = c => `TRY_CAST(REPLACE(TRIM(COALESCE("${c}", '')), ',', '') AS DOUBLE)`;
    const value = hasValue ? `TRY_CAST(REPLACE(COALESCE("${VALUE_COLUMN}", ''), ',', '') AS DOUBLE)`
      : `${n("quotelines_salesprice")} * ${n("quotelines_quantity")} / NULLIF(${n("exchangerate")}, 0)`;
    await conn.query(`CREATE OR REPLACE TABLE raw_new AS SELECT
        ${hasRid ? `CAST("__rid" AS BIGINT)` : "(row_number() OVER ()) - 1"} AS rid,
        ${v("quotenumber")} AS quotenumber, ${v("status")} AS status, ${v("geo")} AS geo, ${v("country")} AS country,
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
        ${value} AS value_usd,
        ${v("Bid_Item_Is_Express")} AS express,
        CASE WHEN ${v("opp_number")} = '' THEN ${sq(NO_OPP)} ELSE "opp_number" END AS opp_label,
        CASE WHEN ${v("opportunities_parentaccountidname")} = '' THEN ${sq(NO_ACCOUNT)}
             ELSE "opportunities_parentaccountidname" END AS account_label
      FROM ${src} ORDER BY rid`);
    const cnt = (await rows(`SELECT CAST(count(*) AS INTEGER) n FROM raw_new`))[0].n;
    if (!cnt) throw new DataError(`${name} has no rows`);
    const bad = (await rows(`SELECT DISTINCT tce_csv v FROM raw_new WHERE tce_csv NOT IN ('N', 'Y', 'Not Mapped') ORDER BY 1`))
      .map(r => r.v);
    if (bad.length) throw new DataError(`Unrecognized TCE_Actual values: ${bad.join(", ")}`);
  } catch (e) {
    await conn.query("DROP TABLE IF EXISTS raw_new");
    for (const r of regs) await db.dropFile(r).catch(() => {});
    if (stage) await conn.query("DROP TABLE IF EXISTS stage");
    throw e instanceof DataError ? e : new DataError(e instanceof XlsxError ? e.message : `Cannot read ${name}: ${e.message || e}`);
  }
  await conn.query("DROP TABLE IF EXISTS raw");
  await conn.query("ALTER TABLE raw_new RENAME TO raw");
  if (stage) await conn.query("DROP TABLE IF EXISTS stage");
  for (const r of regs) await db.dropFile(r).catch(() => {});

  await buildDs(name, "quotes");
  return meta();
}

/** Cachés del dataset activo (como los diccionarios de Dataset en Python) */
async function buildDs(name, source, geoSel = null) {
  const s = source === "shipments";
  const fc = await rows(`SELECT featurecode, arg_min(description, rid) AS d, arg_min(tce_csv, rid) AS t, min(rid) AS r,
                           ${s ? "arg_min(sbb_fcs, rid) AS fcs, arg_min(basicname, rid) AS bn, COALESCE(sum(sbb_qty), 0) AS units," : ""}
                           COALESCE(sum(value_usd), 0) AS rev FROM raw GROUP BY featurecode ORDER BY r`);
  const firsts = await rows(`SELECT * FROM raw WHERE rid IN (SELECT min(rid) FROM raw GROUP BY bid_item)`);
  const geo = (await rows(`SELECT geo, count(*) n FROM raw WHERE geo <> '' GROUP BY geo ORDER BY n DESC, geo LIMIT 1`))[0]?.geo;
  ds = {
    name, source, geo: geoSel || geo || geoFromName(name),
    fcCsvTce: new Map(fc.map(r => [r.featurecode, r.t])),
    fcDescription: new Map(fc.map(r => [r.featurecode, r.d])),
    fcRevAll: new Map(fc.map(r => [r.featurecode, r.rev])),
    fcRef: new Map(s ? fc.map(r => [r.featurecode, r.fcs]) : []),
    fcBasic: new Map(s ? fc.map(r => [r.featurecode, r.bn]) : []),
    fcUnits: new Map(s ? fc.map(r => [r.featurecode, r.units]) : []),  // shipments: unidades (sbbqty) por SBB
    quotes: (await rows(`SELECT DISTINCT quotenumber q FROM raw`)).map(r => r.q),
    bidFirst: new Map(firsts.map(r => [r.bid_item, r])),
    prox: new Map(),
    overrides: {},
  };
  await updateProximity();
}

/** Shipments (CSV): normaliza el archivo entero en `ship_all` (sin PRC) y activa la primera geo */
async function loadShipments(file, name, reg, src, hasQty = false) {
  // nulos de la query exportados como el texto NULL -> vacío (salvo el código del SBB, como en Python)
  const v = c => c === "sbb" ? `COALESCE("sbb", '')` : `CASE WHEN "${c}" = 'NULL' THEN '' ELSE COALESCE("${c}", '') END`;
  try {
    await conn.query(`CREATE OR REPLACE TABLE ship_src AS SELECT (row_number() OVER ()) - 1 AS rid,
        ${SHIP_COLUMNS.map(c => `${v(c)} AS "${c}"`).join(", ")}, ${hasQty ? v("sbbqty") : "''"} AS sbbqty FROM ${src}`);
    await conn.query(`DELETE FROM ship_src WHERE geo NOT IN (${SHIP_GEOS.map(sq).join(", ")})`);
    const cnt = (await rows(`SELECT CAST(count(*) AS INTEGER) n FROM ship_src`))[0].n;
    if (!cnt) throw new DataError(`${name} has no rows`);
    const bad = (await rows(`SELECT DISTINCT sbb_tce_flag v FROM ship_src WHERE sbb_tce_flag NOT IN ('N', 'Y', 'Not Mapped') ORDER BY 1`)).map(r => r.v);
    if (bad.length) throw new DataError(`Unrecognized TCE_Actual values: ${bad.join(", ")}`);
    // valor de la configuración = MAX(revenue_num) por mfgsoline; total de la SO = suma del valor de sus configs;
    // FC(s) de cada SBB: distintos, del más frecuente al menos (todas las geos)
    await conn.query(`CREATE OR REPLACE TABLE ship_all AS
      WITH s AS (SELECT *, max(TRY_CAST(REPLACE(revenue_num, ',', '') AS DOUBLE)) OVER (PARTITION BY mfgsoline) AS cfg_value FROM ship_src),
      cfg AS (SELECT mfgsoline, arg_min(so, rid) AS so, arg_min(cfg_value, rid) AS v FROM s GROUP BY mfgsoline),
      sot AS (SELECT so, COALESCE(sum(v), 0) AS total FROM cfg GROUP BY so),
      p AS (SELECT sbb, TRIM(f) AS f FROM (SELECT sbb, unnest(string_split(fc, ',')) AS f FROM ship_src)),
      c AS (SELECT sbb, f, count(*) AS n FROM p WHERE f <> '' GROUP BY sbb, f),
      fcs AS (SELECT sbb, string_agg(f, ', ' ORDER BY n DESC, f) AS fcs FROM c GROUP BY sbb)
      SELECT s.rid, s.so AS quotenumber, s.sc_status AS status, s.geo, s.country, s.sbb AS featurecode,
        s.productid_des AS description, s.sbb_tce_flag AS tce_csv, s.sbb_tce_flag AS tce,
        COALESCE(TRY_CAST(s.sbbusage AS DOUBLE), 0) AS quantity, TRY_CAST(s.qty AS DOUBLE) AS quotelines_quantity,
        s.ship_date AS contractstartdate, s.end_customer_number AS opp_number, s.segment1 AS forecast, s.family AS product,
        s.mtm AS bid_pn, s.mfgsoline AS bid_item, s.order_type AS quotetype, s.plant AS fulfillment,
        s.end_customer_name AS end_customer, s.end_customer_name AS account, s.order_date AS created,
        '' AS sales_rep, 'USD' AS currency, sot.total AS totalfinalprice, s.cfg_value AS value_usd, '' AS express,
        CASE WHEN s.end_customer_number = '' THEN ${sq(NO_OPP)} ELSE s.end_customer_number END AS opp_label,
        CASE WHEN s.end_customer_name = '' THEN ${sq(NO_ACCOUNT)} ELSE s.end_customer_name END AS account_label,
        s.fc AS ref_fc, COALESCE(fcs.fcs, '') AS sbb_fcs, s.basicname, s.tce AS order_tce, s.cto,
        ${hasQty ? "TRY_CAST(REPLACE(TRIM(s.sbbqty), ',', '') AS DOUBLE)" : "TRY_CAST(s.qty AS DOUBLE) * TRY_CAST(s.sbbusage AS DOUBLE)"} AS sbb_qty
      FROM s LEFT JOIN sot ON sot.so = s.so LEFT JOIN fcs ON fcs.sbb = s.sbb ORDER BY s.rid`);
  } catch (e) {
    await conn.query("DROP TABLE IF EXISTS ship_src");
    await db.dropFile(reg).catch(() => {});
    throw e instanceof DataError ? e : new DataError(`Cannot read ${name}: ${e.message || e}`);
  }
  await conn.query("DROP TABLE IF EXISTS ship_src");
  await db.dropFile(reg).catch(() => {});
  ship = { name, file };
  return selectGeo(SHIP_GEOS[0]);
}

/** Shipments: activa una geo (raw = sus filas de ship_all) */
export async function selectGeo(geo) {
  if (!ship) throw new DataError("No shipments file loaded.");
  if (!SHIP_GEOS.includes(geo)) throw new DataError(`geo must be one of: ${SHIP_GEOS.join(", ")}`);
  await conn.query(`CREATE OR REPLACE TABLE raw AS SELECT * FROM ship_all WHERE geo = ${sq(geo)} ORDER BY rid`);
  if (!(await rows(`SELECT CAST(count(*) AS INTEGER) n FROM raw`))[0].n) throw new DataError(`${ship.name} has no rows for geo ${geo}`);
  await buildDs(ship.name, "shipments", geo);
  return meta();
}

function need() { if (!ds) throw new DataError("No data loaded. Open a data file."); return ds; }

/** Tabla bp(bid_item, prox) y mapa ds.prox = TCE Proximity (líneas N, con ajustes) de cada bid-item */
async function updateProximity() {
  await conn.query(`CREATE OR REPLACE TABLE bp AS SELECT bid_item,
                      CAST(sum(CASE WHEN tce = 'N' THEN 1 ELSE 0 END) AS INTEGER) AS prox FROM raw GROUP BY bid_item`);
  ds.prox = new Map((await rows("SELECT bid_item, prox FROM bp")).map(r => [r.bid_item, r.prox]));
}
const bidValue = b => ds.bidFirst.get(b)?.value_usd ?? null;

// ------------------------------------------------------------------ ajustes
/** Aplica ajustes de TCE por feature code ({fc: 'Y'|'N'|'Not Mapped'}) sin tocar el archivo. */
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
  await updateProximity();
}

export function fcExists(fc) { return need().fcCsvTce.has(fc); }
/** Columnas de referencia de un SBB (FC(s) y basicname); vacío en quotes (como Dataset.ref en Python) */
const ref = fc => ds.source !== "shipments" ? {} : { ref_fc: ds.fcRef.get(fc) ?? "", basicname: ds.fcBasic.get(fc) ?? "" };
export function fcRevAll() { return new Map(need().fcRevAll); }
export function fcUnits() { return new Map(need().fcUnits); }
export function fcCsvTce(fc) { return need().fcCsvTce.get(fc) ?? null; }
export function fcDescription(fc) { return need().fcDescription.get(fc) ?? ""; }
export function fcCsvMap() { return new Map(need().fcCsvTce); }

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
  const firsts = [...ds.bidFirst.values()];
  return {
    file: ds.name, source: ds.source, geo: ds.geo, rows: m.n_rows, quotes: m.quotes, bids: m.bids,
    tce_configs: [...ds.prox.values()].filter(k => k === 0).length,
    value_usd: usd(sumNum(firsts.map(f => f.value_usd))),
    bids_without_value: firsts.filter(f => !isNum(f.value_usd)).length,
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
  const g = await rows(`SELECT opp_label, account_label, quotenumber, bid_item, product,
                 CAST(count(*) AS INTEGER) AS proximity, min(rid) AS r
               FROM raw WHERE ${where({ express, currency, tce, multi })}
               GROUP BY opp_label, account_label, quotenumber, bid_item, product ORDER BY r`);
  g.forEach(x => (x.value_usd = bidValue(x.bid_item)));
  return g;
}

/** Revenue contribution por FC (USD) en las filas que cumplen `w` (cualquier valor TCE) */
async function revByFc(w) {
  return new Map((await rows(`SELECT featurecode, COALESCE(sum(value_usd), 0) AS rev FROM raw WHERE ${w} GROUP BY featurecode`))
    .map(r => [r.featurecode, r.rev]));
}

// ---------------------------------------------------------- 1. ranking
// multi: { product, country, forecast, status } -> lista de valores o null (sin filtro)
const multiOut = multi => Object.fromEntries(Object.keys(MULTI_FILTERS).map(k => [k, multi[k] && multi[k].length ? multi[k] : null]));

export async function ranking(express = null, currency = null, tce = "N", multi = {}) {
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
    qmap.get(x.quotenumber).push({ bid_item: x.bid_item, product: x.product, proximity: x.proximity, value_usd: usd(x.value_usd) });
  }
  const vsum = bl => usd(sumNum(bl.map(b => b.value_usd)));
  const opps = [];
  for (const { opp, account, q, forecast } of tree.values()) {
    const quotes = [...q.entries()].map(([quotenumber, bids]) =>
      ({ quotenumber, total: bids.reduce((a, b) => a + b.proximity, 0), value_usd: vsum(bids), bids }));
    quotes.sort((a, b) => quoteKeyCmp(a.quotenumber, b.quotenumber));
    const all = quotes.flatMap(x => x.bids);
    opps.push({ opp_number: opp, account, forecast: opp === NO_OPP ? "" : forecast, total: quotes.reduce((a, x) => a + x.total, 0),
                value_usd: vsum(all), min_proximity: Math.min(...all.map(b => b.proximity)), n_bids: all.length, quotes });
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
      value_usd: usd(sumNum(g.map(x => x.value_usd))),
      distribution: dist,
    },
    opps,
  };
}

// ------------------------------------------------------------ bids flat
export async function bids(express = null, currency = null, tce = "N", multi = {}) {
  need();
  const g = await bidTable(express, currency, tce, multi);
  g.forEach(x => (x._item = itemNumber(x.bid_item)));
  g.sort((a, b) => a.proximity - b.proximity || cmp(a.quotenumber, b.quotenumber) || a._item - b._item);
  // tot_lines_qty = suma de quotelines_quantity de todos los bid-items del quote (sin filtros)
  const totQty = new Map();
  for (const f of ds.bidFirst.values()) {
    const v = f.quotelines_quantity;
    totQty.set(f.quotenumber, (totQty.get(f.quotenumber) ?? 0) + (isNum(v) ? v : 0));
  }
  return g.map((x, i) => {
    const f = ds.bidFirst.get(x.bid_item) || {};
    return {
      rank: i + 1, bid_item: x.bid_item, quotenumber: x.quotenumber,
      opp_number: x.opp_label, account: x.account_label, product: x.product, bid_pn: f.bid_pn ?? "",
      proximity: x.proximity, forecast: f.forecast ?? "", sales_rep: f.sales_rep ?? "",
      country: f.country ?? "", status: f.status ?? "", contract_start: f.contractstartdate ?? "",
      quotelines_quantity: num(f.quotelines_quantity ?? null), tot_lines_qty: num(totQty.get(x.quotenumber) ?? null),
      value_usd: usd(x.value_usd),
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
  const shipS = ds.source === "shipments";
  for (const r of q) {
    const key = [r.bid_item, r.bid_pn, r.product, r.express, r.featurecode, r.description,
                 ...(shipS ? [r.ref_fc, r.basicname] : [])].join("\u0000");
    if (!groups.has(key)) groups.set(key, { r, N: 0, Y: 0, NM: 0, qlq: null });
    const g = groups.get(key);
    // quotelines_quantity: constante por bid-item; max() como en pandas (ignora vacíos)
    const qq = r.quotelines_quantity;
    if (isNum(qq) && (g.qlq === null || qq > g.qlq)) g.qlq = qq;
    if (r.tce === "N") g.N += r.quantity; else if (r.tce === "Y") g.Y += r.quantity; else g.NM += r.quantity;
  }
  const list = [...groups.values()];
  list.sort((a, b) => (bidPos.get(a.r.bid_item) - bidPos.get(b.r.bid_item))
    || (fcPos.get(a.r.featurecode) - fcPos.get(b.r.featurecode))
    || (descPos.get(a.r.description) - descPos.get(b.r.description)));
  list.sort((a, b) => (itemNumber(a.r.bid_item) - itemNumber(b.r.bid_item)) || (b.N - a.N) || (b.Y - a.Y) || (b.NM - a.NM));
  const rowsOut = list.map(({ r, N, Y, NM, qlq }) => ({
    item: itemLabel(r.bid_item), bid_item: r.bid_item, bid_pn: r.bid_pn, product: r.product, express: r.express,
    featurecode: r.featurecode, description: r.description,
    ...(shipS ? { ref_fc: r.ref_fc, basicname: r.basicname } : {}),
    quotelines_quantity: num(qlq), N: num(N), Y: num(Y), "Not Mapped": num(NM),
    rev_contrib_usd: usd(ds.fcRevAll.get(r.featurecode) ?? null),
    adjusted_from: r.featurecode in ds.overrides ? (ds.fcCsvTce.get(r.featurecode) ?? null) : null,
  }));

  const byBid = new Map();
  for (const r of q) { if (!byBid.has(r.bid_item)) byBid.set(r.bid_item, []); byBid.get(r.bid_item).push(r); }
  const bidsOut = [...byBid.entries()].map(([b, br]) => ({
    bid_item: b, item: itemLabel(b), product: br[0].product, bid_pn: br[0].bid_pn, express: br[0].express,
    proximity: br.filter(r => r.tce === "N").length,
    value_usd: usd(br[0].value_usd),
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
      value_usd: usd(sumNum(bidsOut.map(b => b.value_usd))),
      ...(shipS ? { order_tce: f.order_tce, cto: f.cto } : {}),
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

// ---------------------------------------------------- 3. FC ranking (proximity)
// proximity: un valor o una lista (selección múltiple); null = todas. "up to" = k <= máximo de la lista
export async function fcRanking(proximity = 1, criteria = "exactly", express = null, currency = null, products = null, withBids = true) {
  need();
  criteria = String(criteria).toLowerCase();
  if (criteria !== "exactly" && criteria !== "up to") throw new DataError("criteria must be 'exactly' or 'up to'");
  const prox = proximity === null || proximity === undefined ? null
    : [...new Set([].concat(proximity).map(Number))].sort((a, b) => a - b);
  const cond = !prox || !prox.length ? "TRUE"
    : criteria === "up to" ? `k.k <= ${Math.max(...prox)}` : `k.k IN (${prox.join(", ")})`;
  const wAll = where({ express, currency, products });
  const kSql = `WITH n AS (SELECT rid, bid_item, featurecode, description, quotenumber, opp_label, account_label, product, value_usd
                           FROM raw WHERE ${wAll} AND tce = 'N'),
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
  const rev = scope.length ? await revByFc(wAll) : new Map();
  const fcs = [...byFc.entries()].map(([fc, list]) => ({ fc, list, rev: rev.get(fc) ?? 0, value: sumNum(list.map(r => r.value_usd)) }));
  fcs.sort((a, b) => (b.list.length - a.list.length) || cmp(a.fc, b.fc));
  const revTotal = fcs.reduce((a, x) => a + x.rev, 0);
  const ranks = rankDesc(fcs.map(x => x.rev));
  const scopeBids = [...new Set(scope.map(r => r.bid_item))];
  return {
    filters: { proximity: prox && prox.length ? (prox.length === 1 ? prox[0] : prox) : null, criteria, express, currency,
               product: products && products.length ? products : null },
    proximity_values: proxValues,
    configs_in_scope: scopeBids.length,
    lines_in_scope: scope.length,
    value_in_scope_usd: usd(sumNum(scopeBids.map(bidValue))),
    rows: fcs.map(({ fc, list, rev: r, value }, i) => ({
      featurecode: fc, description: list[0].description, ...ref(fc), configs: list.length,
      rev_contrib_usd: usd(r), rev_pct: revTotal ? r / revTotal : 0, rev_rank: ranks[i], value_in_scope_usd: usd(value),
      ...(withBids ? {
        bids: list.map(b => ({ bid_item: b.bid_item, quotenumber: b.quotenumber, opp_number: b.opp_label,
                               account: b.account_label, product: b.product, proximity: b.k, value_usd: usd(b.value_usd) })),
      } : {}),
    })),
  };
}

// ---------------------------------------------------- 4. TCE dependency
export async function dependency(express = null, currency = null, products = null) {
  need();
  const wAll = where({ express, currency, products });
  const wTce = `${wAll} AND bid_item IN (SELECT bid_item FROM bp WHERE prox = 0)`;
  const s = (await rows(`SELECT CAST(count(DISTINCT bid_item) AS INTEGER) AS c FROM raw WHERE ${wTce}`))[0];
  const tceBids = (await rows(`SELECT DISTINCT bid_item b FROM raw WHERE ${wTce}`)).map(r => r.b);
  const y = await rows(`SELECT featurecode, arg_min(description, rid) AS description, CAST(count(DISTINCT bid_item) AS INTEGER) AS configs,
                          CAST(count(*) AS INTEGER) AS n, min(rid) AS r
                        FROM raw WHERE ${wTce} AND tce = 'Y' GROUP BY featurecode`);
  const tceConfigs = s.c;
  let out = [];
  if (y.length) {
    const revAll = await revByFc(wAll), revTce = await revByFc(wTce);
    y.forEach(x => { x.rev_all = revAll.get(x.featurecode) ?? 0; x.rev_tce = revTce.get(x.featurecode) ?? 0; });
    y.sort((a, b) => (b.configs - a.configs) || cmp(a.featurecode, b.featurecode));
    const ranks = rankDesc(y.map(x => x.rev_tce));
    out = y.map((x, i) => ({
      featurecode: x.featurecode, description: x.description, ...ref(x.featurecode), configs: x.configs,
      pct: tceConfigs ? x.configs / tceConfigs : 0,
      rev_all_usd: usd(x.rev_all), rev_tce_usd: usd(x.rev_tce),
      tce_share: x.rev_all ? x.rev_tce / x.rev_all : 0,
      rev_tce_rank: ranks[i],
    }));
  }
  return {
    filters: { express, currency, product: products && products.length ? products : null },
    tce_configs_in_scope: tceConfigs,
    tce_lines_in_scope: y.reduce((a, x) => a + x.n, 0),
    tce_value_in_scope_usd: usd(sumNum(tceBids.map(bidValue))),
    rows: out,
  };
}

/** Configs full TCE que contienen el FC (detalle de una fila de dependency); null si el FC no existe */
export async function dependencyConfigs(fc, express = null, currency = null, products = null) {
  need();
  if (!ds.fcCsvTce.has(fc)) return null;
  const list = await rows(`SELECT bid_item, arg_min(quotenumber, rid) AS quotenumber, arg_min(opp_label, rid) AS opp_label,
                             arg_min(account_label, rid) AS account_label, arg_min(product, rid) AS product
                           FROM raw WHERE ${where({ express, currency, products })} AND featurecode = ${sq(fc)} AND tce = 'Y'
                             AND bid_item IN (SELECT bid_item FROM bp WHERE prox = 0)
                           GROUP BY bid_item`);
  list.forEach(x => (x.v = bidValue(x.bid_item)));
  list.sort((a, b) => ((isNum(b.v) ? b.v : -1) - (isNum(a.v) ? a.v : -1)) || cmp(a.bid_item, b.bid_item));
  return list.map(b => ({ bid_item: b.bid_item, quotenumber: b.quotenumber, opp_number: b.opp_label,
                          account: b.account_label, product: b.product, value_usd: usd(b.v) }));
}

// ------------------------------------------------------ adjustments
function fcSummary(fc) {
  const csv = ds.fcCsvTce.get(fc) ?? null;
  return { featurecode: fc, description: ds.fcDescription.get(fc) ?? "", csv_tce: csv,
           tce: fc in ds.overrides ? ds.overrides[fc] : csv, adjusted: fc in ds.overrides, ...ref(fc) };
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

/** Ficha de un FC: valor TCE (archivo y efectivo), uso e impacto de cambiarlo sobre la clasificación */
export async function fcLookup(code, express = null, currency = null) {
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
  const per = (await rows(`SELECT bid_item, CAST(count(*) AS INTEGER) AS l FROM raw WHERE featurecode = ${f} AND ${w} GROUP BY bid_item`))
    .map(x => ({ ...x, k: ds.prox.get(x.bid_item) ?? 0, v: bidValue(x.bid_item) }));
  const current = fc in ds.overrides ? ds.overrides[fc] : ds.fcCsvTce.get(fc);
  const impact = {};
  for (const target of TCE_VALUES) {
    let changed = 0, ready = 0, enter = 0, p1 = 0;
    const readyV = [], enterV = [];
    for (const { l, k, v } of per) {
      const delta = l * ((target === "N") - (current === "N"));
      const kNew = k + delta;
      if (delta !== 0) changed++;
      if (k > 0 && kNew === 0) { ready++; readyV.push(v); }
      if (k === 0 && kNew > 0) { enter++; enterV.push(v); }
      if (kNew === 1) p1++;
    }
    impact[target] = { bids_changed: changed, become_tce_ready: ready, become_tce_ready_value_usd: usd(sumNum(readyV)),
                       enter_ranking: enter, enter_ranking_value_usd: usd(sumNum(enterV)), proximity_1_after: p1 };
  }
  return {
    ...fcSummary(fc), descriptions,
    usage: { lines: usage.lines, quotes: usage.quotes, bids: usage.bids,
             bids_in_scope: per.length, bids_in_scope_in_ranking: per.filter(x => x.k > 0).length,
             tce_configs_in_scope: per.filter(x => x.k === 0).length, rev_contrib_usd: usd(sumNum(per.map(x => x.v))) },
    scope: { express, currency },
    impact,
  };
}

// ------------------------------------------------------ WW (las 4 geos)
/** Combina los rankings de cada geo como DataStore.ww() de Python. perGeo: {geo: [fcRanking sin bids, dependency]}
 *  Shipments: geoList = SHIP_GEOS y revAll = {geo: Map(sbb -> rev contrib)} para mostrar la Rev Contrib de cada geo
 *  aunque el SBB no tenga configs en scope (WW_FILL_REV en Python). */
export function combineWw(perGeo, files, prox, { geoList = GEOS, revAll = null, units = null, source = "quotes" } = {}) {
  const hasUnits = !!units && Object.values(units).some(m => m.size);
  const geos = geoList.filter(g => g in perGeo);
  const combine = (part, totalKey, valueKeys) => {
    const rows = new Map();
    const totals = Object.fromEntries(geos.map(g => [g, perGeo[g][part][totalKey]]));
    for (const g of geos) for (const r of perGeo[g][part].rows) {
      if (!rows.has(r.featurecode)) rows.set(r.featurecode, { featurecode: r.featurecode, description: r.description,
                                                             ...("ref_fc" in r ? { ref_fc: r.ref_fc, basicname: r.basicname } : {}), configs: {},
                                                             ...Object.fromEntries(valueKeys.map(v => [v, {}])) });
      const x = rows.get(r.featurecode);
      x.configs[g] = r.configs;
      for (const v of valueKeys) x[v][g] = r[v];
    }
    const totalAll = Object.values(totals).reduce((a, b) => a + b, 0);
    const fill = revAll ? valueKeys.filter(v => v === "rev_contrib_usd" || v === "rev_all_usd") : [];
    const out = [...rows.values()].map(x => {
      for (const v of fill) for (const g of geos)
        if (!(g in x[v]) && revAll[g].get(x.featurecode)) x[v][g] = usd(revAll[g].get(x.featurecode));
      if (hasUnits) {  // shipments: unidades despachadas del SBB por geo (todas sus configs) y WW
        x.units = {};
        for (const g of geos) if (units[g]?.get(x.featurecode)) x.units[g] = Math.round(units[g].get(x.featurecode));
        x.units_ww = Object.values(x.units).reduce((a, b) => a + b, 0);
      }
      x.configs_ww = Object.values(x.configs).reduce((a, b) => a + b, 0);
      x.n_geos = Object.values(x.configs).filter(v => v > 0).length;
      x.pct = totalAll ? x.configs_ww / totalAll : 0;
      for (const v of valueKeys) x[v + "_ww"] = usd(sumNum(Object.values(x[v])));
      return x;
    });
    out.sort((a, b) => (b.configs_ww - a.configs_ww) || cmp(a.featurecode, b.featurecode));
    return { configs_by_geo: totals, configs_ww: totalAll, rows: out };
  };
  const p = combine(0, "configs_in_scope", ["rev_contrib_usd"]);
  let cum = 0;
  const revTotal = p.rows.reduce((a, x) => a + (x.rev_contrib_usd_ww || 0), 0);
  const pr = rankDesc(p.rows.map(x => x.rev_contrib_usd_ww));
  p.rows.forEach((x, i) => {
    cum += x.configs_ww;
    x.cum_pct = p.configs_ww ? cum / p.configs_ww : 0;
    x.rev_pct = revTotal ? (x.rev_contrib_usd_ww || 0) / revTotal : 0;
    x.rev_rank = pr[i];
  });
  const d = combine(1, "tce_configs_in_scope", ["rev_all_usd", "rev_tce_usd"]);
  const dr = rankDesc(d.rows.map(x => x.rev_tce_usd_ww));
  d.rows.forEach((x, i) => {
    x.tce_share = x.rev_all_usd_ww ? (x.rev_tce_usd_ww || 0) / x.rev_all_usd_ww : 0;
    x.rev_tce_rank = dr[i];
  });
  return {
    filters: { proximity: prox.length === 1 ? prox[0] : prox },
    source, geos, files, missing_geos: geoList.filter(g => !(g in perGeo)),
    proximity: p, dependency: d, has_units: hasUnits,
  };
}
