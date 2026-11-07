/* xlsx.js — lectura en streaming de la primera hoja de un .xlsx grande, dentro del navegador.
 *
 * Los libros de la extracción LUDP pesan 75-212 MB comprimidos (hasta ~1,2 GB de XML): no se pueden abrir con
 * una librería que cargue todo en memoria. Aquí se lee el índice del zip, se descomprime la hoja con
 * DecompressionStream (nativo del navegador) y se recorre el XML fila por fila, devolviendo sólo las columnas
 * pedidas, en lotes de texto CSV. Nada sale de la computadora del usuario.
 */
export class XlsxError extends Error {}

const readBytes = async (file, start, end) => new Uint8Array(await file.slice(start, end).arrayBuffer());

/** Índice del zip: nombre -> { method, csize, usize, off } (soporta ZIP64) */
async function zipEntries(file) {
  const tailLen = Math.min(file.size, 65557 + 76);
  const tail = await readBytes(file, file.size - tailLen, file.size);
  const dv = new DataView(tail.buffer, tail.byteOffset, tail.byteLength);
  let eocd = -1;
  for (let i = tail.length - 22; i >= 0; i--) if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new XlsxError("Not a valid .xlsx file (zip directory not found)");
  let count = dv.getUint16(eocd + 10, true), cdSize = dv.getUint32(eocd + 12, true), cdOff = dv.getUint32(eocd + 16, true);
  const loc = eocd - 20;
  if ((cdOff === 0xffffffff || count === 0xffff || cdSize === 0xffffffff) && loc >= 0 && dv.getUint32(loc, true) === 0x07064b50) {
    const z64off = Number(dv.getBigUint64(loc + 8, true));
    const zb = await readBytes(file, z64off, z64off + 56);
    const z = new DataView(zb.buffer, zb.byteOffset, zb.byteLength);
    count = Number(z.getBigUint64(32, true)); cdSize = Number(z.getBigUint64(40, true)); cdOff = Number(z.getBigUint64(48, true));
  }
  const cd = await readBytes(file, cdOff, cdOff + cdSize);
  const cv = new DataView(cd.buffer, cd.byteOffset, cd.byteLength);
  const dec = new TextDecoder();
  const entries = new Map();
  let p = 0;
  for (let i = 0; i < count && p + 46 <= cd.length; i++) {
    if (cv.getUint32(p, true) !== 0x02014b50) break;
    const method = cv.getUint16(p + 10, true);
    let csize = cv.getUint32(p + 20, true), usize = cv.getUint32(p + 24, true);
    const nlen = cv.getUint16(p + 28, true), xlen = cv.getUint16(p + 30, true), clen = cv.getUint16(p + 32, true);
    let off = cv.getUint32(p + 42, true);
    const name = dec.decode(cd.subarray(p + 46, p + 46 + nlen));
    let x = p + 46 + nlen;
    const xend = x + xlen;
    while (x + 4 <= xend) {                       // campo extra ZIP64
      const id = cv.getUint16(x, true), sz = cv.getUint16(x + 2, true);
      if (id === 1) {
        let q = x + 4;
        if (usize === 0xffffffff) { usize = Number(cv.getBigUint64(q, true)); q += 8; }
        if (csize === 0xffffffff) { csize = Number(cv.getBigUint64(q, true)); q += 8; }
        if (off === 0xffffffff) { off = Number(cv.getBigUint64(q, true)); }
      }
      x += 4 + sz;
    }
    entries.set(name, { method, csize, usize, off });
    p += 46 + nlen + xlen + clen;
  }
  return entries;
}

async function entryStream(file, e) {
  const hb = await readBytes(file, e.off, e.off + 30);
  const h = new DataView(hb.buffer, hb.byteOffset, hb.byteLength);
  if (h.getUint32(0, true) !== 0x04034b50) throw new XlsxError("Corrupt .xlsx file (bad local header)");
  const start = e.off + 30 + h.getUint16(26, true) + h.getUint16(28, true);
  const raw = file.slice(start, start + e.csize).stream();
  if (e.method === 0) return raw;
  if (e.method === 8) return raw.pipeThrough(new DecompressionStream("deflate-raw"));
  throw new XlsxError(`Unsupported compression in the .xlsx file (method ${e.method})`);
}

