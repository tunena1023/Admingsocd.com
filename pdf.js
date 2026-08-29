/* ============================================================
   lib/pdf.js — generador de PDF minimo, SIN dependencias.

   Se escribe a mano a proposito: agregar una libreria de PDF
   (pdfkit, puppeteer) obligaria a empaquetar binarios o fuentes
   en las Netlify Functions. Aqui solo se usan las 14 fuentes
   estandar de PDF, que todo lector trae incluidas.

   Soporta: texto (normal/negrita), tamanos, saltos de linea
   automaticos por ancho, lineas horizontales, tablas simples,
   y salto de pagina automatico.

   Uso:
     const { PdfDoc } = require('./lib/pdf');
     const doc = new PdfDoc();
     doc.h1('Order #GS-6062-1010');
     doc.kv('Status', 'Approved');
     doc.hr();
     doc.table([['Service','Option']], [['Deep Clean','3 Bedroom']]);
     const buffer = doc.end();
============================================================ */

/* Anchos oficiales de las fuentes base, caracteres 32..126.
   Sin esto no se puede medir el texto y las lineas se desbordan. */
const W_REG = [
  278,278,355,556,556,889,667,191,333,333,389,584,278,333,278,278,
  556,556,556,556,556,556,556,556,556,556,278,278,584,584,584,556,
  1015,667,667,722,722,667,611,778,722,278,500,667,556,833,722,778,
  667,778,722,667,611,722,667,944,667,667,611,278,278,278,469,556,
  333,556,556,500,556,556,278,556,556,222,222,500,222,833,556,556,
  556,556,333,500,278,556,500,722,500,500,500,334,260,334,584
];
const W_BOLD = [
  278,333,474,556,556,889,722,238,333,333,389,584,278,333,278,278,
  556,556,556,556,556,556,556,556,556,556,333,333,584,584,584,611,
  975,722,722,722,722,667,611,778,722,278,556,722,611,833,722,778,
  667,778,722,667,611,722,667,944,667,667,611,333,278,333,584,556,
  333,556,611,556,611,556,333,611,611,278,278,556,278,889,611,611,
  611,611,389,556,333,611,556,778,556,556,500,389,280,389,584
];

/* Sustituye lo que no exista en WinAnsi por algo imprimible.
   Un PDF con bytes invalidos no abre; es mejor perder un acento. */
const FALLBACK = {
  '\u2014': '-', '\u2013': '-', '\u2018': "'", '\u2019': "'",
  '\u201C': '"', '\u201D': '"', '\u2026': '...', '\u00A0': ' ',
  '\u2192': '->', '\u2022': '-', '\u00B7': '-'
};

function sanitize(str) {
  let s = String(str == null ? '' : str);
  s = s.replace(/[\u2014\u2013\u2018\u2019\u201C\u201D\u2026\u00A0\u2192\u2022\u00B7]/g,
    ch => FALLBACK[ch] || ' ');
  let out = '';
  for (const ch of s) {
    const c = ch.codePointAt(0);
    if (c === 9) { out += ' '; continue; }
    if (c < 32) continue;
    if (c <= 126) { out += ch; continue; }
    /* Acentos latinos: quitar la tilde antes que romper el archivo */
    const plain = ch.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    out += (plain.codePointAt(0) <= 126) ? plain : '?';
  }
  return out;
}

function widthOf(text, size, bold) {
  const table = bold ? W_BOLD : W_REG;
  let total = 0;
  const s = sanitize(text);
  for (let i = 0; i < s.length; i++) {
    const idx = s.charCodeAt(i) - 32;
    total += (idx >= 0 && idx < table.length) ? table[idx] : 556;
  }
  return total * size / 1000;
}

/* Escapa lo que rompe un literal de texto en PDF */
function pdfEscape(text) {
  return sanitize(text).replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
}

/* Parte una linea larga en varias que quepan en maxWidth */
function wrapText(text, size, bold, maxWidth) {
  const words = sanitize(text).split(/\s+/).filter(w => w.length);
  if (!words.length) return [''];
  const lines = [];
  let line = '';
  for (const word of words) {
    const candidate = line ? line + ' ' + word : word;
    if (widthOf(candidate, size, bold) <= maxWidth) { line = candidate; continue; }
    if (line) lines.push(line);
    /* Palabra sola mas ancha que la caja: cortarla por caracter */
    if (widthOf(word, size, bold) > maxWidth) {
      let chunk = '';
      for (const ch of word) {
        if (widthOf(chunk + ch, size, bold) > maxWidth && chunk) { lines.push(chunk); chunk = ch; }
        else chunk += ch;
      }
      line = chunk;
    } else line = word;
  }
  if (line) lines.push(line);
  return lines;
}

