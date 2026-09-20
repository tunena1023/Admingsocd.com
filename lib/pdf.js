/* ============================================================
   lib/pdf.js — generador de PDF minimo, SIN dependencias.

   Se escribe a mano a proposito: agregar una libreria de PDF
   (pdfkit, puppeteer) obligaria a empaquetar binarios o fuentes
   en las Netlify Functions. Aqui solo se usan las 14 fuentes
   estandar de PDF, que todo lector trae incluidas. 'zlib' es el
   unico require de imagenes (PNG) -- viene incluido en Node, no
   es una dependencia nueva de verdad.

   Soporta: texto (normal/negrita), tamanos, saltos de linea
   automaticos por ancho, lineas horizontales, tablas simples,
   y salto de pagina automatico.

   BUG REAL encontrado (19/09/2026, reportado por el dueño: "no
   olvides el logo, se supone que debe tener el logo"): Logo.jpg en
   SharePoint es en realidad un PNG (con el nombre viejo .jpg, mismo
   patron que el bug ya documentado de fotos HEIC etiquetadas .jpg en
   Tech) -- jpegInfo() lo rechazaba de inmediato (no arranca con el
   marcador SOI de JPEG, 0xFFD8) y setWatermark() se quedaba callado,
   sin dibujar nada, en TODOS los PDFs (orden, completion, solicitud),
   siempre. El navegador nunca lo noto porque un <img> muestra
   cualquier formato sin importarle la extension del archivo -- el
   parser de PDF, hecho a mano, si necesita saber de verdad que es.
   Se agrega soporte de PNG (8 bits, sin interlace, sin paleta -- los
   casos reales de un logo exportado normal) como alternativa cuando
   jpegInfo() no reconoce el buffer.

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

/* Como wrapText(), pero respeta saltos de linea explicitos (\n) en el
   texto -- cada parte entre \n se envuelve por separado y nunca se
   junta con la de al lado. wrapText() por si sola trata \n como un
   espacio en blanco mas (split en /\s+/), asi que una celda de tabla
   con varias lineas (ej. una lista de "Added: X" / "Removed: Y") se
   veia toda pegada en un solo parrafo -- a peticion del dueño, para
   que el Detail de Change History salga como lista de verdad. */
function wrapMultiline(text, size, bold, maxWidth) {
  const parts = String(text == null ? '' : text).split('\n');
  let out = [];
  parts.forEach(p => { out = out.concat(wrapText(p, size, bold, maxWidth)); });
  return out.length ? out : [''];
}

const GOLD = [0.788, 0.659, 0.298];   // #C9A84C
const BLACK = [0.067, 0.067, 0.067];  // #111111
const GRAY = [0.42, 0.42, 0.42];
const RULE = [0.878, 0.867, 0.839];

/* Lee ancho/alto/componentes de color de un JPEG a mano (sin libreria) --
   basta con encontrar el marcador SOF y leer sus primeros bytes.
   components: 1=escala de grises, 3=RGB/YCbCr, 4=CMYK. */
function jpegInfo(buffer) {
  if (!buffer || buffer.length < 4 || buffer[0] !== 0xFF || buffer[1] !== 0xD8) return null;
  let offset = 2;
  while (offset + 4 <= buffer.length) {
    if (buffer[offset] !== 0xFF) { offset++; continue; }
    const marker = buffer[offset + 1];
    if (marker === 0xD8 || marker === 0x01 || (marker >= 0xD0 && marker <= 0xD7)) { offset += 2; continue; }
    if (marker === 0xD9 || offset + 4 > buffer.length) break;
    const segLength = buffer.readUInt16BE(offset + 2);
    const isSOF = marker >= 0xC0 && marker <= 0xCF && marker !== 0xC4 && marker !== 0xC8 && marker !== 0xCC;
    if (isSOF && offset + 9 < buffer.length) {
      return {
        height: buffer.readUInt16BE(offset + 5),
        width: buffer.readUInt16BE(offset + 7),
        components: buffer[offset + 9]
      };
    }
    offset += 2 + segLength;
  }
  return null;
}

