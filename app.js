/* TCE Proximity — GitHub Pages version (static site, data processed locally in the browser).
 * Derivado de app/static/app.js (versión Python). La API /api/... la atiende api.js (DuckDB-WASM).
 * Rutas (hash):
 *   #/ranking?express=No&currency=USD&countries=A|B&forecasts=..&statuses=..   hoja 1. Quotes Details
 *   #/quote/<quote>?bid=<bid_item>             hoja 2. Quote Detail (Filters)
 *   #/fc?prox=1|2&express=No&currency=USD&products=A|B   hoja 3. TCE Proximity by FC
 *   #/dependency?express=all&currency=all&products=A|B   hoja "Ranking TCE Depenency" (FCs de las configs full TCE)
 *   #/bids?express=No&currency=USD&products=A|B&countries=..&forecasts=..   ranking plano de bids
 *   #/ww?prox=1          "TCE Proximity WW Detractors Ranking" (las 4 geos)
 * Defaults de Express / Currency desde Oct 28: All (como la hoja Methodology). Importes en USD (bid_item_value_usd).
 * Origen de datos (selector del encabezado): Quotes o Shipments. En Shipments el mismo análisis es por SBB
 * (FC como referencia), configuración = mfgsoline, orden = SO y la geo se elige en el encabezado (LABELS / L).
 */
import { api as localApi, exportUrl, loadFile as localLoad, initEngine, pickFile, reopenLast, lastHandle,
         canPickFiles, exportAdjustmentsFile, importAdjustmentsFile, setProgressHandler,
         pickWwFiles, reopenWwFiles, lastWwHandles, setWwFiles,
         selectGeo as localGeo, switchSource as localSwitch, SHIP_GEOS } from "./api.js";

const $ = (sel, el = document) => el.querySelector(sel);
const $$ = (sel, el = document) => [...el.querySelectorAll(sel)];
const view = $("#view");
const state = { meta: null, rankingOpen: {}, fcOpen: {}, depOpen: {}, sorts: {} };

// ---------------------------------------------------------------- utils
function esc(v) {
  return String(v ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
const fmt = n => (n === null || n === undefined || n === "") ? "" : Number(n).toLocaleString("en-US");
const money = n => (n === null || n === undefined) ? "" : Number(n).toLocaleString("en-US", { maximumFractionDigits: 0 });
// importes grandes en los KPIs: $1.00 B · $467.7 M · $12.3 K
function usdShort(n) {
  if (n === null || n === undefined) return "—";
  const a = Math.abs(n);
  if (a >= 1e9) return "$" + (n / 1e9).toFixed(2) + " B";
  if (a >= 1e6) return "$" + (n / 1e6).toFixed(1) + " M";
  if (a >= 1e3) return "$" + (n / 1e3).toFixed(1) + " K";
  return "$" + money(n);
}
// importes de las tablas de ranking en millones, como el Excel ($4.65M); el valor completo en el tooltip
const usdM = n => (n === null || n === undefined) ? "" : `<span title="$${money(n)}">$${(n / 1e6).toFixed(2)}M</span>`;
// Orden por columna (clic en el título): ▲ ascendente · ▼ descendente · ↕ = ordenable.
// st = { key, dir }; key null = orden original. Primer clic: números de mayor a menor, textos de A a Z.
function sortTh(label, key, st, cls = "", title = "") {
  const on = st.key === key;
  return `<th class="sortable ${cls}" data-sort-key="${esc(key)}"${title ? ` title="${esc(title)}"` : ""}>${label}<span class="sort-ind${on ? " on" : ""}">${on ? (st.dir > 0 ? "▲" : "▼") : "↕"}</span></th>`;
}
const pathGet = (r, k) => k.split(".").reduce((o, part) => o?.[part], r);
const blankVal = v => v === null || v === undefined || v === "";
function sortRows(rows, st, get = pathGet) {
  if (!st.key) return rows;
  return rows.map((r, i) => [r, i]).sort(([a, i], [b, j]) => {
    const x = get(a, st.key), y = get(b, st.key);
    if (blankVal(x) || blankVal(y)) return blankVal(x) === blankVal(y) ? i - j : blankVal(x) ? 1 : -1;   // vacíos al final
    const c = typeof x === "number" && typeof y === "number" ? x - y : String(x).localeCompare(String(y));
    return c * st.dir || i - j;
  }).map(([r]) => r);
}
function wireSort(box, st, rows, redraw, get = pathGet) {
  $$("th[data-sort-key]", box).forEach(th => th.onclick = () => {
    const k = th.dataset.sortKey;
    if (st.key === k) st.dir *= -1;
    else { const v = rows.map(r => get(r, k)).find(x => !blankVal(x)); st.key = k; st.dir = typeof v === "number" ? -1 : 1; }
    redraw();
  });
}
const sortState = name => state.sorts[name] || (state.sorts[name] = { key: null, dir: 1 });
const pctFmt = (x, d = 1) => (x === null || x === undefined) ? "" : (100 * x).toFixed(d) + "%";
// Textos que dependen del origen de datos. L.<clave> devuelve el del origen activo.
const LABELS = {
  quotes: {
    code: "FC", codeName: "feature code", codes: "feature codes", codeCol: "featurecode", descCol: "description",
    opp: "Opportunity", opps: "Opportunities", oppCol: "opp_number", oppStatusCol: "forecast_category_name",
    accountCol: "opportunities_parentaccountidname", account: "Account", noOpp: "(no opp)",
    quote: "Quote", quoteLow: "quote", quoteCol: "quotenumber", quotes: "Bids (quotes)", bidWord: "bid", bidsWord: "bids",
    item: "bid-item", items: "bid-items", Item: "Bid-item", Items: "Bid-items", itemCol: "Bid_Item",
    product: "Product", productCol: "quotelines_productcategoryname_3", pnCol: "bid_PN",
    value: "Bid Item Price (USD)", tceCol: "TCE_Actual", line: "line", lines: "lines",
    contract: "Contract start", qtyCol: "quotelines_quantity", totQty: "tot_lines_qty", qtyName: "quantity",
    total: "Total quote (final price)",
    valueHint: "Bid-item value in USD = sales price × quotelines_quantity / exchange rate (bid_item_value_usd of the query).",
  },
  shipments: {
    code: "SBB", codeName: "SBB", codes: "SBBs", codeCol: "sbb", descCol: "productid_des",
    opp: "Customer", opps: "Customers", oppCol: "end_customer_number", oppStatusCol: "segment1",
    accountCol: "end_customer_name", account: "Customer", noOpp: "(no customer)",
    quote: "Order (SO)", quoteLow: "order", quoteCol: "so", quotes: "Orders (SO)", bidWord: "SO", bidsWord: "SOs",
    item: "config", items: "configs", Item: "Config", Items: "Configs", itemCol: "mfgsoline",
    product: "Family", productCol: "family", pnCol: "mtm",
    value: "Config value (USD)", tceCol: "sbb_tce_flag", line: "SBB", lines: "SBBs",
    contract: "Ship date", qtyCol: "qty", totQty: "SO qty", qtyName: "sbbusage",
    total: "SO value (USD)",
    valueHint: "Configuration value in USD = MAX(revenue_num) of the mfgsoline (query rule 3; credits can be negative).",
  },
};
const isShip = () => (state.meta?.source ?? state.source) === "shipments";
const L = new Proxy({}, { get: (_, k) => LABELS[isShip() ? "shipments" : "quotes"][k] });
// Columnas de referencia de un SBB (sólo shipments): FC(s) y basicname
const refTh = (st, cls = "") => isShip() ? (st ? sortTh("FC(s)", "ref_fc", st, cls, "Feature codes of the SBB (fc column)") + sortTh("Basic name", "basicname", st, cls)
  : `<th title="Feature codes of the SBB (fc column)">FC(s)</th><th>Basic name</th>`) : "";
const refTd = r => isShip() ? `<td class="mono trunc" title="${esc(r.ref_fc)}">${esc(r.ref_fc)}</td><td class="nowrap">${esc(r.basicname)}</td>` : "";
const refN = () => isShip() ? 2 : 0;

function proxBadge(p) {
  const cls = p >= 5 ? "p5" : "p" + p;
  return `<span class="prox ${cls}">${p}</span>`;
}

// Subtítulo de la oportunidad, en el orden en que se muestran los bids:
//   "1 bid - 2 items" · "3 bids - 1 item per bid" · "3 bids - 1, 4 & 3 items per bid"
function bidsSummary(rows) {
  const per = new Map();
  for (const [qq] of rows) per.set(qq.quotenumber, (per.get(qq.quotenumber) || 0) + 1);
  const n = [...per.values()];
  const w = isShip() ? "config" : "item";
  const items = k => `${w}${k === 1 ? "" : "s"}`;
  if (n.length === 1) return `1 ${L.bidWord} - ${n[0]} ${items(n[0])}`;
  if (n.every(x => x === n[0])) return `${n.length} ${L.bidsWord} - ${n[0]} ${items(n[0])} per ${L.bidWord}`;
  const list = n.slice(0, -1).join(", ") + " & " + n[n.length - 1];
  return `${n.length} ${L.bidsWord} - ${list} ${w}s per ${L.bidWord}`;
}

// Desplegable con checkboxes (selección múltiple). onApply(lista) se llama al apretar Apply
// o al cerrar el panel con cambios. Lista vacía = todos.
function multiSelect(box, values, selected, allLabel, noun, onApply, id = "f-product") {
  let sel = new Set(selected);
  const summary = () => !selected.length ? allLabel
    : selected.length === 1 ? selected[0] : `${selected.length} ${noun} selected`;
  box.className = "ms";
  box.innerHTML = `
    <button type="button" class="ms-btn" id="${esc(id)}" aria-haspopup="true" aria-expanded="false"
      title="${esc(selected.join("\n") || allLabel)}"><span>${esc(summary())}</span><span class="ms-caret">▾</span></button>
    <div class="ms-panel" hidden>
      <input type="search" class="ms-search" placeholder="Search ${esc(noun)}…">
      <div class="ms-actions"><button type="button" class="btn small" data-act="all">Select all</button>
        <button type="button" class="btn small" data-act="none">Clear</button>
        <span class="ms-count muted"></span></div>
      <div class="ms-list">${values.map(v => `<label class="ms-item"><input type="checkbox" value="${esc(v)}"${sel.has(v) ? " checked" : ""}> ${esc(v)}</label>`).join("")}</div>
      <div class="ms-foot"><button type="button" class="btn primary small" data-act="apply">Apply</button></div>
    </div>`;
  const btn = $(".ms-btn", box), panel = $(".ms-panel", box);
  const count = () => $(".ms-count", box).textContent = sel.size ? `${sel.size} selected` : `none selected = ${allLabel.toLowerCase()}`;
  const changed = () => sel.size !== selected.length || selected.some(x => !sel.has(x));
  const close = (apply) => {
    if (panel.hidden) return;
    panel.hidden = true; btn.setAttribute("aria-expanded", "false");
    document.removeEventListener("mousedown", outside);
    if (apply && changed()) onApply([...sel].sort((a, b) => values.indexOf(a) - values.indexOf(b)));
  };
  const outside = e => { if (!box.contains(e.target)) close(true); };
  btn.onclick = () => {
    if (!panel.hidden) return close(true);
    panel.hidden = false; btn.setAttribute("aria-expanded", "true");
    document.addEventListener("mousedown", outside);
    $(".ms-search", box).focus();
  };
  $$(".ms-item input", box).forEach(cb => cb.onchange = () => { cb.checked ? sel.add(cb.value) : sel.delete(cb.value); count(); });
  $(".ms-search", box).oninput = e => {
    const t = e.target.value.toLowerCase();
    $$(".ms-item", box).forEach(l => l.hidden = !l.textContent.toLowerCase().includes(t));
  };
  box.onclick = e => {
    const act = e.target.dataset?.act;
    if (!act) return;
    const visible = $$(".ms-item", box).filter(l => !l.hidden).map(l => $("input", l));
    if (act === "all") visible.forEach(cb => { cb.checked = true; sel.add(cb.value); });
    if (act === "none") { sel.clear(); $$(".ms-item input", box).forEach(cb => cb.checked = false); }
    if (act === "apply") return close(true);
    count();
  };
  panel.onkeydown = e => { if (e.key === "Escape") { close(false); btn.focus(); } };
  count();
}

// Filtros de selección múltiple (componente multiSelect + etiquetas con "×" de lo elegido).
// En la URL: "<clave>=A|B"; en la API: "?<api>=A&<api>=B". Ninguno elegido = todos.
const MULTI = {
  products: { api: "product", meta: "product_values", label: "System (quotelines_productcategoryname_3)", short: "System", all: "All systems", noun: "systems" },
  countries: { api: "country", meta: "country_values", label: "Country", short: "Country", all: "All countries", noun: "countries" },
  forecasts: { api: "forecast", meta: "forecast_values", label: "Opp. status (forecast_category_name)", short: "Forecast (opp. status)", all: "All", noun: "statuses" },
  statuses: { api: "status", meta: "status_values", label: "Bid status (status)", short: "Bid status", all: "All", noun: "statuses" },
};
// mismos filtros en shipments (sistema = family, forecast = segment1, status = sc_status)
const MULTI_SHIP = {
  products: { label: "Family (family)", short: "Family", all: "All families", noun: "families" },
  forecasts: { label: "Customer segment (segment1)", short: "Segment", all: "All", noun: "segments" },
  statuses: { label: "Ship status (sc_status)", short: "Ship status", all: "All", noun: "statuses" },
};
const ml = k => ({ ...MULTI[k], ...(isShip() ? MULTI_SHIP[k] : {}) });
const multiParams = (params, keys) => Object.fromEntries(keys.map(k => [k, (params.get(k) || "").split("|").filter(Boolean)]));
const multiHash = sel => Object.fromEntries(Object.entries(sel).map(([k, v]) => [k, v.join("|")]));
function multiQs(qsp, sel) {
  for (const [k, vals] of Object.entries(sel)) vals.forEach(v => qsp.append(MULTI[k].api, v));
  return qsp;
}
// inline = compacto, en la misma barra que los demás filtros (etiqueta corta; la completa en el tooltip)
function multiFieldsHtml(sel, inline = false) {
  return Object.entries(sel).map(([k, vals]) => `
    <div class="ms-group${inline ? " inline" : ""}">
      <div class="field"><label for="f-${k}" title="${esc(ml(k).label)}">${esc(inline ? ml(k).short : ml(k).label)}</label><div id="f-${k}-box"></div></div>
      <div class="sel-chips" id="sel-${k}">${vals.map(selChipHtml).join("")}</div>
    </div>`).join("");
}
const selChipHtml = s => `
  <span class="sel-chip" title="${esc(s)}">${esc(s)}<button type="button" data-remove="${esc(s)}" aria-label="Remove ${esc(s)}">×</button></span>`;
// go(nuevaSelección) se llama al aplicar cambios en un desplegable o al quitar una etiqueta
function wireMultiFields(sel, go) {
  for (const [k, vals] of Object.entries(sel)) {
    const m = ml(k);
    multiSelect($(`#f-${k}-box`), state.meta?.[m.meta] || [], vals, m.all, m.noun, v => go({ ...sel, [k]: v }), `f-${k}`);
    $$("[data-remove]", $(`#sel-${k}`)).forEach(b => b.onclick = () => go({ ...sel, [k]: vals.filter(x => x !== b.dataset.remove) }));
  }
}

// "XXXXX000000001-7" -> "item-7" (el bid ya se muestra en la columna quotenumber); un mfgsoline va completo
const itemLabel = bidItem => String(bidItem).includes("-") ? "item-" + String(bidItem).split("-").pop() : String(bidItem);

// TCE values: Y / N / Not Mapped
const TCE_VALUES = ["Y", "N", "Not Mapped"];
const tceShort = v => v === "Not Mapped" ? "NM" : (v ?? "—");
function tceBadge(v) {
  const cls = v === "Y" ? "tce-y" : v === "N" ? "tce-n" : "tce-nm";
  return `<span class="tce ${cls}">${esc(v ?? "—")}</span>`;
}
function adjustedTo(fc) {
  const a = (state.meta?.adjustments || []).find(x => x.featurecode === fc);
  return a ? a.to : null;
}

// Persistent notice: the base has manual TCE adjustments
function drawAdjBanner() {
  const adj = state.meta?.adjustments || [];
  const b = $("#adj-banner");
  if (!adj.length) { b.hidden = true; return; }
  const list = adj.slice(0, 4).map(a => `${esc(a.featurecode)} ${esc(tceShort(a.from))}→${esc(tceShort(a.to))}`).join(", ");
  b.innerHTML = `<strong>Adjusted base:</strong> ${adj.length} TCE adjustment${adj.length > 1 ? "s" : ""} active
    (${list}${adj.length > 4 ? ", …" : ""}). Results differ from the data file.
    <a href="#/adjustments">Manage adjustments</a>`;
  b.hidden = false;
}

function parseHash() {
  const raw = location.hash.replace(/^#\/?/, "");
  const [path, qs] = raw.split("?");
  const parts = path.split("/").filter(Boolean).map(decodeURIComponent);
  return { route: parts[0] || "ranking", arg: parts[1] || "", params: new URLSearchParams(qs || "") };
}

function setHash(route, arg, params, replace = false) {
  const qs = new URLSearchParams(Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== "")).toString();
  const h = "#/" + route + (arg ? "/" + encodeURIComponent(arg) : "") + (qs ? "?" + qs : "");
  if (replace) history.replaceState(null, "", h); else location.hash = h;
}

let loadingCount = 0;
function loading(on, text = "Loading…") {
  loadingCount += on ? 1 : -1;
  $("#loading-text").textContent = text;
  $("#loading").hidden = loadingCount <= 0;
}

let toastTimer;
function toast(msg, error = false) {
  const t = $("#toast");
  t.textContent = msg; t.className = "toast" + (error ? " error" : ""); t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), error ? 7000 : 3500);
}

