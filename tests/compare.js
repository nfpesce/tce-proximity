/* Test de equivalencia: motor del navegador (engine.js + api.js) vs API Python.
 *
 * Requiere (sólo en desarrollo, nada de esto se publica):
 *  - tests/expected_na.json y expected_na28.json  generados con:  python scripts/make_pages_expected.py
 *  - los datos servidos desde la raíz del proyecto:  python -m http.server 8020  (en la carpeta del proyecto)
 * Abrir: http://localhost:8020/Github_Pages_Version/tests/compare.html            (CSV NA Oct 4)
 *        http://localhost:8020/Github_Pages_Version/tests/compare.html?set=na28  (NA Quotes Oct28.xlsx)
 * El .xlsx se convierte en el navegador la primera vez y queda en la caché (IndexedDB); ?nocache=1 la borra antes.
 */
import { api, loadFile, useStore, OverrideStore, ApiError } from "../api.js";

const IGNORE = new Set(["ts", "updated", "storage"]);   // marcas de tiempo / dónde se guarda: difieren legítimamente

// Importes en USD (*_usd): las sumas de miles de doubles en otro orden (pandas vs DuckDB) pueden diferir
// en el último bit y, al redondear a centavos, en 1 centavo. Se tolera eso y nada más.
const USD_TOL = 0.0100001;
const byFc = list => [...list].sort((a, b) => String(a.featurecode).localeCompare(String(b.featurecode)));

function diff(exp, act, path = "$") {
  if (typeof exp === "number" && typeof act === "number") {
    const tol = path.includes("_usd") ? USD_TOL : 1e-9 * Math.max(1, Math.abs(exp));
    return Math.abs(exp - act) <= tol ? null : `${path}: expected ${exp}, got ${act}`;
  }
  // ajustes creados en el mismo segundo: el orden entre ellos no está definido
  if (path.endsWith(".adjustments") && Array.isArray(exp) && Array.isArray(act)) { exp = byFc(exp); act = byFc(act); }
  if (exp === null || act === null || typeof exp !== "object" || typeof act !== "object")
    return exp === act ? null : `${path}: expected ${JSON.stringify(exp)}, got ${JSON.stringify(act)}`;
  if (Array.isArray(exp) !== Array.isArray(act)) return `${path}: array vs object`;
  if (Array.isArray(exp)) {
    if (exp.length !== act.length) return `${path}: length ${exp.length} vs ${act.length}`;
    for (let i = 0; i < exp.length; i++) { const d = diff(exp[i], act[i], `${path}[${i}]`); if (d) return d; }
    return null;
  }
  const keys = new Set([...Object.keys(exp), ...Object.keys(act)].filter(k => !IGNORE.has(k)));
  for (const k of keys) {
    if (!(k in exp)) return `${path}.${k}: unexpected key`;
    if (!(k in act)) return `${path}.${k}: missing key`;
    const d = diff(exp[k], act[k], `${path}.${k}`); if (d) return d;
  }
  return null;
}

const out = document.getElementById("out"), status = document.getElementById("status");
const results = [];
window.__results = results;
try {
  const t0 = performance.now();
  const params = new URLSearchParams(location.search);
  const set = params.get("set") || "na";
  if (params.get("nocache")) await new Promise(r => { const q = indexedDB.deleteDatabase("tce-proximity-cache"); q.onsuccess = q.onerror = q.onblocked = r; });
  const expected = await fetch(`expected_${set}.json`).then(r => { if (!r.ok) throw new Error(`expected_${set}.json not found - run scripts/make_pages_expected.py`); return r.json(); });
  const blob = await fetch("../../" + expected.csv.split("/").map(encodeURIComponent).join("/")).then(r => { if (!r.ok) throw new Error(`${expected.csv} not served`); return r.blob(); });
  const key = "tce_overrides_test_" + Date.now();
  useStore(new OverrideStore(key));
  await loadFile(new File([blob], expected.csv.split("/").pop(), { lastModified: 1 }));
  const tLoad = performance.now();

  for (const [i, c] of expected.cases.entries()) {
    let status = 200, actual, d = null;
    try { actual = await api(c.url, { method: c.method, body: c.body ? JSON.stringify(c.body) : undefined }); }
    catch (e) { status = e instanceof ApiError ? e.status : 500; actual = { detail: e.message }; }
    if (status !== c.status) d = `status ${status} (expected ${c.status}): ${actual.detail ?? ""}`;
    else if (status === 200) d = diff(c.expected, actual);
    else if (typeof c.expected.detail === "string" && c.expected.detail !== actual.detail)
      d = `detail "${actual.detail}" vs "${c.expected.detail}"`;
    results.push({ i, url: `${c.method} ${c.url}`, ok: !d, d });
    out.insertAdjacentHTML("beforeend", `<tr><td>${i}</td><td><code>${c.method} ${c.url}</code></td>
      <td class="${d ? "fail" : "ok"}">${d ? "FAIL" : "OK"}</td><td><code>${(d || "").replace(/</g, "&lt;")}</code></td></tr>`);
  }
  localStorage.removeItem(key);
  const fails = results.filter(r => !r.ok).length;
  status.innerHTML = `<b class="${fails ? "fail" : "ok"}">${results.length - fails}/${results.length} OK</b>
    · ${set} · file load ${((tLoad - t0) / 1000).toFixed(1)} s · checks ${((performance.now() - tLoad) / 1000).toFixed(1)} s`;
  window.__done = true;
} catch (e) {
  status.innerHTML = `<b class="fail">ERROR: ${e.message}</b>`;
  window.__done = true;
  window.__error = String(e.stack || e);
}