const GOLD = [0.788, 0.659, 0.298];   // #C9A84C
const BLACK = [0.067, 0.067, 0.067];  // #111111
const GRAY = [0.42, 0.42, 0.42];
const RULE = [0.878, 0.867, 0.839];

class PdfDoc {
  constructor(opts = {}) {
    this.width = opts.width || 612;      // Letter
    this.height = opts.height || 792;
    this.margin = opts.margin || 54;
    this.pages = [];
    this.ops = null;
    this.y = 0;
    this._newPage();
  }

  get contentWidth() { return this.width - this.margin * 2; }

  _newPage() {
    this.ops = [];
    this.pages.push(this.ops);
    this.y = this.height - this.margin;
  }

  _need(space) {
    if (this.y - space < this.margin) this._newPage();
  }

  _rgb(c) { return c[0].toFixed(3) + ' ' + c[1].toFixed(3) + ' ' + c[2].toFixed(3); }

  /* Una linea de texto ya medida, en la posicion actual */
  _line(text, opts) {
    const size = opts.size || 10;
    const bold = !!opts.bold;
    const color = opts.color || BLACK;
    const x = this.margin + (opts.indent || 0);
    const font = bold ? '/F2' : '/F1';
    this.ops.push('BT ' + this._rgb(color) + ' rg ' + font + ' ' + size + ' Tf '
      + x.toFixed(2) + ' ' + this.y.toFixed(2) + ' Td (' + pdfEscape(text) + ') Tj ET');
  }

  /* Texto con salto de linea automatico */
  text(str, opts = {}) {
    const size = opts.size || 10;
    const bold = !!opts.bold;
    const lead = opts.leading || size * 1.45;
    const indent = opts.indent || 0;
    const maxW = (opts.maxWidth || this.contentWidth) - indent;
    const lines = wrapText(str, size, bold, maxW);
    for (const ln of lines) {
      this._need(lead);
      this._line(ln, opts);
      this.y -= lead;
    }
    return this;
  }

  h1(str) {
    this._need(30);
    this.text(str, { size: 20, bold: true, leading: 26 });
    return this;
  }

  h2(str) {
    this.y -= 10;
    this._need(20);
    this.text(String(str).toUpperCase(), { size: 9, bold: true, color: GRAY, leading: 15 });
    this.rule(GOLD, 1);
    this.y -= 5;
    return this;
  }

  /* Etiqueta en negrita + valor en la misma linea; el valor envuelve alineado */
  kv(label, value, opts = {}) {
    const size = opts.size || 10;
    const lead = size * 1.45;
    const labelTxt = label ? label + ':' : '';
    const labelW = labelTxt ? widthOf(labelTxt + ' ', size, true) : 0;
    const lines = wrapText(value == null || value === '' ? '-' : value,
      size, false, this.contentWidth - labelW);
    for (let i = 0; i < lines.length; i++) {
      this._need(lead);
      if (i === 0 && labelTxt) this._line(labelTxt, { size, bold: true });
      this.ops.push('BT ' + this._rgb(BLACK) + ' rg /F1 ' + size + ' Tf '
        + (this.margin + labelW).toFixed(2) + ' ' + this.y.toFixed(2)
        + ' Td (' + pdfEscape(lines[i]) + ') Tj ET');
      this.y -= lead;
    }
    return this;
  }

  rule(color, thickness) {
    this._need(6);
    const c = color || RULE;
    this.ops.push(this._rgb(c) + ' RG ' + (thickness || 0.7) + ' w '
      + this.margin + ' ' + this.y.toFixed(2) + ' m '
      + (this.width - this.margin) + ' ' + this.y.toFixed(2) + ' l S');
    this.y -= 6;
    return this;
  }

  hr() { this.y -= 4; this.rule(); this.y -= 4; return this; }

  gap(n) { this.y -= (n || 8); return this; }

  /* Tabla con anchos en fraccion del ancho util: [0.3, 0.7] */
  table(headers, rows, fractions, opts = {}) {
    const size = opts.size || 9.5;
    const lead = size * 1.4;
    const padY = 5;
    const cols = fractions || headers.map(() => 1 / headers.length);
    const widths = cols.map(f => f * this.contentWidth);

    const drawRow = (cells, bold) => {
      const wrapped = cells.map((c, i) =>
        wrapText(c, size, bold, widths[i] - 8));
      const rowLines = Math.max(...wrapped.map(w => w.length));
      const rowHeight = rowLines * lead + padY;
      this._need(rowHeight + 4);
      const topY = this.y;
      for (let li = 0; li < rowLines; li++) {
        let x = this.margin;
        for (let ci = 0; ci < wrapped.length; ci++) {
          const txt = wrapped[ci][li];
          if (txt) {
            this.ops.push('BT ' + this._rgb(bold ? GRAY : BLACK) + ' rg '
              + (bold ? '/F2 ' : '/F1 ') + size + ' Tf '
              + x.toFixed(2) + ' ' + (topY - li * lead).toFixed(2)
              + ' Td (' + pdfEscape(txt) + ') Tj ET');
          }
          x += widths[ci];
        }
      }
      this.y = topY - rowLines * lead - padY + lead - 3;
      this.rule(RULE, 0.5);
    };

    if (headers && headers.length) drawRow(headers.map(h => String(h).toUpperCase()), true);
    (rows || []).forEach(r => drawRow(r.map(c => c == null ? '' : String(c)), false));
    return this;
  }