async function api(url, opts = {}, text) {
  // La primera consulta a un archivo nuevo tarda unos segundos (carga; un .xlsx sin caché, hasta ~1 min)
  let shown = false;
  const timer = setTimeout(() => { shown = true; loading(true, text || "Processing the data…"); }, 250);
  try {
    return await localApi(url, opts);
  } finally {
    clearTimeout(timer);
    if (shown) loading(false);
  }
}

function selectHtml(id, values, current, allLabel = "(All)") {
  const opts = [`<option value="all"${current === "all" ? " selected" : ""}>${allLabel}</option>`]
    .concat(values.map(v => `<option${v === current ? " selected" : ""}>${esc(v)}</option>`));
  return `<select id="${id}">${opts.join("")}</select>`;
}

function filterFields(p) {
  const m = state.meta || { express_values: ["No", "Yes"], currency_values: ["CAD", "USD"] };
  // shipments no tiene Express ni moneda (todo en USD): quedan ocultos en "all"
  if (isShip()) return `<input type="hidden" id="f-express" value="all"><input type="hidden" id="f-currency" value="all">`;
  return `
    <div class="field"><label for="f-express">Bid_Item_Is_Express</label>${selectHtml("f-express", m.express_values, p.express)}</div>
    <div class="field"><label for="f-currency">Currency</label>${selectHtml("f-currency", m.currency_values, p.currency)}</div>`;
}

function commonParams(params) {
  return { express: params.get("express") || "all", currency: params.get("currency") || "all", tce: params.get("tce") || "N" };
}

// Selector TCE_Actual (filtro de página de la pivot). Default N = TCE Proximity, como el Excel.
function tceField(p) {
  const opts = [...TCE_VALUES.slice().sort((a, b) => (a === "N" ? -1 : b === "N" ? 1 : 0)), "all"]
    .map(v => `<option value="${esc(v)}"${v === p.tce ? " selected" : ""}>${v === "all" ? "(All)" : esc(v)}</option>`).join("");
  return `<div class="field"><label for="f-tce">${L.tceCol}</label><select id="f-tce">${opts}</select></div>`;
}
const filterQs = p => new URLSearchParams({ express: p.express, currency: p.currency, tce: p.tce }).toString();
// Texto de la métrica según el filtro TCE_Actual
const linesLabel = tce => tce === "N" ? "TCE Proximity" : tce === "all" ? (isShip() ? "SBBs" : "Lines") : `${tce} ${L.lines}`;
const linesHint = tce => tce === "N"
  ? `TCE Proximity = number of ${L.lines} with ${L.tceCol} = N in the ${L.item}.`
  : `Showing the number of ${L.lines} with ${L.tceCol} = ${tce === "all" ? "any value" : tce} in each ${L.item} (TCE Proximity uses N).`;

async function downloadLink(url) {
  loading(true, "Preparing the Excel file…");
  try { await exportUrl(url); } catch (e) { toast(e.message, true); } finally { loading(false); }
}

// ---------------------------------------------------------------- archivo CSV (local)
// Origen de datos (Quotes / Shipments): lo define el archivo abierto (el CSV de shipments se reconoce por sus columnas)
const TAB_TEXT = {
  quote: ["2. Quote Detail", "2. Order Detail"], fc: ["3. Proximity by FC", "3. Proximity by SBB"],
  dependency: ["4. Dependency by FC", "4. Dependency by SBB"], bids: ["5. Bid-Item Ranking", "5. Config Ranking"],
};
function drawSource() {
  const src = state.meta?.source || state.source || "quotes", ship = src === "shipments";
  state.source = src;
  $$("#source-seg [data-source]").forEach(b => { b.classList.toggle("on", b.dataset.source === src); b.setAttribute("aria-pressed", String(b.dataset.source === src)); });
  $("#geo-label").hidden = $("#geo-select").hidden = !(ship && state.meta);
  if (ship && state.meta) $("#geo-select").innerHTML = SHIP_GEOS.map(g => `<option${g === state.meta.geo ? " selected" : ""}>${esc(g)}</option>`).join("");
  $$("#tabs a").forEach(a => { const t = TAB_TEXT[a.dataset.view]; if (t) a.textContent = t[ship ? 1 : 0]; });
}
async function loadMeta() {
  try {
    state.meta = await api("/api/meta");
    const m = state.meta;
    $("#meta-line").textContent = isShip()
      ? `Shipments ${m.geo} · ${m.file} · ${fmt(m.rows)} SBB rows · ${fmt(m.quotes)} orders · ${fmt(m.bids)} configs (${fmt(m.tce_configs)} full TCE) · ${usdShort(m.value_usd)} · ship date ${m.contract_start_min} → ${m.contract_start_max}`
      : `${m.file} · ${fmt(m.rows)} lines · ${fmt(m.quotes)} bids · ${fmt(m.bids)} bid-items (${fmt(m.tce_configs)} full TCE) · ${usdShort(m.value_usd)} · contract start ${m.contract_start_min} → ${m.contract_start_max}`;
    $("#file-name").textContent = m.file;
    drawAdjBanner();
  } catch (e) {
    state.meta = null;
    $("#meta-line").textContent = "No file open";
  }
  drawSource();
}
const afterSourceChange = async () => { state.rankingOpen = {}; state.fcOpen = {}; state.depOpen = {}; await loadMeta(); render(); };
$$("#source-seg [data-source]").forEach(b => b.addEventListener("click", async () => {
  const src = b.dataset.source;
  if (b.classList.contains("on")) return;
  loading(true, src === "shipments" ? "Loading shipments…" : "Loading quotes…");
  let done = false;
  try { done = await localSwitch(src, $("#geo-select").value || undefined); }
  catch (e) { toast(e.message, true); } finally { loading(false); }
  if (done) return afterSourceChange();
  // origen todavía no abierto en esta sesión: reabrir el último archivo de ese origen o elegir uno
  state.source = src; state.meta = null; drawSource();
  $("#meta-line").textContent = "No file open";
  render();
}));
$("#geo-select").addEventListener("change", async e => {
  loading(true, `Loading shipments ${e.target.value}…`);
  try { await localGeo(e.target.value); toast(`Shipments · ${e.target.value}`); }
  catch (err) { toast(err.message, true); } finally { loading(false); }
  afterSourceChange();
});