const zlib = require('zlib');
const PNG_SIG = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);

/* Lee ancho/alto/tipo de color de un PNG a mano -- igual que
   jpegInfo, solo la cabecera IHDR (siempre son los primeros 25 bytes
   despues de la firma, el formato PNG lo garantiza). Rechaza
   interlaced (Adam7), bit depths distintos de 8, y paleta (colorType
   3) a proposito -- son casos raros en un logo de verdad exportado
   normal, y un PNG que no calce cae de vuelta a "sin marca de agua"
   en vez de arriesgar un decode incorrecto. */
function pngInfo(buffer) {
  if (!buffer || buffer.length < 33 || !buffer.slice(0, 8).equals(PNG_SIG)) return null;
  if (buffer.toString('ascii', 12, 16) !== 'IHDR') return null;
  const width = buffer.readUInt32BE(16);
  const height = buffer.readUInt32BE(20);
  const bitDepth = buffer[24];
  const colorType = buffer[25];
  const interlace = buffer[28];
  if (bitDepth !== 8 || interlace !== 0) return null;
  if (![0, 2, 4, 6].includes(colorType)) return null; // 0=gris 2=RGB 4=gris+alfa 6=RGBA (3=paleta, no soportada)
  return { width, height, colorType };
}

/* Decodifica un PNG (8 bits, sin interlace, sin paleta -- ya validado
   por pngInfo) a pixeles RGB planos (3 bytes por pixel, sin canal
   alfa -- si el PNG trae transparencia se compone sobre blanco). Es
   una marca de agua casi transparente de fondo (opacity ~0.07 via
   ExtGState), no vale la pena cargar con el canal alfa real para
   esto -- componer sobre blanco se ve identico a simple vista. */
function pngToRgb(buffer, info) {
  const idatParts = [];
  let offset = 8;
  while (offset + 8 <= buffer.length) {
    const len = buffer.readUInt32BE(offset);
    const type = buffer.toString('ascii', offset + 4, offset + 8);
    const dataStart = offset + 8;
    if (dataStart + len > buffer.length) break;
    if (type === 'IDAT') idatParts.push(buffer.slice(dataStart, dataStart + len));
    if (type === 'IEND') break;
    offset = dataStart + len + 4; // +4 = CRC de 4 bytes al final de cada chunk
  }
  if (!idatParts.length) return null;

  let raw;
  try { raw = zlib.inflateSync(Buffer.concat(idatParts)); } catch (e) { return null; }

  const channels = info.colorType === 2 ? 3 : info.colorType === 6 ? 4 : info.colorType === 4 ? 2 : 1;
  const rowBytes = info.width * channels;
  if (raw.length < (rowBytes + 1) * info.height) return null;

  /* "Unfilter" -- cada renglon del PNG viene precedido por 1 byte que
     dice como se filtro (None/Sub/Up/Average/Paeth), algoritmo fijo
     del formato PNG, igual siempre. */
  const out = Buffer.alloc(info.height * rowBytes);
  let rawOffset = 0;
  let prevRow = Buffer.alloc(rowBytes);
  for (let y = 0; y < info.height; y++) {
    const filterType = raw[rawOffset]; rawOffset++;
    const row = raw.slice(rawOffset, rawOffset + rowBytes); rawOffset += rowBytes;
    const outRow = Buffer.alloc(rowBytes);
    for (let x = 0; x < rowBytes; x++) {
      const a = x >= channels ? outRow[x - channels] : 0;
      const b = prevRow[x];
      const c = x >= channels ? prevRow[x - channels] : 0;
      let val = row[x];
      if (filterType === 1) val += a;
      else if (filterType === 2) val += b;
      else if (filterType === 3) val += (a + b) >> 1;
      else if (filterType === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        val += (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c);
      }
      outRow[x] = val & 0xFF;
    }
    outRow.copy(out, y * rowBytes);
    prevRow = outRow;
  }

  const rgb = Buffer.alloc(info.width * info.height * 3);
  const pixels = info.width * info.height;
  for (let i = 0, p = 0; i < pixels; i++, p += 3) {
    if (channels === 3) {
      out.copy(rgb, p, i * 3, i * 3 + 3);
    } else if (channels === 4) {
      const o = i * 4, alpha = out[o + 3] / 255;
      rgb[p]     = Math.round(out[o]     * alpha + 255 * (1 - alpha));
      rgb[p + 1] = Math.round(out[o + 1] * alpha + 255 * (1 - alpha));
      rgb[p + 2] = Math.round(out[o + 2] * alpha + 255 * (1 - alpha));
    } else if (channels === 2) {
      const o = i * 2, g = out[o], alpha = out[o + 1] / 255;
      const v = Math.round(g * alpha + 255 * (1 - alpha));
      rgb[p] = rgb[p + 1] = rgb[p + 2] = v;
    } else {
      const g = out[i];
      rgb[p] = rgb[p + 1] = rgb[p + 2] = g;
    }
  }
  return rgb;
}