  /* Recuadro con barra dorada a la izquierda, para avisos */
  notice(title, body) {
    const size = 9.5;
    const lead = size * 1.4;
    const inner = this.contentWidth - 16;
    const titleLines = title ? wrapText(title, size, true, inner) : [];
    const bodyLines = body ? wrapText(body, size, false, inner) : [];
    const boxH = (titleLines.length + bodyLines.length) * lead + 14;
    this._need(boxH + 8);
    const top = this.y + 4;
    this.ops.push('0.973 0.965 0.949 rg ' + this.margin + ' ' + (top - boxH).toFixed(2)
      + ' ' + this.contentWidth + ' ' + boxH.toFixed(2) + ' re f');
    this.ops.push(this._rgb(GOLD) + ' rg ' + this.margin + ' ' + (top - boxH).toFixed(2)
      + ' 3 ' + boxH.toFixed(2) + ' re f');
    this.y = top - 12;
    titleLines.forEach(l => { this._line(l, { size, bold: true, indent: 12 }); this.y -= lead; });
    bodyLines.forEach(l => { this._line(l, { size, indent: 12 }); this.y -= lead; });
    this.y = top - boxH - 8;
    return this;
  }

  /* Pie de pagina en todas las paginas: se llama al cerrar */
  _footer(text) {
    const total = this.pages.length;
    this.pages.forEach((ops, i) => {
      const label = sanitize(text) + '   |   Page ' + (i + 1) + ' of ' + total;
      const w = widthOf(label, 8, false);
      ops.push('BT ' + this._rgb(GRAY) + ' rg /F1 8 Tf '
        + ((this.width - w) / 2).toFixed(2) + ' ' + (this.margin - 24).toFixed(2)
        + ' Td (' + pdfEscape(label) + ') Tj ET');
    });
  }

  end(footerText) {
    if (footerText) this._footer(footerText);

    const objects = [];
    const push = body => { objects.push(body); return objects.length; };

    /* 1 Catalog, 2 Pages, 3 Font regular, 4 Font bold, luego pares pagina+stream */
    const catalogNo = push(null);
    const pagesNo = push(null);
    const f1No = push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
    const f2No = push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>');

    const pageNos = [];
    this.pages.forEach(ops => {
      const stream = ops.join('\n');
      const streamNo = push('<< /Length ' + Buffer.byteLength(stream, 'latin1')
        + ' >>\nstream\n' + stream + '\nendstream');
      const pageNo = push('<< /Type /Page /Parent ' + pagesNo + ' 0 R '
        + '/MediaBox [0 0 ' + this.width + ' ' + this.height + '] '
        + '/Resources << /Font << /F1 ' + f1No + ' 0 R /F2 ' + f2No + ' 0 R >> >> '
        + '/Contents ' + streamNo + ' 0 R >>');
      pageNos.push(pageNo);
    });

    objects[catalogNo - 1] = '<< /Type /Catalog /Pages ' + pagesNo + ' 0 R >>';
    objects[pagesNo - 1] = '<< /Type /Pages /Count ' + pageNos.length
      + ' /Kids [' + pageNos.map(n => n + ' 0 R').join(' ') + '] >>';

    let out = '%PDF-1.4\n';
    const offsets = [];
    objects.forEach((body, i) => {
      offsets.push(Buffer.byteLength(out, 'latin1'));
      out += (i + 1) + ' 0 obj\n' + body + '\nendobj\n';
    });
    const xrefPos = Buffer.byteLength(out, 'latin1');
    out += 'xref\n0 ' + (objects.length + 1) + '\n0000000000 65535 f \n';
    offsets.forEach(off => {
      out += String(off).padStart(10, '0') + ' 00000 n \n';
    });
    out += 'trailer\n<< /Size ' + (objects.length + 1) + ' /Root ' + catalogNo + ' 0 R >>\n'
      + 'startxref\n' + xrefPos + '\n%%EOF\n';

    return Buffer.from(out, 'latin1');
  }
}

module.exports = { PdfDoc, sanitize, widthOf, wrapText };