async function openCsv(file) {
  if (!file) return;
  if (!/\.(csv|xlsx)$/i.test(file.name)) { toast("Please choose an .xlsx or .csv file", true); return; }
  loading(true, `Reading ${file.name}… (large files take a few seconds; the first open of an .xlsx up to ~1-2 min)`);
  try {
    await localLoad(file);
    state.rankingOpen = {}; state.fcOpen = {}; state.depOpen = {};
    await loadMeta();
    toast(`Opened ${file.name} · ${fmt(state.meta.rows)} lines (processed locally)`);
    render();
  } catch (e) {
    toast(e.message, true);
  } finally {
    loading(false);
  }
}

async function chooseCsv() {
  if (canPickFiles()) {
    try { return await openCsv(await pickFile()); }
    catch (e) { if (e.name === "AbortError") return; }   // otro error -> selector clásico
  }
  $("#file-input").click();
}

$("#open-btn").addEventListener("click", chooseCsv);
$("#file-input").addEventListener("change", e => { const f = e.target.files[0]; e.target.value = ""; openCsv(f); });
document.addEventListener("dragover", e => e.preventDefault());
document.addEventListener("drop", e => {
  e.preventDefault();
  const f = e.dataTransfer?.files?.[0];
  if (f) openCsv(f);
});

// Pantalla inicial: todavía no hay archivo abierto
async function renderWelcome() {
  const ship = (state.source || "quotes") === "shipments";
  const last = canPickFiles() ? await lastHandle(ship ? "shipments" : "quotes") : null;
  view.innerHTML = `
    <div class="welcome">
      <h2>Open a ${ship ? "shipments" : "quotes"} data file to start</h2>
      <p>${ship ? `Choose the shipments extraction (.csv of the Magellan query, all geos in one file, for example <em>shipments 2026 oct30.csv</em>)
        or drag and drop it on this page. It is analysed by SBB; pick the geo (NA, AP, LA, Europe, META) at the top.` : `Choose the LUDP quotes extraction (for example <em>NA Quotes Oct28.xlsx</em>, or a .csv export) or drag and drop it on this page.
        The first time, a large .xlsx takes up to 1-2 minutes to read; it is then kept in this browser and reopens in seconds.`}</p>
      <div class="welcome-actions">
        ${last ? `<button class="btn primary" id="w-reopen">Reopen ${esc(last.name)}</button>` : ""}
        <button class="btn${last ? "" : " primary"}" id="w-open">Open data file…</button>
      </div>
      <div class="privacy"><strong>Your data stays on this computer.</strong> The file is read and processed by your
        browser only; it is never uploaded to any server. TCE adjustments are saved in this browser.</div>
    </div>`;
  $("#w-open").onclick = chooseCsv;
  if (last) $("#w-reopen").onclick = async () => {
    try {
      const f = await reopenLast(ship ? "shipments" : "quotes");
      if (f) await openCsv(f); else toast("Permission to read the file was not granted. Use 'Open data file…'.", true);
    } catch (e) { toast(`Cannot reopen ${last.name}: ${e.message}. Use 'Open data file…'.`, true); }
  };
}

// ------------------------------------------------------- 1. Clasificación
async function renderRanking(params) {
  const p = commonParams(params);
  const prox = params.get("prox") || "";
  const q = params.get("q") || "";
  const multi = multiParams(params, ["countries", "forecasts", "statuses"]);
  view.innerHTML = `
    <div class="view-head"><h2>TCE Proximity Classification</h2>
      <span class="hint">${linesHint(p.tce)} Click a ${L.item} to see its detail.</span></div>
    <div class="toolbar">
      ${filterFields(p)}
      ${tceField(p)}
      <div class="field"><label for="f-q">Search</label><input type="search" id="f-q" placeholder="${isShip() ? "customer, segment, SO, config, family" : "opp, opp status, account, bid, bid-item, product"}" value="${esc(q)}" size="16"></div>
      ${multiFieldsHtml(multi, true)}
      <div class="spacer"></div>
      <div class="actions">
        <button class="btn" id="expand-all">Expand all</button>
        <button class="btn" id="collapse-all">Collapse all</button>
        <button class="btn primary" id="export">Export to Excel</button>
      </div>
    </div>
    <div id="body"><div class="empty">Loading…</div></div>`;

  const go = (extra = {}, replace = false) => setHash("ranking", "", { ...p, ...multiHash(multi), prox, q: $("#f-q").value.trim(), ...extra }, replace);
  $("#f-express").onchange = e => { p.express = e.target.value; go(); };
  $("#f-currency").onchange = e => { p.currency = e.target.value; go(); };
  $("#f-tce").onchange = e => { p.tce = e.target.value; go({ prox: "" }); };
  wireMultiFields(multi, sel => go(multiHash(sel)));
  const qs = multiQs(new URLSearchParams(filterQs(p)), multi).toString();
  let t; $("#f-q").oninput = () => {
    clearTimeout(t);
    t = setTimeout(() => { go({}, true); if (data) drawRanking(data, prox, $("#f-q").value.trim()); }, 200);
  };
  $("#export").onclick = () => downloadLink(`/api/export/ranking.xlsx?${qs}`);

  let data;
  try {
    data = await api(`/api/ranking?${qs}`);
  } catch (e) { $("#body").innerHTML = `<div class="empty">${esc(e.message)}</div>`; return; }

  $("#expand-all").onclick = () => { data.opps.forEach(o => state.rankingOpen[o.opp_number + "|" + o.account] = true); drawRanking(data, prox, $("#f-q").value.trim()); };
  $("#collapse-all").onclick = () => { data.opps.forEach(o => state.rankingOpen[o.opp_number + "|" + o.account] = false); drawRanking(data, prox, $("#f-q").value.trim()); };
  drawRanking(data, prox, q);
}

function drawRanking(data, prox, q) {
  const s = data.summary;
  const chips = Object.entries(s.distribution).map(([k, v]) =>
    `<button class="chip${prox === k ? " on" : ""}" data-prox="${k}">${data.filters.tce === "N" || !data.filters.tce ? "Proximity" : "Lines"} ${proxBadge(Number(k))}<span class="n">${fmt(v)}</span></button>`).join("");
  const ql = q.toLowerCase();
  const match = (o, qq, b) => !ql || [o.opp_number, o.forecast, o.account, qq.quotenumber, b.bid_item, b.product].some(x => String(x).toLowerCase().includes(ql));

  const rows = [];
  let shownBids = 0;
  for (const o of data.opps) {
    const key = o.opp_number + "|" + o.account;
    const noopp = o.opp_number === "(no opp)" || o.opp_number === L.noOpp;
    const bids = [];
    for (const qq of o.quotes) for (const b of qq.bids)
      if ((!prox || String(b.proximity) === prox) && match(o, qq, b)) bids.push([qq, b]);
    if (!bids.length) continue;
    shownBids += bids.length;
    const filtered = prox || ql;
    const open = state.rankingOpen[key] ?? (filtered ? true : !noopp);
    const toggle = `<button class="toggle" data-key="${esc(key)}" title="${open ? "Collapse" : "Expand"}">${open ? "−" : "+"}</button>`;
    // El grupo "(no opp)" no lleva subtítulo (mezcla bids de muchas cuentas; no es relevante)
    const counts = noopp ? "" : bidsSummary(bids);
    const oppValue = bids.reduce((a, [, b]) => a + (b.value_usd || 0), 0);
    const oppTotal = noopp ? "" : `<div class="opp-total">${counts} · <span title="Sum of the ${L.item} values shown (USD)">${usdShort(oppValue)}</span></div>`;
    if (!open) {
      rows.push(`<tr class="opp-first collapsed${noopp ? " noopp" : ""}">
        <td class="opp-cell">${toggle}<span class="mono">${esc(o.opp_number)}</span></td><td class="nowrap">${esc(o.forecast)}</td><td>${esc(o.account)}</td>
        <td colspan="3" class="muted">${counts ? counts + " — " : ""}click + to see the detail</td>
        <td></td><td class="num muted" title="Sum of the ${L.item} values (USD)">${money(oppValue)}</td></tr>`);
      continue;
    }
    let lastQuote = null;
    bids.forEach(([qq, b], i) => {
      const firstQ = qq.quotenumber !== lastQuote; lastQuote = qq.quotenumber;
      rows.push(`<tr class="${i === 0 ? "opp-first" : ""}">
        <td class="opp-cell">${i === 0 ? toggle + `<span class="mono">${esc(o.opp_number)}</span>` : ""}</td>
        <td class="nowrap">${i === 0 ? esc(o.forecast) : ""}</td>
        <td>${i === 0 ? esc(o.account) + oppTotal : ""}</td>
        <td class="mono">${firstQ ? `<a href="#/quote/${encodeURIComponent(qq.quotenumber)}">${esc(qq.quotenumber)}</a>` : ""}</td>
        <td class="mono"><a href="#/quote/${encodeURIComponent(qq.quotenumber)}?bid=${encodeURIComponent(b.bid_item)}" title="${esc(b.bid_item)}">${esc(itemLabel(b.bid_item))}</a></td>
        <td>${esc(b.product)}</td>
        <td class="num">${proxBadge(b.proximity)}</td>
        <td class="num">${money(b.value_usd)}</td></tr>`);
    });
  }

  $("#body").innerHTML = `
    <div class="kpis">
      <div class="kpi"><div class="v">${fmt(s.opps)}</div><div class="l">${L.opps}</div></div>
      <div class="kpi"><div class="v">${fmt(s.quotes)}</div><div class="l">${L.quotes}</div></div>
      ${isShip() ? `<div class="kpi"><div class="v">${fmt(s.bids)}</div><div class="l">Configs</div></div>` : `
      <div class="kpi"><div class="v">${fmt(s.bids_with_opp)}</div><div class="l">Bid-items with opp</div></div>
      <div class="kpi"><div class="v">${fmt(s.bids_without_opp)}</div><div class="l">Bid-items without opp</div></div>`}
      <div class="kpi"><div class="v">${fmt(s.distribution["1"] || 0)}</div><div class="l">${data.filters.tce === "N" ? `${L.Items} 1 ${L.line} away from TCE` : `${L.Items} with exactly 1 ${L.line}`}</div></div>
      <div class="kpi" title="${esc(L.valueHint)}"><div class="v">${usdShort(s.value_usd)}</div><div class="l">Value of these ${L.items} (USD)</div></div>
    </div>
    <div class="toolbar"><div class="chips"><span class="muted">Filter by proximity:</span>
      <button class="chip${!prox ? " on" : ""}" data-prox="">All<span class="n">${fmt(s.bids)}</span></button>${chips}</div></div>
    <div class="table-wrap"><table>
      <thead><tr><th>${L.oppCol}</th><th>${L.oppStatusCol}</th><th>${L.accountCol}</th><th>${L.quoteCol}</th><th>${L.itemCol}</th>
        <th>${L.productCol}</th><th class="num">${linesLabel(data.filters.tce || "all")}</th>
        <th class="num" title="${esc(L.valueHint)}">${L.value}</th></tr></thead>
      <tbody>${rows.join("") || `<tr><td colspan="8" class="empty">No results</td></tr>`}</tbody>
    </table></div>
    <div class="count">${fmt(shownBids)} ${L.items} shown</div>`;

  $$(".toggle", $("#body")).forEach(btn => btn.onclick = () => {
    const k = btn.dataset.key;
    const cur = btn.textContent === "−";
    state.rankingOpen[k] = !cur;
    drawRanking(data, prox, q);
  });
  $$(".chip[data-prox]", $("#body")).forEach(c => c.onclick = () => {
    const { params } = parseHash();
    setHash("ranking", "", { ...commonParams(params), ...multiHash(multiParams(params, ["countries", "forecasts", "statuses"])),
      prox: c.dataset.prox, q: $("#f-q").value.trim() });
  });
}