class PdfDoc {
  constructor(opts = {}) {
    this.width = opts.width || 612;      // Letter
    this.height = opts.height || 792;
    this.margin = opts.margin || 54;
    this.pages = [];
    this.ops = null;
    this.y = 0;
    this._watermark = null;
    /* Fotos insertadas con image()/photoGrid() -- distinto de la marca
       de agua (una sola, detras de todo). _images: una entrada por
       foto, en el orden en que se agregan. _pageImages[i]: lista de
       indices de _images que aparecen en la pagina i (una foto puede
       vivir en cualquier pagina segun donde caiga el salto). */
    this._images = [];
    this._pageImages = [];
    this._newPage();
  }

  get contentWidth() { return this.width - this.margin * 2; }

  /* Marca de agua: la misma imagen (JPEG) en cada pagina, centrada y
     casi transparente, detras de todo el contenido. Si el buffer no es
     un JPEG valido, se ignora en silencio -- un logo que no carga
     nunca debe tumbar la generacion del PDF. */
  setWatermark(buffer, opts = {}) {
    const jinfo = jpegInfo(buffer);
    if (jinfo) {
      this._watermark = {
        format: 'jpeg', buffer, width: jinfo.width, height: jinfo.height, components: jinfo.components,
        opacity: opts.opacity != null ? opts.opacity : 0.07,
        scale: opts.scale != null ? opts.scale : 0.5
      };
      this._drawWatermarkOn(this.ops);
      return this;
    }
    const pinfo = pngInfo(buffer);
    if (pinfo) {
      const rgb = pngToRgb(buffer, pinfo);
      if (rgb) {
        this._watermark = {
          format: 'png', rgbBuffer: rgb, width: pinfo.width, height: pinfo.height, components: 3,
          opacity: opts.opacity != null ? opts.opacity : 0.07,
          scale: opts.scale != null ? opts.scale : 0.5
        };
        this._drawWatermarkOn(this.ops);
      }
    }
    return this;
  }

  _drawWatermarkOn(ops) {
    const wm = this._watermark;
    if (!wm) return;
    const aspect = wm.width / wm.height;
    let drawW = this.width * wm.scale;
    let drawH = drawW / aspect;
    const maxH = this.height * wm.scale;
    if (drawH > maxH) { drawH = maxH; drawW = drawH * aspect; }
    const x = (this.width - drawW) / 2;
    const y = (this.height - drawH) / 2;
    ops.unshift('q /GSWatermark gs ' + drawW.toFixed(2) + ' 0 0 ' + drawH.toFixed(2)
      + ' ' + x.toFixed(2) + ' ' + y.toFixed(2) + ' cm /ImWatermark Do Q');
  }

