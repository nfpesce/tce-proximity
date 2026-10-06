/* Test de equivalencia: motor del navegador (engine.js + api.js) vs API Python.
 *
 * Requiere (sólo en desarrollo, nada de esto se publica):
 *  - tests/expected_na.json  generado con:  python scripts/make_pages_expected.py
 *  - el CSV de NA servido desde la raíz del proyecto:  python -m http.server 8020  (en la carpeta del proyecto)
 * Abrir: http://localhost:8020/Github_Pages_Version/tests/compare.html
 */
import { api, loadFile, useStore, OverrideStore, ApiError } from "../api.js";

const IGNORE = new Set(["ts", "updated", "storage"]);   // marcas de tiempo / dónde se guarda: difieren legítimamente

function diff(exp, act, path = "$") {
  if (typeof exp === "number" && typeof act === "number")
    return Math.abs(exp - act) <= 1e-9 * Math.max(1, Math.abs(exp)) ? null : `${path}: expected ${exp}, got ${act}`;
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
  const expected = await fetch("expected_na.json").then(r => { if (!r.ok) throw new Error("expected_na.json not found - run scripts/make_pages_expected.py"); return r.json(); });
  const blob = await fetch("../../" + encodeURIComponent(expected.csv)).then(r => { if (!r.ok) throw new Error(`${expected.csv} not served`); return r.blob(); });
  const key = "tce_overrides_test_" + Date.now();
  useStore(new OverrideStore(key));
  await loadFile(new File([blob], expected.csv));
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
    · CSV load ${((tLoad - t0) / 1000).toFixed(1)} s · checks ${((performance.now() - tLoad) / 1000).toFixed(1)} s`;
  window.__done = true;
} catch (e) {
  status.innerHTML = `<b class="fail">ERROR: ${e.message}</b>`;
  window.__done = true;
  window.__error = String(e.stack || e);
}