async function entryText(file, entries, name) {
  const e = entries.get(name);
  return e ? new Response(await entryStream(file, e)).text() : null;
}

const ENT = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
const unesc = s => s.indexOf("&") < 0 ? s : s.replace(/&(#x[0-9a-fA-F]+|#\d+|amp|lt|gt|quot|apos);/g,
  (m, g) => g[0] === "#" ? String.fromCodePoint(g[1] === "x" || g[1] === "X" ? parseInt(g.slice(2), 16) : parseInt(g.slice(1), 10)) : ENT[g]);
const T_RE = /<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g;
function texts(xml) {
  let out = "", m;
  T_RE.lastIndex = 0;
  while ((m = T_RE.exec(xml))) out += m[1];
  return unesc(out);
}
const attrsOf = tag => Object.fromEntries([...tag.matchAll(/([\w:]+)="([^"]*)"/g)].map(m => [m[1], unesc(m[2])]));

function parseShared(xml) {
  const out = [];
  if (!xml) return out;
  const re = /<si>([\s\S]*?)<\/si>|<si\/>/g;
  let m;
  while ((m = re.exec(xml))) {
    // las lecturas fonéticas (<rPh>) no son parte del texto
    out.push(texts((m[1] || "").replace(/<rPh\b[\s\S]*?<\/rPh>/g, "")));
  }
  return out;
}

/** Ruta interna de la primera hoja del libro (+ nombres de todas las hojas) */
async function firstSheet(file, entries) {
  const wb = await entryText(file, entries, "xl/workbook.xml");
  if (!wb) throw new XlsxError("Not a valid .xlsx file (workbook.xml not found)");
  const sheets = [...wb.matchAll(/<sheet\b[^>]*>/g)].map(m => attrsOf(m[0]));
  if (!sheets.length) throw new XlsxError("The .xlsx file has no sheets");
  const rels = (await entryText(file, entries, "xl/_rels/workbook.xml.rels")) || "";
  const rid = sheets[0]["r:id"];
  const rel = [...rels.matchAll(/<Relationship\b[^>]*>/g)].map(m => attrsOf(m[0])).find(a => a.Id === rid);
  let target = (rel?.Target || "worksheets/sheet1.xml").replace(/^\//, "");
  if (!target.startsWith("xl/")) target = "xl/" + target;
  return { path: target, names: sheets.map(s => s.name || "") };
}

const colIndex = ref => { let c = 0; for (let k = 0; k < ref.length; k++) { const ch = ref.charCodeAt(k); if (ch < 65 || ch > 90) break; c = c * 26 + (ch - 64); } return c - 1; };

/** Celdas de una fila (<row>...</row>) -> array por índice de columna (sólo las columnas en `want`) */
function parseRow(row, want, shared, out) {
  let i = 0, next = 0;
  for (;;) {
    i = row.indexOf("<c", i);
    if (i < 0) break;
    const c1 = row.charCodeAt(i + 2);
    if (c1 !== 32 && c1 !== 62 && c1 !== 47) { i += 2; continue; }   // "<c " / "<c>" / "<c/>" (no "<col")
    const close = row.indexOf(">", i);
    const self = row.charCodeAt(close - 1) === 47;
    const attrs = row.substring(i + 2, self ? close - 1 : close);
    let col = next;
    const ri = attrs.indexOf(' r="');
    if (ri >= 0) col = colIndex(attrs.substring(ri + 4, attrs.indexOf('"', ri + 4)));
    next = col + 1;
    if (self) { i = close + 1; continue; }
    const end = row.indexOf("</c>", close);
    const slot = want[col];
    if (slot !== undefined) {
      const inner = row.substring(close + 1, end);
      const ti = attrs.indexOf(' t="');
      const t = ti >= 0 ? attrs.substring(ti + 4, attrs.indexOf('"', ti + 4)) : "n";
      let v = "";
      if (t === "inlineStr") v = texts(inner);
      else {
        const a = inner.indexOf("<v>");
        if (a >= 0) {
          v = inner.substring(a + 3, inner.indexOf("</v>", a));
          if (t === "s") v = shared[+v] ?? "";
          else if (t === "b") v = v === "1" ? "TRUE" : "FALSE";
          else if (t !== "n") v = unesc(v);
        }
      }
      out[slot] = v;
    }
    i = end + 4;
  }
  return out;
}

const csvCell = v => '"' + (v.indexOf('"') >= 0 ? v.replaceAll('"', '""') : v) + '"';

/**
 * Lee la primera hoja y la entrega en lotes CSV (con encabezado) de las columnas `columns` que existan.
 * Devuelve { header, sheets, rows }. `required`: columnas obligatorias (si falta alguna -> XlsxError).
 * Agrega la columna "__rid" (número de fila de datos, desde 0) para conservar el orden del archivo.
 */
export async function readXlsx(file, { columns, required = [], batchRows = 50000, onBatch, onProgress, name = file.name } = {}) {
  const entries = await zipEntries(file);
  const { path, names } = await firstSheet(file, entries);
  const sheetEntry = entries.get(path);
  if (!sheetEntry) throw new XlsxError(`Sheet not found in ${name}`);
  const shared = parseShared(await entryText(file, entries, "xl/sharedStrings.xml"));

  const reader = (await entryStream(file, sheetEntry)).pipeThrough(new TextDecoderStream()).getReader();
  let buf = "", header = null, want = null, outCols = null, total = 0, rows = 0, lines = [];
  const flush = async () => {
    if (!lines.length) return;
    const text = outCols.map(csvCell).join(",") + "\n" + lines.join("\n") + "\n";
    lines = [];
    await onBatch(text);
  };
  for (;;) {
    const { value, done } = await reader.read();
    if (value) buf += value;
    if (!total) {
      const d = /<dimension ref="[A-Z]+\d+:[A-Z]+(\d+)"/.exec(buf);
      if (d) total = Math.max(1, parseInt(d[1], 10) - 1);
    }
    let pos = 0;
    for (;;) {
      const s = buf.indexOf("<row", pos);
      if (s < 0) break;
      const e = buf.indexOf("</row>", s);
      if (e < 0) {
        // fila vacía autocontenida (<row .../>)
        const gt = buf.indexOf(">", s);
        if (gt >= 0 && buf.charCodeAt(gt - 1) === 47) { pos = gt + 1; continue; }
        break;
      }
      const row = buf.substring(s, e);
      pos = e + 6;
      if (!header) {
        const cells = parseRow(row, new Proxy({}, { get: (_, k) => Number(k) }), shared, []);
        header = Array.from(cells, v => v ?? "");
        const missing = required.filter(c => !header.includes(c));
        if (missing.length) throw new XlsxError(`Missing columns in ${name}: ${missing.join(", ")}`);
        outCols = columns.filter(c => header.includes(c));
        want = {};
        outCols.forEach((c, k) => { want[header.indexOf(c)] = k; });
        outCols = [...outCols, "__rid"];
        continue;
      }
      const vals = parseRow(row, want, shared, new Array(outCols.length - 1).fill(""));
      if (vals.every(v => v === "")) continue;                 // fila sin datos
      vals.push(String(rows));
      lines.push(vals.map(csvCell).join(","));
      rows++;
      if (lines.length >= batchRows) {
        await flush();
        onProgress?.(Math.min(1, rows / (total || rows)), rows);
      }
    }
    buf = buf.substring(pos);
    if (done) break;
  }
  if (!header) throw new XlsxError(`${name} has no rows`);
  await flush();
  onProgress?.(1, rows);
  return { header, sheets: names, rows };
}

/** Sólo el encabezado y los nombres de las hojas (lee el principio del archivo) */
export async function xlsxHeader(file) {
  const entries = await zipEntries(file);
  const { path, names } = await firstSheet(file, entries);
  const shared = parseShared(await entryText(file, entries, "xl/sharedStrings.xml"));
  const reader = (await entryStream(file, entries.get(path))).pipeThrough(new TextDecoderStream()).getReader();
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (value) buf += value;
    const s = buf.indexOf("<row"), e = buf.indexOf("</row>", s);
    if (s >= 0 && e >= 0) {
      reader.cancel().catch(() => {});
      const cells = parseRow(buf.substring(s, e), new Proxy({}, { get: (_, k) => Number(k) }), shared, []);
      return { header: Array.from(cells, v => v ?? ""), sheets: names };
    }
    if (done || buf.length > 8e6) return { header: [], sheets: names };
  }
}