  _newPage() {
    this.ops = [];
    this.pages.push(this.ops);
    this.y = this.height - this.margin;
    this._drawWatermarkOn(this.ops);
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
    const lines = wrapMultiline(value == null || value === '' ? '-' : value,
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

  /* Igual que kv(), pero en 2 columnas -- a peticion del dueño, para
     bloques con muchos campos cortos (ej. Order Details) que se ven
     muy largos y con mucho espacio vacio en una sola columna.
     'pairs' es un arreglo de [label, value]; se reparten 2 por
     renglon (izquierda/derecha) en el orden que ya traen, sin
     reordenar. Un numero impar de pares deja la ultima celda de la
     derecha vacia, sin problema. Cada celda es UN renglon (sin
     envolver a varias lineas, a diferencia de kv()) -- los campos
     que van aqui siempre son cortos (fechas, estatus, etc.). */
  kv2col(pairs, opts = {}) {
    const size = opts.size || 10;
    const lead = size * 1.45;
    const gap = 20;
    const colW = (this.contentWidth - gap) / 2;
    for (let i = 0; i < pairs.length; i += 2) {
      this._need(lead);
      this._kvCell(pairs[i], this.margin, colW, size);
      if (pairs[i + 1]) this._kvCell(pairs[i + 1], this.margin + colW + gap, colW, size);
      this.y -= lead;
    }
    return this;
  }

  _kvCell(pair, x, w, size) {
    const label = pair[0], value = pair[1];
    const labelTxt = label ? label + ':' : '';
    const labelW = labelTxt ? widthOf(labelTxt + ' ', size, true) : 0;
    const val = value == null || value === '' ? '-' : String(value);
    const line = wrapText(val, size, false, Math.max(w - labelW, 20))[0] || '';
    if (labelTxt) {
      this.ops.push('BT ' + this._rgb(BLACK) + ' rg /F2 ' + size + ' Tf '
        + x.toFixed(2) + ' ' + this.y.toFixed(2) + ' Td (' + pdfEscape(labelTxt) + ') Tj ET');
    }
    this.ops.push('BT ' + this._rgb(BLACK) + ' rg /F1 ' + size + ' Tf '
      + (x + labelW).toFixed(2) + ' ' + this.y.toFixed(2) + ' Td (' + pdfEscape(line) + ') Tj ET');
  }

  /* Como kv2col(), pero con 2 arreglos INDEPENDIENTES en vez de uno
     solo alternado -- a peticion del dueño, para agrupar por tema
     (ej. datos del lugar a la izquierda, datos del servicio a la
     derecha) en vez de solo repartir 2 por renglon en el orden que
     lleguen. Cada columna avanza a su propio ritmo; si una tiene mas
     renglones que la otra, la corta simplemente deja esa celda vacia. */
  kv2colGroups(left, right, opts = {}) {
    const size = opts.size || 10;
    const lead = size * 1.45;
    const gap = 20;
    const colW = (this.contentWidth - gap) / 2;
    const rows = Math.max(left.length, right.length);
    for (let i = 0; i < rows; i++) {
      this._need(lead);
      if (left[i]) this._kvCell(left[i], this.margin, colW, size);
      if (right[i]) this._kvCell(right[i], this.margin + colW + gap, colW, size);
      this.y -= lead;
    }
    return this;
  }

  /* Bloque de texto alineado a la derecha, para poner algo en paralelo
     a lo que se dibuje a la izquierda justo despues (ej. la info de
     GS Solutions al lado del bloque "Client") -- a peticion del
     dueño. No mueve this.y por si solo (el llamador ya esta usando
     ese cursor para el lado izquierdo al mismo tiempo) -- regresa el
     y final de este bloque, para que el llamador compare contra el
     del otro lado y siga desde el mas bajo de los 2. */
  rightBlock(lines, opts = {}) {
    const size = opts.size || 10;
    const lead = size * 1.45;
    let y = opts.startY != null ? opts.startY : this.y;
    const align = opts.align || 'right';
    /* 'left': antes se anclaba por el ancho de la linea mas larga DE
       ESTE bloque -- se veia bien aislado, pero cada bloque (GS
       Solutions, Status/Supervisor de Order Details, etc.) terminaba
       en un x distinto segun que tan larga fuera su propia linea mas
       larga, asi que no quedaban alineados entre secciones (captura
       marcada por el dueño: "que estos dos esten alineados, como el
       de abajo"). Ahora usa la MISMA columna fija que kv2colGroups
       (this.margin + colW + gap) -- el mismo x en TODAS las secciones
       de 2 columnas del documento, se alineen o no sus contenidos. */
    const gap = 20;
    const colW = (this.contentWidth - gap) / 2;
    const leftX = align === 'left' ? this.margin + colW + gap : null;
    lines.forEach((ln, i) => {
      const bold = i === 0 && opts.boldFirst;
      const x = align === 'left' ? leftX : this.width - this.margin - widthOf(ln, size, bold);
      this.ops.push('BT ' + this._rgb(BLACK) + ' rg '
        + (bold ? '/F2 ' : '/F1 ') + size + ' Tf '
        + x.toFixed(2) + ' ' + y.toFixed(2) + ' Td (' + pdfEscape(ln) + ') Tj ET');
      y -= lead;
    });
    return y;
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
    /* A peticion del dueño: Change History se ve amontonado entre
       renglones (mas notorio cuando alternan filas de 1 linea con
       filas de varias) -- se le puede pedir mas aire con opts.padY sin
       afectar las demas tablas (Services, etc.), que se quedan con el
       espaciado de siempre. */
    const padY = opts.padY != null ? opts.padY : 5;
    const cols = fractions || headers.map(() => 1 / headers.length);
    const widths = cols.map(f => f * this.contentWidth);

    const drawRow = (cells, bold) => {
      const wrapped = cells.map((c, i) =>
        wrapMultiline(c, size, bold, widths[i] - 8));
      const rowLines = Math.max(...wrapped.map(w => w.length));
      const rowHeight = rowLines * lead + padY;
      this._need(rowHeight + 4);
      let li = 0;
      while (li < rowLines) {
        /* Si el renglon es tan alto que no cabe entero ni en una pagina
           en blanco (celda con texto larguisimo, p.ej. un JSON crudo
           que no se pudo resumir), se corta linea por linea y se sigue
           en la pagina de despues -- antes se dibujaba de largo y las
           lineas de mas quedaban invisibles, fuera del margen inferior. */
        if (this.y - lead < this.margin && li > 0) {
          this._newPage();
        }
        let x = this.margin;
        for (let ci = 0; ci < wrapped.length; ci++) {
          const txt = wrapped[ci][li];
          if (txt) {
            this.ops.push('BT ' + this._rgb(bold ? GRAY : BLACK) + ' rg '
              + (bold ? '/F2 ' : '/F1 ') + size + ' Tf '
              + x.toFixed(2) + ' ' + this.y.toFixed(2)
              + ' Td (' + pdfEscape(txt) + ') Tj ET');
          }
          x += widths[ci];
        }
        this.y -= lead;
        li++;
      }
      /* Mismo espacio final que la version original antes de la regla:
         el bucle ya dejo this.y una linea (lead) mas abajo del ultimo
         renglon dibujado -- se ajusta para que quede igual de separado
         de la regla que antes (padY + 3 de aire, restando el lead de
         mas que ya se aplico). */
      this.y -= (padY + 3 - lead);
      this.rule(RULE, 0.5);
    };

    /* BUG REAL encontrado por el dueño (con un PDF real: Change
       History con el encabezado "DATE EVENT BY DETAIL" solo en la
       pagina 1, y TODOS los renglones en la pagina 2): drawRow()
       para el encabezado solo checaba que EL ENCABEZADO cupiera --
       nunca checaba si el primer renglon de datos tambien cabia
       junto con el. Si ese primer renglon es muy alto (ej. "Created",
       con 10+ lineas de servicios listados), el encabezado se dibuja
       solo, y el _need() PROPIO del renglon de datos (que exige su
       ALTURA COMPLETA, no solo 1 linea) dispara un salto de pagina
       INMEDIATAMENTE despues -- dejando el encabezado huerfano.

       Primer intento de arreglo: solo revisar que cupiera el
       encabezado + 1 linea del primer renglon -- NO BASTO, porque el
       renglon real exige su altura COMPLETA (10+ lineas) para
       empezarse a dibujar, no solo 1 linea; el chequeo chico pasaba
       pero el chequeo real de adentro fallaba de todos modos. Ahora
       se calcula la altura REAL del primer renglon (el mismo calculo
       que hace drawRow por dentro) y se exige esa altura completa
       junto con el encabezado -- si no cabe, se saltan los 2 juntos a
       la pagina siguiente, nunca el encabezado solo. */
    if (headers && headers.length) {
      if (rows && rows.length) {
        const firstCells = rows[0].map(c => c == null ? '' : String(c));
        const firstWrapped = firstCells.map((c, i) => wrapMultiline(c, size, false, widths[i] - 8));
        const firstRowLines = Math.max(...firstWrapped.map(w => w.length));
        const firstRowHeight = firstRowLines * lead + padY;
        const headerHeight = lead + padY;
        this._need(headerHeight + 4 + firstRowHeight + 4);
      }
      drawRow(headers.map(h => String(h).toUpperCase()), true);
    }
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

  /* Dibuja UNA foto JPEG en (x,y) con ancho/alto drawW/drawH, en
     coordenadas PDF (y crece hacia arriba, x,y = esquina inferior
     izquierda del rectangulo). Registra la imagen como su propio
     XObject -- no la vuelve a incrustar si el mismo buffer se dibuja
     varias veces, para no inflar el PDF si algun dia se reusa una
     foto. Si el buffer no es un JPEG valido, no dibuja nada y regresa
     false -- una foto que no carga nunca debe tumbar el documento. */
  image(buffer, x, y, drawW, drawH) {
    const info = jpegInfo(buffer);
    if (!info) return false;
    let idx = this._images.findIndex(im => im.buffer === buffer);
    if (idx === -1) {
      idx = this._images.length;
      this._images.push({ buffer, width: info.width, height: info.height, components: info.components });
    }
    const pageIdx = this.pages.length - 1;
    const used = this._pageImages[pageIdx] || (this._pageImages[pageIdx] = []);
    if (!used.includes(idx)) used.push(idx);
    this.ops.push('q ' + drawW.toFixed(2) + ' 0 0 ' + drawH.toFixed(2)
      + ' ' + x.toFixed(2) + ' ' + y.toFixed(2) + ' cm /ImPhoto' + idx + ' Do Q');
    return true;
  }

  /* Cuadricula de fotos, avanzando this.y sola (como cualquier otro
     bloque de contenido) -- pensada para "photos: [{buffer, caption}]".
     Cada celda mide cellW x cellH (cuadrada por default); la foto se
     ajusta DENTRO de su celda preservando su proporcion real (como
     background-size:contain), centrada, para no deformarla. Si una
     fila no cabe completa en lo que queda de pagina, salta de pagina
     ANTES de empezar esa fila (nunca a mitad de fila). Una foto que
     no se pudo leer como JPEG deja un rectangulo gris en su lugar en
     vez de tumbar el documento entero. */
  photoGrid(photos, opts = {}) {
    if (!photos || !photos.length) return this;
    const cols = opts.cols || 3;
    const gap = opts.gap != null ? opts.gap : 10;
    const cellW = (this.contentWidth - gap * (cols - 1)) / cols;
    const cellH = opts.cellH || cellW;
    const capLead = 10;
    const rowSpace = cellH + gap + (opts.captions !== false ? capLead : 0);
    let col = 0;
    let cellTopY = 0;
    for (const p of photos) {
      if (col === 0) { this._need(rowSpace); cellTopY = this.y; }
      const cellX = this.margin + col * (cellW + gap);
      const info = jpegInfo(p.buffer);
      if (info) {
        const aspect = info.width / info.height;
        let dw = cellW, dh = cellW / aspect;
        if (dh > cellH) { dh = cellH; dw = cellH * aspect; }
        const dx = cellX + (cellW - dw) / 2;
        const dy = (cellTopY - cellH) + (cellH - dh) / 2;
        this.image(p.buffer, dx, dy, dw, dh);
      } else {
        this.ops.push('0.93 0.93 0.93 rg ' + cellX.toFixed(2) + ' ' + (cellTopY - cellH).toFixed(2)
          + ' ' + cellW.toFixed(2) + ' ' + cellH.toFixed(2) + ' re f');
      }
      this.ops.push(this._rgb(RULE) + ' RG 0.5 w ' + cellX.toFixed(2) + ' ' + (cellTopY - cellH).toFixed(2)
        + ' ' + cellW.toFixed(2) + ' ' + cellH.toFixed(2) + ' re S');
      if (opts.captions !== false && p.caption) {
        const capLines = wrapText(p.caption, 7, false, cellW);
        if (capLines[0]) {
          this.ops.push('BT ' + this._rgb(GRAY) + ' rg /F1 7 Tf '
            + cellX.toFixed(2) + ' ' + (cellTopY - cellH - 9).toFixed(2)
            + ' Td (' + pdfEscape(capLines[0]) + ') Tj ET');
        }
      }
      col++;
      if (col === cols) { col = 0; this.y = cellTopY - rowSpace; }
    }
    if (col !== 0) this.y = cellTopY - rowSpace;
    return this;
  }

  /* Pie de pagina en todas las paginas: se llama al cerrar. A peticion
     del dueño (19/09/2026, con captura marcada): ya no es un solo
     texto centrado -- va en las 2 esquinas inferiores. Izquierda: lo
     que antes era el pie completo (GS Solutions | OrderId | Revision N
     | Page X of Y). Derecha (opcional): la fecha de emision, que antes
     iba pegada debajo del titulo -- se saca de ahi para que el
     encabezado quede mas limpio. */
  _footer(left, right) {
    const total = this.pages.length;
    this.pages.forEach((ops, i) => {
      const leftLabel = sanitize(left) + '   |   Page ' + (i + 1) + ' of ' + total;
      ops.push('BT ' + this._rgb(GRAY) + ' rg /F1 8 Tf '
        + this.margin.toFixed(2) + ' ' + (this.margin - 24).toFixed(2)
        + ' Td (' + pdfEscape(leftLabel) + ') Tj ET');
      if (right) {
        const rightLabel = sanitize(right);
        const w = widthOf(rightLabel, 8, false);
        ops.push('BT ' + this._rgb(GRAY) + ' rg /F1 8 Tf '
          + (this.width - this.margin - w).toFixed(2) + ' ' + (this.margin - 24).toFixed(2)
          + ' Td (' + pdfEscape(rightLabel) + ') Tj ET');
      }
    });
  }

  end(footerLeft, footerRight) {
    if (footerLeft) this._footer(footerLeft, footerRight);

    const objects = [];
    const push = body => { objects.push(body); return objects.length; };

    /* 1 Catalog, 2 Pages, 3 Font regular, 4 Font bold, [5 imagen de marca
       de agua, 6 su ExtGState de transparencia -- solo si hay una],
       luego pares pagina+stream */
    const catalogNo = push(null);
    const pagesNo = push(null);
    const f1No = push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
    const f2No = push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>');

    let imgNo = null, gsNo = null;
    if (this._watermark) {
      const wm = this._watermark;
      const colorSpace = wm.components === 1 ? '/DeviceGray' : wm.components === 4 ? '/DeviceCMYK' : '/DeviceRGB';
      /* 'latin1' mapea cada byte a un char code 0-255 uno a uno -- el
         binario de la imagen cabe intacto dentro del mismo string del
         resto del PDF, y Buffer.from(out,'latin1') al final lo
         reconstruye byte por byte sin perder nada. JPEG se embebe tal
         cual (DCTDecode = JPEG, sin re-procesar); un PNG ya se
         decodifico a RGB plano en setWatermark(), asi que aqui solo
         se re-comprime con deflate (FlateDecode -- el mismo algoritmo
         que ya trae adentro un PNG, PDF lo soporta nativo). */
      if (wm.format === 'jpeg') {
        const jpegStr = wm.buffer.toString('latin1');
        imgNo = push('<< /Type /XObject /Subtype /Image /Width ' + wm.width + ' /Height ' + wm.height
          + ' /ColorSpace ' + colorSpace + ' /BitsPerComponent 8 /Filter /DCTDecode /Length '
          + wm.buffer.length + ' >>\nstream\n' + jpegStr + '\nendstream');
      } else {
        const deflated = zlib.deflateSync(wm.rgbBuffer);
        const flateStr = deflated.toString('latin1');
        imgNo = push('<< /Type /XObject /Subtype /Image /Width ' + wm.width + ' /Height ' + wm.height
          + ' /ColorSpace ' + colorSpace + ' /BitsPerComponent 8 /Filter /FlateDecode /Length '
          + deflated.length + ' >>\nstream\n' + flateStr + '\nendstream');
      }
      gsNo = push('<< /Type /ExtGState /ca ' + wm.opacity + ' >>');
    }

    /* Fotos agregadas con image()/photoGrid(): cada una su propio
       XObject, mismo mecanismo que la marca de agua. photoObjNos[i]
       guarda el numero de objeto PDF de this._images[i] -- se arman
       todas ANTES del loop de paginas para poder referenciarlas por
       numero al armar los /Resources de cada pagina. */
    const photoObjNos = this._images.map(img => {
      const colorSpace = img.components === 1 ? '/DeviceGray' : img.components === 4 ? '/DeviceCMYK' : '/DeviceRGB';
      const jpegStr = img.buffer.toString('latin1');
      return push('<< /Type /XObject /Subtype /Image /Width ' + img.width + ' /Height ' + img.height
        + ' /ColorSpace ' + colorSpace + ' /BitsPerComponent 8 /Filter /DCTDecode /Length '
        + img.buffer.length + ' >>\nstream\n' + jpegStr + '\nendstream');
    });

    const pageNos = [];
    this.pages.forEach((ops, pageIdx) => {
      const stream = ops.join('\n');
      const streamNo = push('<< /Length ' + Buffer.byteLength(stream, 'latin1')
        + ' >>\nstream\n' + stream + '\nendstream');
      const xobjEntries = [];
      if (imgNo) xobjEntries.push('/ImWatermark ' + imgNo + ' 0 R');
      (this._pageImages[pageIdx] || []).forEach(i => xobjEntries.push('/ImPhoto' + i + ' ' + photoObjNos[i] + ' 0 R'));
      const extras = xobjEntries.length
        ? ' /XObject << ' + xobjEntries.join(' ') + ' >>' + (gsNo ? ' /ExtGState << /GSWatermark ' + gsNo + ' 0 R >>' : '')
        : '';
      const pageNo = push('<< /Type /Page /Parent ' + pagesNo + ' 0 R '
        + '/MediaBox [0 0 ' + this.width + ' ' + this.height + '] '
        + '/Resources << /Font << /F1 ' + f1No + ' 0 R /F2 ' + f2No + ' 0 R >>' + extras + ' >> '
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

module.exports = { PdfDoc, sanitize, widthOf, wrapText, jpegInfo, pngInfo };