// ------------------------------------------------------- 2. Detalle quote
const DETAIL_COLS_Q = [
  { key: "item", label: "Bid_Item", cls: "mono" },
  { key: "bid_pn", label: "bid_PN", cls: "mono" },
  { key: "product", label: "quotelines_productcategoryname_3" },
  { key: "express", label: "Bid_Item_Is_Express" },
  { key: "featurecode", label: "featurecode", cls: "mono" },
  { key: "description", label: "description" },
  // cantidad de sistemas del bid-item (fuera del grupo TCE; filtro de texto, sin totales)
  { key: "quotelines_quantity", label: "quotelines_quantity", qty: true },
  { key: "N", label: "N", num: true },
  { key: "Y", label: "Y", num: true },
  { key: "Not Mapped", label: "Not Mapped", num: true },
  // revenue contribution del FC en todo el archivo (USD): sin filtro, sin total
  { key: "rev_contrib_usd", label: "FC rev contrib (USD)", usd: true,
    title: "Revenue contribution of the feature code: sum of the USD value of every configuration in the file that includes it (TCE or not)." },
];
// shipments: sin Express; SBB con sus FC(s) y basicname de referencia
const DETAIL_COLS_S = [
  { key: "item", label: "mfgsoline", cls: "mono" },
  { key: "bid_pn", label: "mtm", cls: "mono" },
  { key: "product", label: "family" },
  { key: "featurecode", label: "sbb", cls: "mono" },
  { key: "description", label: "productid_des" },
  { key: "ref_fc", label: "fc", cls: "mono" },
  { key: "basicname", label: "basicname" },
  { key: "quotelines_quantity", label: "qty", qty: true },
  { key: "N", label: "N", num: true },
  { key: "Y", label: "Y", num: true },
  { key: "Not Mapped", label: "Not Mapped", num: true },
  { key: "rev_contrib_usd", label: "SBB rev contrib (USD)", usd: true,
    title: "Revenue contribution of the SBB: sum of the USD value of every configuration of this geo that includes it (TCE or not)." },
];

async function renderQuote(quote, params) {
  const bid = params.get("bid") || "";
  const DETAIL_COLS = isShip() ? DETAIL_COLS_S : DETAIL_COLS_Q;
  const nBefore = DETAIL_COLS.findIndex(c => c.key === "N");   // columnas antes del grupo TCE
  view.innerHTML = `
    <div class="view-head"><h2>${isShip() ? "Order Detail" : "Quote Detail"}</h2>
      <span class="hint">Sum of ${L.qtyName} by ${L.code} and ${L.tceCol}. Rows in red have N ${L.lines} (they block TCE).</span></div>
    <div class="toolbar quote-bar">
      <div class="field"><label for="q-input">${L.quoteCol}</label>
        <input type="text" id="q-input" list="q-list" value="${esc(quote)}" placeholder="paste the ${isShip() ? "SO" : "quote"} number here" autocomplete="off"></div>
      <datalist id="q-list"></datalist>
      <button class="btn primary" id="q-go">View</button>
      <div class="spacer"></div>
      <div class="actions"><a class="btn" href="#/ranking">← Back to classification</a>
        ${quote ? `<button class="btn" id="q-export">Export to Excel</button>` : ""}</div>
    </div>
    <div id="body">${quote ? `<div class="empty">Loading…</div>` : `<div class="empty">Enter ${isShip() ? "an SO" : "a quote"} number or pick a ${L.item} from the classification.</div>`}</div>`;

  const go = () => { const v = $("#q-input").value.trim(); if (v) setHash("quote", v, {}); };
  $("#q-go").onclick = go;
  $("#q-input").onkeydown = e => { if (e.key === "Enter") go(); };
  let t; $("#q-input").oninput = e => {
    clearTimeout(t);
    t = setTimeout(async () => {
      const v = e.target.value.trim();
      if (v.length < 4) return;
      const list = await localApi(`/api/search?q=${encodeURIComponent(v)}`).catch(() => []);
      $("#q-list").innerHTML = list.map(x => `<option value="${esc(x)}">`).join("");
    }, 200);
  };
  if (!quote) { $("#q-input").focus(); return; }

  let data;
  try { data = await api(`/api/quote/${encodeURIComponent(quote)}`); }
  catch (e) { $("#body").innerHTML = `<div class="empty">${esc(e.message)}</div>`; return; }

  const st = { bid: data.bids.some(b => b.bid_item === bid) ? bid : "", f: {}, onlyN: false };
  $("#q-export").onclick = () => downloadLink(`/api/export/quote/${encodeURIComponent(quote)}.xlsx${st.bid ? "?bid=" + encodeURIComponent(st.bid) : ""}`);

  const h = data.header;
  const hv = (k, v, big) => `<div class="${big ? "big" : ""}"><div class="k">${k}</div><div class="v">${esc(v || "—")}</div></div>`;
  const headerHtml = isShip() ? `
      ${hv("Order (SO)", data.quote, true)}${hv("Customer number", h.opp_number, true)}${hv("Customer", h.account, true)}
      ${hv("Segment", h.forecast)}${hv("Ship status", h.status)}${hv("Country", h.country)}
      ${hv("Ship date", h.contract_start)}${hv("Order date", h.created)}${hv("Order type · plant", `${h.quotetype} · ${h.fulfillment}`)}
      ${hv("SO value (USD)", h.value_usd == null ? "" : "$" + money(h.value_usd))}${hv("Order TCE flag (tce)", h.order_tce)}${hv("CTO", h.cto)}` : `
      ${hv("Quote", data.quote, true)}${hv("Opportunity", h.opp_number, true)}${hv("Account", h.account, true)}
      ${hv("Forecast", h.forecast === "" ? "" : h.forecast)}${hv("Sales rep", h.sales_rep)}${hv("Status", h.status)}
      ${hv("Country / currency", `${h.country} · ${h.currency}`)}${hv("Contract start", h.contract_start)}
      ${hv("Created", h.created)}${hv("Type", `${h.quotetype} · ${h.fulfillment}`)}
      ${hv("Total quote (final price)", `${money(h.total_final_price)} ${h.currency}`)}${hv("Quote value (USD)", h.value_usd == null ? "" : "$" + money(h.value_usd))}
      ${hv("End customer", h.end_customer)}`;
  $("#body").innerHTML = `
    <div class="header-grid">${headerHtml}
    </div>
    <div class="toolbar">
      <div class="chips bidchips" id="bidchips"></div>
      <div class="spacer"></div>
      <label class="chips"><input type="checkbox" id="only-n"> Only ${L.lines} with N</label>
      <button class="btn" id="clear-f">Clear filters</button>
    </div>
    <div class="table-wrap"><table>
      <thead>
        <tr><th colspan="${nBefore}"></th><th colspan="3" class="group">TCE</th><th></th></tr>
        <tr>${DETAIL_COLS.map(c => `<th class="${c.num || c.qty || c.usd ? "num" : ""}"${c.title ? ` title="${esc(c.title)}"` : ""}>${c.label}</th>`).join("")}</tr>
        <tr class="filters">${DETAIL_COLS.map(c => c.usd ? "<th></th>" : c.num
          ? `<th><select data-f="${c.key}" aria-label="Filter ${c.label}"><option value="">all</option><option value="gt0">&gt; 0</option><option value="eq0">= 0</option></select></th>`
          : `<th><input type="search" data-f="${c.key}" placeholder="filter" aria-label="Filter ${c.label}"></th>`).join("")}</tr>
      </thead>
      <tbody id="d-body"></tbody>
      <tfoot><tr id="d-foot"></tr></tfoot>
    </table></div>
    <div class="count" id="d-count"></div>`;

  const drawChips = () => {
    $("#bidchips").innerHTML = `<span class="muted">${L.Item}:</span>
      <button class="chip${!st.bid ? " on" : ""}" data-bid="">Whole ${L.quoteLow}<span class="n">${data.bids.length} ${data.bids.length === 1 ? L.item : L.items}</span></button>` +
      data.bids.map(b => `<button class="chip${st.bid === b.bid_item ? " on" : ""}" data-bid="${esc(b.bid_item)}"
        title="${esc(b.product)} · ${esc(b.bid_pn)}${isShip() ? "" : " · Express " + esc(b.express)} · value ${b.value_usd == null ? "n/a" : "$" + money(b.value_usd)} USD">${esc(b.item)} · ${esc(b.product)}<span class="n">prox ${b.proximity}${b.value_usd == null ? "" : " · " + usdShort(b.value_usd)}</span></button>`).join("");
    $$(".chip", $("#bidchips")).forEach(c => c.onclick = () => {
      st.bid = c.dataset.bid;
      setHash("quote", quote, { bid: st.bid }, true);
      drawChips(); drawRows();
    });
  };

  const drawRows = () => {
    const rows = data.rows.filter(r => {
      if (st.bid && r.bid_item !== st.bid) return false;
      if (st.onlyN && !(r.N > 0)) return false;
      for (const [k, v] of Object.entries(st.f)) {
        if (!v) continue;
        const c = DETAIL_COLS.find(x => x.key === k);
        if (c.usd) continue;
        if (c.num) { if (v === "gt0" && !(r[k] > 0)) return false; if (v === "eq0" && r[k] !== 0) return false; }
        else if (!String(r[k]).toLowerCase().includes(v.toLowerCase())) return false;
      }
      return true;
    });
    const cell = (c, r) => {
      const v = r[c.key];
      if (c.qty) return `<td class="num">${v == null ? "" : fmt(v)}</td>`;
      if (c.usd) return `<td class="num muted">${money(v)}</td>`;
      if (c.num) {
        const cls = v === 0 ? "zero" : c.key === "N" ? "nval" : c.key === "Y" ? "yval" : "";
        return `<td class="num ${cls}">${fmt(v)}</td>`;
      }
      if (c.key === "featurecode" && r.adjusted_from) {
        return `<td class="${c.cls || ""}">${esc(v)} <a class="adj-tag" href="#/adjustments/${encodeURIComponent(v)}"
          title="TCE adjusted: ${esc(r.adjusted_from)} in the data file">adj. ${esc(tceShort(r.adjusted_from))}→${esc(tceShort(adjustedTo(v)))}</a></td>`;
      }
      return `<td class="${c.cls || ""}">${esc(v)}</td>`;
    };
    $("#d-body").innerHTML = rows.map(r => `<tr class="${r.N > 0 ? "has-n" : ""}">${DETAIL_COLS.map(c => cell(c, r)).join("")}</tr>`).join("")
      || `<tr><td colspan="${DETAIL_COLS.length}" class="empty">No rows match these filters</td></tr>`;
    const sum = k => rows.reduce((a, r) => a + (r[k] || 0), 0);
    const nLines = rows.filter(r => r.N > 0).length;
    $("#d-foot").innerHTML = `<td colspan="${nBefore - 1}">Total (${fmt(rows.length)} rows · ${nLines} ${L.code} in N)</td><td></td>
      <td class="num">${fmt(sum("N"))}</td><td class="num">${fmt(sum("Y"))}</td><td class="num">${fmt(sum("Not Mapped"))}</td><td></td>`;
    $("#d-count").textContent = `${fmt(rows.length)} of ${fmt(data.rows.length)} rows`;
  };

  $$("[data-f]", $("#body")).forEach(el => el.addEventListener("input", () => { st.f[el.dataset.f] = el.value; drawRows(); }));
  $("#only-n").onchange = e => { st.onlyN = e.target.checked; drawRows(); };
  $("#clear-f").onclick = () => { st.f = {}; st.onlyN = false; $("#only-n").checked = false; $$("[data-f]", $("#body")).forEach(el => el.value = ""); drawRows(); };
  drawChips(); drawRows();
}

// ------------------------------------------------------- 3. Ranking por FC
async function renderFc(params) {
  // Sistemas elegidos: en la URL como "products=A|B"; vacío = todos
  const multi = multiParams(params, ["products"]);
  // Proximity: selección múltiple, en la URL "prox=1|2" (default 1; "all" = todas)
  const proxSel = (params.get("prox") ?? "1").split("|").filter(x => x && x !== "all");
  const p = commonParams(params);
  view.innerHTML = `
    <div class="view-head"><h2>TCE Proximity - Top ${isShip() ? "SBB" : "Feature Code"} Detractors to be TCE Config</h2>
      <span class="hint">Configs = ${L.items} that meet the criteria. Click ${isShip() ? "an SBB" : "an FC"} to see the affected ${L.items}.</span></div>
    <div class="toolbar">
      <div class="ms-group inline"><div class="field"><label for="f-prox">TCE Proximity</label><div id="f-prox-box"></div></div>
        <div class="sel-chips" id="sel-prox">${proxSel.map(selChipHtml).join("")}</div></div>
      ${filterFields(p)}
      ${multiFieldsHtml(multi)}
      <div class="actions"><button class="btn primary" id="export">Export to Excel</button></div>
    </div>
    <div id="body"><div class="empty">Loading…</div></div>`;

  const go = (sel = multi, prox = proxSel, extra = {}) => setHash("fc", "", { ...p, prox: prox.length ? prox.join("|") : "all",
    express: $("#f-express").value, currency: $("#f-currency").value, ...multiHash(sel), ...extra });
  ["#f-express", "#f-currency"].forEach(s => $(s).onchange = () => go());
  wireMultiFields(multi, go);
  $$("[data-remove]", $("#sel-prox")).forEach(b => b.onclick = () => go(multi, proxSel.filter(x => x !== b.dataset.remove)));
  const qsp = multiQs(new URLSearchParams({ express: p.express, currency: p.currency }), multi);
  (proxSel.length ? proxSel : ["all"]).forEach(x => qsp.append("proximity", x));
  const qs = qsp.toString();
  $("#export").onclick = () => downloadLink(`/api/export/fc-ranking.xlsx?${qs}`);

  // mientras carga, el selector muestra lo elegido; las opciones llegan con la respuesta
  multiSelect($("#f-prox-box"), proxSel, proxSel, "All", "values", v => go(multi, v), "f-prox");
  let data;
  try { data = await api(`/api/fc-ranking?${qs}`); }
  catch (e) { $("#body").innerHTML = `<div class="empty">${esc(e.message)}</div>`; return; }
  const proxVals = [...new Set([...data.proximity_values.map(String), ...proxSel])].sort((a, b) => a - b);
  multiSelect($("#f-prox-box"), proxVals, proxSel, "All", "values", v => go(multi, v), "f-prox");

  const max = Math.max(1, ...data.rows.map(r => r.configs));
  const fcKey = qs;
  const open = state.fcOpen[fcKey] || (state.fcOpen[fcKey] = {});
  // orden: el del Excel (configs desc) o el de la columna elegida (clic en el título)
  const st = sortState("fc");
  const draw = () => {
    const list = sortRows(data.rows, st);
    const rows = list.map(r => {
      const pct = data.configs_in_scope ? (100 * r.configs / data.configs_in_scope) : 0;
      let html = `<tr class="fc-row" data-fc="${esc(r.featurecode)}">
        <td class="nowrap"><button class="toggle" tabindex="-1">${open[r.featurecode] ? "−" : "+"}</button><span class="mono">${esc(r.featurecode)}</span></td>
        <td>${esc(r.description)}</td>${refTd(r)}
        <td class="num">${fmt(r.configs)}</td>
        <td class="num muted">${pct.toFixed(1)}%</td>
        <td><div class="bar"><span style="width:${(100 * r.configs / max).toFixed(1)}%"></span></div></td>
        <td class="num">${usdM(r.rev_contrib_usd)}</td>
        <td class="num muted">${pctFmt(r.rev_pct)}</td>
        <td class="num muted">${r.rev_rank}</td>
        <td class="num">${usdM(r.value_in_scope_usd)}</td></tr>`;
      if (open[r.featurecode]) {
        html += `<tr class="fc-detail"><td colspan="${9 + refN()}"><table><thead><tr><th>${L.itemCol}</th><th>${L.quoteCol}</th><th>${L.oppCol}</th><th>${L.account}</th><th>${L.product}</th><th class="num">TCE Proximity</th><th class="num">${L.value}</th></tr></thead><tbody>
          ${r.bids.map(b => `<tr><td class="mono"><a href="#/quote/${encodeURIComponent(b.quotenumber)}?bid=${encodeURIComponent(b.bid_item)}" title="${esc(b.bid_item)}">${esc(itemLabel(b.bid_item))}</a></td>
            <td class="mono">${esc(b.quotenumber)}</td><td class="mono">${esc(b.opp_number)}</td><td>${esc(b.account)}</td><td>${esc(b.product)}</td><td class="num">${proxBadge(b.proximity)}</td><td class="num">${money(b.value_usd)}</td></tr>`).join("")}
          </tbody></table></td></tr>`;
      }
      return html;
    }).join("");
    $("#body").innerHTML = `
      <div class="kpis">
        <div class="kpi"><div class="v">${fmt(data.configs_in_scope)}</div><div class="l">Configs in scope</div></div>
        <div class="kpi"><div class="v">${fmt(data.lines_in_scope)}</div><div class="l">TCE=N ${L.lines} in scope</div></div>
        <div class="kpi"><div class="v">${fmt(data.rows.length)}</div><div class="l">Distinct ${L.codes}</div></div>
        <div class="kpi" title="${esc(L.valueHint)}"><div class="v">${usdShort(data.value_in_scope_usd)}</div><div class="l">Value of configs in scope (USD)</div></div>
      </div>
      <div class="table-wrap"><table>
        <thead><tr>${sortTh(L.code, "featurecode", st)}${sortTh("Description", "description", st)}${refTh(st)}${sortTh("Nbr of Configs", "configs", st, "num")}${sortTh("% configs", "configs", st, "num")}<th></th>
          ${sortTh("Rev Contrib (USD)", "rev_contrib_usd", st, "num", `Revenue contribution: USD value of every configuration with this ${L.code} within the filters, TCE or not (revenue_contribution of the query)`)}
          ${sortTh("% Rev", "rev_pct", st, "num", `Share of the Rev Contrib of the listed ${L.codes}`)}
          ${sortTh("Rank Rev", "rev_rank", st, "num", "Rank by Rev Contrib")}
          ${sortTh("Value of configs in scope (USD)", "value_in_scope_usd", st, "num", `USD value of the configs in scope that this ${L.code} blocks (what would become TCE if the ${L.code} were mapped)`)}</tr></thead>
        <tbody>${rows || `<tr><td colspan="${9 + refN()}" class="empty">No configs match these criteria</td></tr>`}</tbody>
      </table></div>`;
    $$("tr.fc-row", $("#body")).forEach(tr => tr.onclick = e => {
      if (e.target.closest("a")) return;
      open[tr.dataset.fc] = !open[tr.dataset.fc]; draw();
    });
    wireSort($("#body"), st, data.rows, draw);
  };
  draw();
}

// ------------------------------------------------------- 4. TCE Dependency
async function renderDependency(params) {
  const multi = multiParams(params, ["products"]);
  const p = commonParams(params);
  view.innerHTML = `
    <div class="view-head"><h2>TCE Dependency - ${isShip() ? "SBBs" : "Feature Codes"} Most Relied On by TCE Configs</h2>
      <span class="hint">${isShip() ? "SBBs (sbb_tce_flag" : "Feature codes (TCE_Actual"} = Y) present in the configurations that are fully TCE (TCE Proximity = 0).
        Changing one of them to N would take those configs out of TCE. Click ${isShip() ? "an SBB" : "an FC"} to see its TCE configs.</span></div>
    <div class="toolbar">
      ${filterFields(p)}
      ${multiFieldsHtml(multi)}
      <div class="actions"><button class="btn primary" id="export">Export to Excel</button></div>
    </div>
    <div id="body"><div class="empty">Loading…</div></div>`;
  const go = (sel = multi, extra = {}) => setHash("dependency", "", { express: $("#f-express").value, currency: $("#f-currency").value,
    ...multiHash(sel), ...extra });
  ["#f-express", "#f-currency"].forEach(s => $(s).onchange = () => go());
  wireMultiFields(multi, go);
  const qs = multiQs(new URLSearchParams({ express: p.express, currency: p.currency }), multi).toString();
  $("#export").onclick = () => downloadLink(`/api/export/dependency.xlsx?${qs}`);

  let data;
  try { data = await api(`/api/dependency?${qs}`); }
  catch (e) { $("#body").innerHTML = `<div class="empty">${esc(e.message)}</div>`; return; }
  const open = state.depOpen[qs] || (state.depOpen[qs] = {});
  const configs = {};  // detalle por FC (se pide al abrir la fila)
  const max = Math.max(1, ...data.rows.map(r => r.configs));
  const st = sortState("dependency");
  const LIMIT = 300;
  let showAll = false;
  const draw = () => {
    const list = sortRows(data.rows, st);
    const shown = showAll ? list : list.slice(0, LIMIT);
    const rows = shown.map(r => {
      let html = `<tr class="fc-row" data-fc="${esc(r.featurecode)}">
        <td class="nowrap"><button class="toggle" tabindex="-1">${open[r.featurecode] ? "−" : "+"}</button><span class="mono">${esc(r.featurecode)}</span></td>
        <td>${esc(r.description)}</td>${refTd(r)}
        <td class="num">${fmt(r.configs)}</td>
        <td class="num muted">${pctFmt(r.pct)}</td>
        <td><div class="bar"><span style="width:${(100 * r.configs / max).toFixed(1)}%"></span></div></td>
        <td class="num">${usdM(r.rev_all_usd)}</td>
        <td class="num">${usdM(r.rev_tce_usd)}</td>
        <td class="num muted">${pctFmt(r.tce_share)}</td>
        <td class="num muted">${r.rev_tce_rank}</td></tr>`;
      if (open[r.featurecode]) {
        const c = configs[r.featurecode];
        html += `<tr class="fc-detail"><td colspan="${9 + refN()}">${!c ? `<div class="empty">Loading…</div>` : `<table><thead><tr><th>${L.itemCol}</th><th>${L.quoteCol}</th><th>${L.oppCol}</th><th>${L.account}</th><th>${L.product}</th><th class="num">${L.value}</th></tr></thead><tbody>
          ${c.slice(0, 500).map(b => `<tr><td class="mono"><a href="#/quote/${encodeURIComponent(b.quotenumber)}?bid=${encodeURIComponent(b.bid_item)}" title="${esc(b.bid_item)}">${esc(itemLabel(b.bid_item))}</a></td>
            <td class="mono">${esc(b.quotenumber)}</td><td class="mono">${esc(b.opp_number)}</td><td>${esc(b.account)}</td><td>${esc(b.product)}</td><td class="num">${money(b.value_usd)}</td></tr>`).join("")}
          </tbody></table>${c.length > 500 ? `<div class="count">Showing the 500 highest-value of ${fmt(c.length)} TCE configs.</div>` : ""}`}</td></tr>`;
      }
      return html;
    }).join("");
    $("#body").innerHTML = `
      <div class="kpis">
        <div class="kpi"><div class="v">${fmt(data.tce_configs_in_scope)}</div><div class="l">TCE configs in scope</div></div>
        <div class="kpi"><div class="v">${fmt(data.tce_lines_in_scope)}</div><div class="l">TCE=Y ${L.lines} in scope</div></div>
        <div class="kpi"><div class="v">${fmt(data.rows.length)}</div><div class="l">Distinct ${L.codes}</div></div>
        <div class="kpi" title="${esc(L.valueHint)}"><div class="v">${usdShort(data.tce_value_in_scope_usd)}</div><div class="l">Value of TCE configs (USD)</div></div>
      </div>
      <div class="table-wrap"><table>
        <thead><tr>${sortTh(L.code, "featurecode", st)}${sortTh("Description", "description", st)}${refTh(st)}${sortTh("Nbr of TCE Configs", "configs", st, "num")}${sortTh("% of TCE configs", "pct", st, "num")}<th></th>
          ${sortTh("Rev Contrib All Configs (USD)", "rev_all_usd", st, "num", `USD value of every configuration with this ${L.code} within the filters, TCE or not (revenue_contribution)`)}
          ${sortTh("Rev Contrib TCE Sel (USD)", "rev_tce_usd", st, "num", `USD value of the fully TCE configurations with this ${L.code} (Revenue_Contribution_TCE_Sel)`)}
          ${sortTh("TCE Sel / All", "tce_share", st, "num", `Share of the ${L.code}'s revenue that already sits in TCE configs`)}
          ${sortTh("Rank Rev", "rev_tce_rank", st, "num", "Rank by Rev Contrib TCE Sel")}</tr></thead>
        <tbody>${rows || `<tr><td colspan="${9 + refN()}" class="empty">No TCE configs match these filters</td></tr>`}</tbody>
      </table></div>
      <div class="count">${fmt(shown.length)} of ${fmt(list.length)} ${L.codes}${list.length > shown.length ? ` · <a href="#" id="show-all">show all</a> (or export)` : ""}</div>`;
    $$("tr.fc-row", $("#body")).forEach(tr => tr.onclick = async e => {
      if (e.target.closest("a")) return;
      const fc = tr.dataset.fc;
      open[fc] = !open[fc]; draw();
      if (open[fc] && !configs[fc]) {
        try { configs[fc] = await api(`/api/dependency/${encodeURIComponent(fc)}?${qs}`); }
        catch (err) { configs[fc] = []; toast(err.message, true); }
        draw();
      }
    });
    $("#show-all")?.addEventListener("click", e => { e.preventDefault(); showAll = true; draw(); });
    wireSort($("#body"), st, data.rows, draw);
  };
  draw();
}

// ------------------------------------------------------- 6. WW Ranking
async function renderWw(params) {
  const proxSel = (params.get("prox") ?? "1").split("|").filter(x => x && x !== "all");
  const part = params.get("part") === "dependency" ? "dependency" : "proximity";
  view.innerHTML = `
    <div class="view-head"><h2>WW Ranking - ${part === "proximity" ? "TCE Proximity Detractors" : "TCE Dependency"}${isShip() ? " by SBB (Shipments) across NA / AP / LA / Europe / META" : " across NA / AP / LA / EMEA"}</h2>
      <span class="hint">${isShip() ? `Same as the "WW SBB Proximity" / "WW SBB Dependency" sheets: the 5 geos of the shipments file
        (Europe + META = EMEA of quotes; PRC excluded), values in USD. WW = sum of the geos (they are disjoint).` : `Same as the "TCE Proximity WW Detractors Ranking" workbook: the most recent data file of each geo you choose,
        Express = All, Currency = All, values in USD. WW = sum of the geos (they are disjoint).`}</span></div>
    <div class="toolbar">
      <div class="chips"><button class="chip${part === "proximity" ? " on" : ""}" data-part="proximity">Proximity (detractors)</button>
        <button class="chip${part === "dependency" ? " on" : ""}" data-part="dependency">Dependency (TCE configs)</button></div>
      ${part === "proximity" ? `<div class="ms-group inline"><div class="field"><label for="f-prox">TCE Proximity</label><div id="f-prox-box"></div></div>
        <div class="sel-chips" id="sel-prox">${proxSel.map(selChipHtml).join("")}</div></div>` : ""}
      <div class="spacer"></div>
      <div class="actions"><button class="btn primary" id="export">Export to Excel</button></div>
    </div>
    <div id="body"><div class="empty">Loading… (the first time, each geo file is read from disk; this can take a minute)</div></div>`;
  const go = (extra = {}) => setHash("ww", "", { prox: proxSel.length ? proxSel.join("|") : "all", part: part === "dependency" ? "dependency" : "", ...extra });
  $$(".chip[data-part]").forEach(c => c.onclick = () => go({ part: c.dataset.part === "dependency" ? "dependency" : "" }));
  const qsp = new URLSearchParams();
  (proxSel.length ? proxSel : ["all"]).forEach(x => qsp.append("proximity", x));
  const qs = qsp.toString();
  $("#export").onclick = () => downloadLink(`/api/export/ww.xlsx?${qs}`);
  if (part === "proximity") {
    const PROX_OPTS = ["1", "2", "3", "4", "5"];
    multiSelect($("#f-prox-box"), [...new Set([...PROX_OPTS, ...proxSel])], proxSel, "All", "values", v => go({ prox: v.length ? v.join("|") : "all" }), "f-prox");
    $$("[data-remove]", $("#sel-prox")).forEach(b => b.onclick = () => {
      const v = proxSel.filter(x => x !== b.dataset.remove);
      go({ prox: v.length ? v.join("|") : "all" });
    });
  }

  let data;
  const wwChoose = async (msg) => {
    const last = canPickFiles() ? await lastWwHandles() : null;
    $("#body").innerHTML = `<div class="welcome">
      <h2>WW ranking: choose the geo files</h2>
      <p>${esc(msg || "")} Select the data files of NA, AP, LA and EMEA at once (the geo is taken from the start of each file name,
        e.g. <em>EMEA Quotes Oct28.xlsx</em>; if there are several per geo, the most recent is used). Each file is read in this
        browser, one at a time; files already opened before are reused from the browser cache.</p>
      <div class="welcome-actions">
        ${last?.length ? `<button class="btn primary" id="ww-reopen">Reopen ${last.length} file${last.length > 1 ? "s" : ""} (${esc(last.map(h => h.name).join(", "))})</button>` : ""}
        <button class="btn${last?.length ? "" : " primary"}" id="ww-pick">Choose geo files…</button>
        <input type="file" id="ww-input" accept=".xlsx,.csv" multiple hidden>
      </div></div>`;
    $("#ww-pick").onclick = async () => {
      if (canPickFiles()) {
        try { await pickWwFiles(); return renderWw(parseHash().params); }
        catch (err) { if (err.name === "AbortError") return; }
      }
      $("#ww-input").click();
    };
    $("#ww-input").onchange = e => { setWwFiles([...e.target.files]); renderWw(parseHash().params); };
    if (last?.length) $("#ww-reopen").onclick = async () => {
      try { if (await reopenWwFiles()) renderWw(parseHash().params); else toast("Permission to read the files was not granted.", true); }
      catch (err) { toast(err.message, true); }
    };
  };
  try { data = await api(`/api/ww?${qs}`, {}, "Building the WW ranking… (reading the geo files in this browser)"); }
  catch (e) {
    if (e.status === 428) return wwChoose("");
    $("#body").innerHTML = `<div class="empty">${esc(e.message)}</div>`; return;
  }
  const changeFiles = isShip() ? "" : `<button class="btn small" id="ww-change">Change geo files…</button>`;
  const geos = data.geos;
  const d = data[part];
  d.rows.forEach((x, i) => { x._rank = i + 1; });   // rank WW (orden del Excel), se mantiene al reordenar
  const st = sortState("ww_" + part);
  // por geo: sin valor = 0 (la geo no tiene ese FC)
  const getWw = (r, k) => { const v = pathGet(r, k); return v === undefined && k.includes(".") ? 0 : v; };
  const LIMIT = 300;
  let showAll = false;
  const sources = (isShip() ? (geos.length ? `<span class="sel-chip" title="${esc(data.files[geos[0]])}">All geos: ${esc(data.files[geos[0]])}</span>` : "")
    : geos.map(g => `<span class="sel-chip" title="${esc(data.files[g])}">${esc(g)}: ${esc(data.files[g])}</span>`).join(""))
    + (data.missing_geos.length ? ` <span class="muted">No file for ${esc(data.missing_geos.join(", "))}</span>` : "");
  const draw = () => {
    const list = sortRows(d.rows, st, getWw);
    const shown = showAll ? list : list.slice(0, LIMIT);
    const th = (label, key, title = "") => sortTh(label, key, st, ["featurecode", "description", "ref_fc", "basicname"].includes(key) ? "" : "num", title);
    const refH = isShip() ? th("FC(s)", "ref_fc", "Feature codes of the SBB (fc column)") + th("Basic name", "basicname") : "";
    let head, body;
    if (part === "proximity") {
      head = `<tr><th colspan="${3 + refN()}"></th><th colspan="${geos.length + 4}" class="group">Configurations</th><th colspan="${geos.length + 3}" class="group">Revenue contribution (USD)</th></tr>
        <tr>${th("Rank", "_rank")}${th(L.code, "featurecode")}${th("Description", "description")}${refH}${th("Total WW", "configs_ww")}${geos.map(g => th(esc(g), "configs." + g)).join("")}
        ${th("# Geos", "n_geos")}${th("% of WW", "pct")}${th("Cum. %", "cum_pct", "Cumulative % in the WW ranking order")}
        ${th("Rev Contrib WW", "rev_contrib_usd_ww")}${geos.map(g => th(esc(g), "rev_contrib_usd." + g)).join("")}${th("% of WW Rev", "rev_pct")}${th("Rank Rev", "rev_rank")}</tr>`;
      body = shown.map(x => `<tr><td class="num muted">${x._rank}</td><td class="mono"><a href="#/adjustments/${encodeURIComponent(x.featurecode)}" title="Look up / adjust this ${L.code}">${esc(x.featurecode)}</a></td>
        <td class="trunc" title="${esc(x.description)}">${esc(x.description)}</td>${refTd(x)}<td class="num"><strong>${fmt(x.configs_ww)}</strong></td>
        ${geos.map(g => `<td class="num${x.configs[g] ? "" : " zero"}">${fmt(x.configs[g] || 0)}</td>`).join("")}
        <td class="num">${x.n_geos}</td><td class="num muted">${pctFmt(x.pct)}</td><td class="num muted">${pctFmt(x.cum_pct)}</td>
        <td class="num"><strong>${usdM(x.rev_contrib_usd_ww)}</strong></td>${geos.map(g => `<td class="num${x.rev_contrib_usd[g] ? "" : " zero"}">${usdM(x.rev_contrib_usd[g] || 0)}</td>`).join("")}
        <td class="num muted">${pctFmt(x.rev_pct)}</td><td class="num muted">${x.rev_rank}</td></tr>`).join("");
    } else {
      head = `<tr><th colspan="${3 + refN()}"></th><th colspan="${geos.length + 3}" class="group">TCE configurations</th><th colspan="${geos.length + 1}" class="group">Rev contrib — all configs (USD)</th><th colspan="${geos.length + 1}" class="group">Rev contrib — TCE Sel (USD)</th><th colspan="2"></th></tr>
        <tr>${th("Rank", "_rank")}${th(L.code, "featurecode")}${th("Description", "description")}${refH}${th("Total WW", "configs_ww")}${geos.map(g => th(esc(g), "configs." + g)).join("")}
        ${th("# Geos", "n_geos")}${th("% of WW", "pct")}
        ${th("All WW", "rev_all_usd_ww")}${geos.map(g => th(esc(g), "rev_all_usd." + g)).join("")}
        ${th("TCE Sel WW", "rev_tce_usd_ww")}${geos.map(g => th(esc(g), "rev_tce_usd." + g)).join("")}
        ${th("TCE Sel / All", "tce_share")}${th("Rank Rev", "rev_tce_rank")}</tr>`;
      body = shown.map(x => `<tr><td class="num muted">${x._rank}</td><td class="mono"><a href="#/adjustments/${encodeURIComponent(x.featurecode)}" title="Look up / adjust this ${L.code}">${esc(x.featurecode)}</a></td>
        <td class="trunc" title="${esc(x.description)}">${esc(x.description)}</td>${refTd(x)}<td class="num"><strong>${fmt(x.configs_ww)}</strong></td>
        ${geos.map(g => `<td class="num${x.configs[g] ? "" : " zero"}">${fmt(x.configs[g] || 0)}</td>`).join("")}
        <td class="num">${x.n_geos}</td><td class="num muted">${pctFmt(x.pct)}</td>
        <td class="num"><strong>${usdM(x.rev_all_usd_ww)}</strong></td>${geos.map(g => `<td class="num${x.rev_all_usd[g] ? "" : " zero"}">${usdM(x.rev_all_usd[g] || 0)}</td>`).join("")}
        <td class="num"><strong>${usdM(x.rev_tce_usd_ww)}</strong></td>${geos.map(g => `<td class="num${x.rev_tce_usd[g] ? "" : " zero"}">${usdM(x.rev_tce_usd[g] || 0)}</td>`).join("")}
        <td class="num muted">${pctFmt(x.tce_share)}</td><td class="num muted">${x.rev_tce_rank}</td></tr>`).join("");
    }
    $("#body").innerHTML = `
      <div class="kpis">
        <div class="kpi"><div class="v">${fmt(d.configs_ww)}</div><div class="l">${part === "proximity" ? "Configs in scope (WW)" : "TCE configs in scope (WW)"}</div></div>
        ${geos.map(g => `<div class="kpi"><div class="v">${fmt(d.configs_by_geo[g])}</div><div class="l">${esc(g)}</div></div>`).join("")}
        <div class="kpi"><div class="v">${fmt(d.rows.length)}</div><div class="l">Distinct ${L.codes}</div></div>
      </div>
      <div class="toolbar"><div class="sel-chips">${sources}</div><div class="spacer"></div>${changeFiles}</div>
      <div class="table-wrap"><table class="one-line"><thead>${head}</thead>
        <tbody>${body || `<tr><td colspan="20" class="empty">No ${L.codes}</td></tr>`}</tbody></table></div>
      <div class="count">${fmt(shown.length)} of ${fmt(d.rows.length)} ${L.codes}${d.rows.length > shown.length ? ` · <a href="#" id="show-all">show all</a> (or export)` : ""}</div>`;
    wireSort($("#body"), st, d.rows, draw, getWw);
    $("#show-all")?.addEventListener("click", e => { e.preventDefault(); showAll = true; draw(); });
    $("#ww-change")?.addEventListener("click", () => wwChoose(""));
  };
  draw();
}

// ------------------------------------------------------- 4. Ranking de bids
const BID_COLS_Q = [
  { key: "rank", label: "#", num: true },
  { key: "proximity", label: "TCE Proximity", num: true },
  { key: "bid_item", label: "Bid_Item", cls: "mono" },
  { key: "quotenumber", label: "quotenumber", cls: "mono" },
  { key: "opp_number", label: "opp_number", cls: "mono" },
  { key: "account", label: "Account" },
  { key: "product", label: "Product" },
  { key: "forecast", label: "Forecast" },
  { key: "sales_rep", label: "Sales rep" },
  { key: "country", label: "Country" },
  { key: "contract_start", label: "Contract start" },
  { key: "quotelines_quantity", label: "quotelines_quantity", num: true },
  { key: "tot_lines_qty", label: "tot_lines_qty", num: true },
  { key: "value_usd", label: "Bid Item Price (USD)", num: true, title: L.valueHint },
  { key: "total_final_price", label: "Total quote (final price)", num: true, title: "totalfinalprice: total of the whole quote, in the quote currency" },
];
// shipments: mismas columnas con sus nombres (sin sales rep)
const BID_COLS_S = BID_COLS_Q.filter(c => c.key !== "sales_rep").map(c => ({ ...c, ...({
  bid_item: { label: "mfgsoline" }, quotenumber: { label: "so" }, opp_number: { label: "end_customer_number" },
  account: { label: "Customer" }, product: { label: "Family" }, forecast: { label: "Segment" },
  contract_start: { label: "Ship date" }, quotelines_quantity: { label: "qty" },
  tot_lines_qty: { label: "SO qty", title: "Sum of qty of all configs of the SO" },
  value_usd: { label: "Config value (USD)", title: LABELS.shipments.valueHint },
  total_final_price: { label: "SO value (USD)", title: "Sum of the config values of the SO" },
}[c.key] || {}) }));

async function renderBids(params) {
  const p = commonParams(params);
  const multi = multiParams(params, isShip() ? ["products", "countries", "forecasts", "statuses"] : ["products", "countries", "forecasts"]);
  const BID_COLS = isShip() ? BID_COLS_S : BID_COLS_Q;
  view.innerHTML = `
    <div class="view-head"><h2>${isShip() ? "Config Ranking" : "Bid-Item Ranking"}</h2>
      <span class="hint">${p.tce === "N" ? `All ${L.items} with at least one N ${L.line}, from closest to farthest from TCE.` : linesHint(p.tce)} Click a header to sort.</span></div>
    <div class="toolbar">
      ${filterFields(p)}
      ${tceField(p)}
      <div class="field"><label for="f-q">Search</label><input type="search" id="f-q" placeholder="${isShip() ? "config, SO, customer, family…" : "bid-item, bid, opp, account, rep…"}" size="16"></div>
      <div class="ms-group inline"><div class="field"><label for="f-prox">Proximity</label><div id="f-prox-box"></div></div>
        <div class="sel-chips" id="sel-prox"></div></div>
      <div class="field"${isShip() ? " hidden" : ""}><label for="f-opp">Opportunity</label><select id="f-opp"><option value="">(All)</option><option value="with">With opp</option><option value="without">Without opp</option></select></div>
      ${multiFieldsHtml(multi, true)}
      <div class="spacer"></div>
      <div class="actions"><button class="btn primary" id="export">Export to Excel</button></div>
    </div>
    <div id="body"><div class="empty">Loading…</div></div>`;
  const go = extra => setHash("bids", "", { ...p, ...multiHash(multi), ...extra });
  $("#f-express").onchange = e => go({ express: e.target.value });
  $("#f-currency").onchange = e => go({ currency: e.target.value });
  $("#f-tce").onchange = e => go({ tce: e.target.value });
  wireMultiFields(multi, sel => go(multiHash(sel)));
  const qs = multiQs(new URLSearchParams(filterQs(p)), multi).toString();
  $("#export").onclick = () => downloadLink(`/api/export/bids.xlsx?${qs}`);

  let data;
  try { data = await api(`/api/bids?${qs}`); }
  catch (e) { $("#body").innerHTML = `<div class="empty">${esc(e.message)}</div>`; return; }

  // Proximity: selección múltiple (filtro en pantalla sobre los datos ya cargados); ninguno = todas
  const proxVals = [...new Set(data.map(b => b.proximity))].sort((a, b) => a - b).map(String);
  let proxSel = [];
  const drawProx = () => {
    const apply = v => { proxSel = v; drawProx(); draw(); };
    multiSelect($("#f-prox-box"), proxVals, proxSel, "All", "values", apply, "f-prox");
    $("#sel-prox").innerHTML = proxSel.map(selChipHtml).join("");
    $$("[data-remove]", $("#sel-prox")).forEach(b => b.onclick = () => apply(proxSel.filter(x => x !== b.dataset.remove)));
  };
  // orden por defecto: valor del bid-item (USD) descendente
  const st = { sort: "value_usd", dir: -1 };

  const draw = () => {
    const q = $("#f-q").value.trim().toLowerCase();
    const op = $("#f-opp").value;
    let rows = data.filter(b =>
      (!proxSel.length || proxSel.includes(String(b.proximity))) &&
      (!op || (op === "with") === (b.opp_number !== "(no opp)")) &&
      (!q || [b.bid_item, b.quotenumber, b.opp_number, b.account, b.product, b.sales_rep, b.end_customer].some(x => String(x).toLowerCase().includes(q))));
    const k = st.sort;
    rows = rows.slice().sort((a, b) => {
      const x = a[k], y = b[k];
      if (x === y) return a.rank - b.rank;
      if (x === null || x === "") return 1;
      if (y === null || y === "") return -1;
      return (typeof x === "number" ? x - y : String(x).localeCompare(String(y))) * st.dir;
    });
    const shown = rows.slice(0, 2000);
    $("#body").innerHTML = `
      <div class="table-wrap"><table class="one-line">
        <thead><tr>${BID_COLS.map(c => sortTh(c.label, c.key, { key: st.sort, dir: st.dir }, c.num ? "num" : "", c.title || "")).join("")}</tr></thead>
        <tbody>${shown.map(b => `<tr>
          <td class="num muted">${b.rank}</td><td class="num">${proxBadge(b.proximity)}</td>
          <td class="mono"><a href="#/quote/${encodeURIComponent(b.quotenumber)}?bid=${encodeURIComponent(b.bid_item)}" title="${esc(b.bid_item)}">${esc(itemLabel(b.bid_item))}</a></td>
          <td class="mono"><a href="#/quote/${encodeURIComponent(b.quotenumber)}">${esc(b.quotenumber)}</a></td>
          <td class="mono">${esc(b.opp_number)}</td><td class="trunc" title="${esc(b.account)}">${esc(b.account)}</td><td class="trunc" title="${esc(b.product)}">${esc(b.product)}</td>
          <td>${esc(b.forecast)}</td>${isShip() ? "" : `<td class="trunc" title="${esc(b.sales_rep)}">${esc(b.sales_rep)}</td>`}<td>${esc(b.country)}</td><td>${esc(b.contract_start)}</td>
          <td class="num">${fmt(b.quotelines_quantity)}</td><td class="num" title="Sum of ${L.qtyCol} of all ${L.items} in the ${L.bidWord}">${fmt(b.tot_lines_qty)}</td><td class="num">${money(b.value_usd)}</td><td class="num muted">${money(b.total_final_price)}</td></tr>`).join("") || `<tr><td colspan="${BID_COLS.length}" class="empty">No results</td></tr>`}</tbody>
      </table></div>
      <div class="count">${fmt(rows.length)} of ${fmt(data.length)} ${L.items}${rows.length > shown.length ? " (showing the first 2,000; use the filters or export)" : ""}</div>`;
    $$("th.sortable", $("#body")).forEach(th => th.onclick = () => {
      if (st.sort === th.dataset.sortKey) st.dir *= -1; else { st.sort = th.dataset.sortKey; st.dir = BID_COLS.find(c => c.key === st.sort)?.num ? -1 : 1; }
      draw();
    });
  };
  let t;
  $("#f-q").oninput = () => { clearTimeout(t); t = setTimeout(draw, 150); };
  $("#f-opp").onchange = draw;
  drawProx(); draw();
}

// ------------------------------------------------------- 5. Adjustments
async function renderAdjustments(fc) {
  view.innerHTML = `
    <div class="view-head"><h2>Adjustments</h2>
      <span class="hint">Look up ${isShip() ? "an SBB" : "a feature code"} and override its TCE value. The data file is not modified; adjustments are saved and applied to every view${isShip() ? " (shipments adjustments are kept apart from the quotes ones)" : ""}. An adjustment is removed automatically when a newer data file brings a different source value for that ${L.code}.</span></div>
    <div class="toolbar">
      <div class="field"><label for="fc-input">${isShip() ? "SBB or description" : "Feature code or description"}</label>
        <input type="search" id="fc-input" placeholder="${isShip() ? "e.g. SBB7A94538 or Xeon" : "e.g. B0ML or TPM"}" value="${esc(fc)}" size="34" autocomplete="off"></div>
      <button class="btn primary" id="fc-go">Look up</button>
    </div>
    <div id="fc-results"></div>
    <div id="fc-card"></div>
    <div class="section-head"><h3 class="section">Active adjustments</h3>
      <div class="actions">
        <button class="btn small" id="adj-export" title="Download the adjustments (tce_overrides.json format)">Export adjustments</button>
        <button class="btn small" id="adj-import" title="Load adjustments from a tce_overrides.json file">Import…</button>
        <input type="file" id="adj-import-input" accept=".json,application/json" hidden>
      </div></div>
    <div id="adj-list"><div class="empty">Loading…</div></div>
    <h3 class="section">Change log</h3>
    <div id="adj-history"></div>`;

  const input = $("#fc-input");
  const lookup = () => { const v = input.value.trim(); if (v) setHash("adjustments", v, {}); };
  $("#fc-go").onclick = lookup;
  input.onkeydown = e => { if (e.key === "Enter") lookup(); };
  let t;
  input.oninput = () => {
    clearTimeout(t);
    t = setTimeout(async () => {
      const v = input.value.trim();
      if (!v) { $("#fc-results").innerHTML = ""; return; }
      const list = await localApi(`/api/fc-search?q=${encodeURIComponent(v)}`).catch(() => []);
      $("#fc-results").innerHTML = list.length ? `
        <div class="table-wrap short"><table>
          <thead><tr><th>${L.code}</th><th>Description</th>${refTh()}<th>TCE in file</th><th>Current TCE</th></tr></thead>
          <tbody>${list.map(x => `<tr class="clickable" data-fc="${esc(x.featurecode)}">
            <td class="mono">${esc(x.featurecode)}</td><td>${esc(x.description)}</td>${refTd(x)}
            <td>${tceBadge(x.csv_tce)}</td><td>${tceBadge(x.tce)}${x.adjusted ? ' <span class="adj-tag">adjusted</span>' : ""}</td></tr>`).join("")}</tbody>
        </table></div>` : `<div class="count">No ${L.codes} match “${esc(v)}”.</div>`;
      $$("tr[data-fc]", $("#fc-results")).forEach(tr => tr.onclick = () => setHash("adjustments", tr.dataset.fc, {}));
    }, 200);
  };

  const loadLists = async () => {
    let d;
    try { d = await api("/api/adjustments"); } catch (e) { $("#adj-list").innerHTML = `<div class="empty">${esc(e.message)}</div>`; return; }
    $("#adj-list").innerHTML = d.adjustments.length ? `
      <div class="table-wrap short"><table>
        <thead><tr><th>${L.code}</th><th>Description</th><th>TCE in file</th><th>Adjusted to</th><th>Note</th><th>Updated</th><th></th></tr></thead>
        <tbody>${d.adjustments.map(a => `<tr>
          <td class="mono"><a href="#/adjustments/${encodeURIComponent(a.featurecode)}">${esc(a.featurecode)}</a></td>
          <td>${esc(a.description)}${a.in_file ? "" : ' <span class="muted">(not in current file)</span>'}</td>
          <td>${tceBadge(a.csv_tce)}</td><td>${tceBadge(a.tce)}</td>
          <td>${esc(a.note)}</td><td class="muted">${esc(a.updated.replace("T", " "))}</td>
          <td><button class="btn small" data-revert="${esc(a.featurecode)}">Revert</button></td></tr>`).join("")}</tbody>
      </table></div>
      <div class="count">Saved in ${esc(d.storage)} — kept after closing the app. The data file (${esc(d.file)}) is unchanged.</div>`
      : `<div class="empty">No adjustments. All TCE values come from the data file.</div>`;
    $$("[data-revert]", $("#adj-list")).forEach(b => b.onclick = () => revert(b.dataset.revert));

    $("#adj-history").innerHTML = d.history.length ? `
      <div class="table-wrap short"><table>
        <thead><tr><th>When</th><th>${L.code}</th><th>Description</th><th>Action</th><th>From</th><th>To</th><th>Note</th></tr></thead>
        <tbody>${d.history.map(h => `<tr><td class="muted">${esc(h.ts.replace("T", " "))}</td>
          <td class="mono">${esc(h.featurecode)}</td><td>${esc(h.description)}</td><td>${esc(h.action)}</td>
          <td>${tceBadge(h.from)}</td><td>${tceBadge(h.to)}</td><td>${esc(h.note)}</td></tr>`).join("")}</tbody>
      </table></div>` : `<div class="count">No changes yet.</div>`;
  };

  const afterChange = async (msg) => {
    await loadMeta();
    toast(msg);
    await Promise.all([loadLists(), fc ? loadCard() : null]);
  };

  const revert = async code => {
    try {
      await api(`/api/adjustments/${encodeURIComponent(code)}`, { method: "DELETE" });
      await afterChange(`${code} reverted to its file value`);
    } catch (e) { toast(e.message, true); }
  };

  const loadCard = async () => {
    let d;
    try { d = await api(`/api/fc/${encodeURIComponent(fc)}`); }
    catch (e) { $("#fc-card").innerHTML = `<div class="empty">${esc(e.message)}</div>`; return; }
    const u = d.usage;
    let sel = d.tce;
    const impactText = v => {
      if (v === d.tce) return `<span class="muted">Current value</span>`;
      const i = d.impact[v];
      const parts = [`${fmt(i.bids_changed)} ${L.items} change proximity`];
      if (i.become_tce_ready) parts.push(`<strong>${fmt(i.become_tce_ready)} become TCE-ready</strong> (${usdShort(i.become_tce_ready_value_usd)}; leave the ranking)`);
      if (i.enter_ranking) parts.push(`<strong>${fmt(i.enter_ranking)} TCE configs stop being TCE</strong> (${usdShort(i.enter_ranking_value_usd)}; enter the ranking)`);
      return parts.join(" · ");
    };
    $("#fc-card").innerHTML = `
      <div class="fc-card">
        <div class="fc-card-head">
          <div><div class="fc-code mono">${esc(d.featurecode)}</div>
            <div class="fc-desc">${d.descriptions.map(esc).join("<br>")}</div>
            ${isShip() ? `<div class="fc-desc muted">FC(s): ${esc(d.ref_fc || "—")} · basic name: ${esc(d.basicname || "—")}</div>` : ""}</div>
          <div class="fc-vals">
            <div><div class="k">TCE in file</div>${tceBadge(d.csv_tce)}</div>
            <div><div class="k">Current TCE</div>${tceBadge(d.tce)}${d.adjusted ? ' <span class="adj-tag">adjusted</span>' : ""}</div>
          </div>
        </div>
        <div class="fc-usage">Used in ${fmt(u.lines)} ${isShip() ? "rows" : "lines"} · ${fmt(u.quotes)} ${L.bidsWord} · ${fmt(u.bids)} ${L.items} · rev contrib ${usdShort(u.rev_contrib_usd)}.
          Of those ${L.items}, ${fmt(u.bids_in_scope_in_ranking)} are in the ranking (not TCE yet) and ${fmt(u.tce_configs_in_scope)} are full TCE configs.</div>
        ${d.adjustment ? `<div class="fc-usage">Adjusted on ${esc(d.adjustment.updated.replace("T", " "))}${d.adjustment.note ? ` — “${esc(d.adjustment.note)}”` : ""}</div>` : ""}
        <div class="k section-k">New TCE value</div>
        <div class="tce-options">${TCE_VALUES.map(v => `
          <label class="tce-option${v === sel ? " on" : ""}">
            <input type="radio" name="tce" value="${esc(v)}"${v === sel ? " checked" : ""}>
            ${tceBadge(v)}<span class="impact">${impactText(v)}</span></label>`).join("")}</div>
        <div class="fc-actions">
          <input type="text" id="adj-note" placeholder="Note (optional): why this adjustment" size="50" value="${esc(d.adjustment?.note || "")}">
          <button class="btn primary" id="adj-apply" disabled>Apply adjustment</button>
          ${d.adjusted ? `<button class="btn" id="adj-revert">Revert to file value (${esc(d.csv_tce)})</button>` : ""}
        </div>
      </div>`;
    $$("input[name=tce]", $("#fc-card")).forEach(r => r.onchange = () => {
      sel = r.value;
      $$(".tce-option", $("#fc-card")).forEach(l => l.classList.toggle("on", l.querySelector("input").checked));
      $("#adj-apply").disabled = sel === d.tce;
    });
    $("#adj-apply").onclick = async () => {
      try {
        await api(`/api/adjustments/${encodeURIComponent(d.featurecode)}`, {
          method: "PUT", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ tce: sel, note: $("#adj-note").value }),
        });
        await afterChange(sel === d.csv_tce ? `${d.featurecode} reverted to its file value (${sel})` : `${d.featurecode} adjusted: ${d.tce} → ${sel}`);
      } catch (e) { toast(e.message, true); }
    };
    if (d.adjusted) $("#adj-revert").onclick = () => revert(d.featurecode);
  };

  $("#adj-export").onclick = () => exportAdjustmentsFile();
  $("#adj-import").onclick = () => $("#adj-import-input").click();
  $("#adj-import-input").onchange = async e => {
    const f = e.target.files[0]; e.target.value = "";
    if (!f) return;
    if (!confirm(`Replace the adjustments saved in this browser with the ones in ${f.name}?`)) return;
    try { await importAdjustmentsFile(f); await afterChange(`Adjustments imported from ${f.name}`); }
    catch (err) { toast(err.message, true); }
  };

  await Promise.all([loadLists(), fc ? loadCard() : null]);
  if (!fc) input.focus();
}

// ---------------------------------------------------------------- router
let renderSeq = 0;
async function render() {
  const { route, arg, params } = parseHash();
  const seq = ++renderSeq;
  $$("#tabs a").forEach(a => a.classList.toggle("active", a.dataset.view === route));
  if (!state.meta) return renderWelcome();
  if (seq !== renderSeq) return;
  if (route === "quote") return renderQuote(arg, params);
  if (route === "fc") return renderFc(params);
  if (route === "dependency") return renderDependency(params);
  if (route === "ww") return renderWw(params);
  if (route === "bids") return renderBids(params);
  if (route === "adjustments") return renderAdjustments(arg, params);
  return renderRanking(params);
}

window.addEventListener("hashchange", render);

(function init() {
  setProgressHandler(t => { $("#loading-text").textContent = t; });
  render();
  // El motor (DuckDB-WASM, ~10 MB desde el CDN) se precarga mientras el usuario elige el archivo
  initEngine().catch(e => toast(`Could not start the data engine (${e.message}). Check the internet connection.`, true));
})();
