/* Minimal, dependency-free PDF writer (PDF 1.4), just enough to lay out a one-or-more-page
   Certificate of Analysis: positioned text (Helvetica/Helvetica-Bold, base-14, no embedding
   needed), straight lines and stroked/filled rectangles. No external library — matches the
   rest of this codebase's "no dependencies" house style.

   Coordinate system matches the PDF spec: origin at the bottom-left of the page, y increases
   upward. A4 portrait = 595.28 x 841.89 points. */
(function (global) {
  'use strict';
  const PAGE_W = 595.28, PAGE_H = 841.89;

  // WinAnsiEncoding (the font encoding we declare) agrees with Unicode/Latin-1 for code points
  // 0x00-0xFF, but a handful of common punctuation marks outside that range — curly quotes, en/em
  // dash, bullet, ellipsis — live in Windows-1252's 0x80-0x9F block instead. Map those explicitly;
  // everything else in that range becomes '?' rather than silently corrupting the byte stream.
  const WIN_ANSI_HIGH = {
    0x20AC: 0x80, 0x201A: 0x82, 0x0192: 0x83, 0x201E: 0x84, 0x2026: 0x85,
    0x2020: 0x86, 0x2021: 0x87, 0x02C6: 0x88, 0x2030: 0x89, 0x0160: 0x8A,
    0x2039: 0x8B, 0x0152: 0x8C, 0x017D: 0x8E, 0x2018: 0x91, 0x2019: 0x92,
    0x201C: 0x93, 0x201D: 0x94, 0x2022: 0x95, 0x2013: 0x96, 0x2014: 0x97,
    0x02DC: 0x98, 0x2122: 0x99, 0x0161: 0x9A, 0x203A: 0x9B, 0x0153: 0x9C,
    0x017E: 0x9E, 0x0178: 0x9F
  };
  function winAnsiByte(code) {
    if (code <= 0xFF) return code;
    if (code >= 0x2080 && code <= 0x2089) return 0x30 + (code - 0x2080); // subscript digits (CaCO₃, NO₃...) -> plain digits: Helvetica has no subscript glyphs
    return WIN_ANSI_HIGH[code] || 0x3F; // '?' for anything else this font encoding can't represent
  }

  // Maps every character to its actual WinAnsiEncoding byte (so the string's char codes, after
  // this, ARE the output bytes — see bytes() below) and escapes PDF string-literal syntax.
  function escText(s) {
    const str = String(s == null ? '' : s).replace(/[\r\n]+/g, ' ');
    let mapped = '';
    for (let i = 0; i < str.length; i++) mapped += String.fromCharCode(winAnsiByte(str.charCodeAt(i)));
    return mapped.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
  }

  function PdfDoc() {
    this.pages = [];           // each: { ops: string[] }
    this.page = null;
    this.addPage();
  }

  PdfDoc.prototype.addPage = function () {
    this.page = { ops: [] };
    this.pages.push(this.page);
    return this;
  };

  PdfDoc.prototype.text = function (x, y, str, opts) {
    opts = opts || {};
    const size = opts.size || 10;
    const font = opts.bold ? 'F2' : 'F1';
    let px = x;
    if (opts.align === 'right' || opts.align === 'center') {
      const w = PdfDoc.textWidth(str, size, !!opts.bold);
      px = opts.align === 'right' ? x - w : x - w / 2;
    }
    this.page.ops.push('BT /' + font + ' ' + size + ' Tf ' + px.toFixed(2) + ' ' + y.toFixed(2) + ' Td (' + escText(str) + ') Tj ET');
    return this;
  };

  PdfDoc.prototype.line = function (x1, y1, x2, y2, width) {
    this.page.ops.push((width || 0.75).toFixed(2) + ' w ' + x1.toFixed(2) + ' ' + y1.toFixed(2) + ' m ' + x2.toFixed(2) + ' ' + y2.toFixed(2) + ' l S');
    return this;
  };

  PdfDoc.prototype.rect = function (x, y, w, h, mode) {
    this.page.ops.push(x.toFixed(2) + ' ' + y.toFixed(2) + ' ' + w.toFixed(2) + ' ' + h.toFixed(2) + ' re ' + (mode === 'fill' ? 'f' : 'S'));
    return this;
  };

  PdfDoc.prototype.gray = function (level) {
    this.page.ops.push(level.toFixed(2) + ' g ' + level.toFixed(2) + ' G');
    return this;
  };

  // Approximate Helvetica advance widths (per 1000 units of font size) — close enough for
  // right/centre alignment and simple word-wrap; not used for kerning or justification.
  const AVG_ADVANCE = 556;
  PdfDoc.textWidth = function (str, size, bold) {
    return (String(str || '').length * AVG_ADVANCE / 1000) * size * (bold ? 1.04 : 1);
  };

  // naive word-wrap to a max width in points; returns an array of lines
  PdfDoc.wrap = function (str, size, maxWidth, bold) {
    const words = String(str || '').split(/\s+/).filter(Boolean);
    const lines = [];
    let cur = '';
    for (const w of words) {
      const test = cur ? cur + ' ' + w : w;
      if (PdfDoc.textWidth(test, size, bold) > maxWidth && cur) { lines.push(cur); cur = w; }
      else cur = test;
    }
    if (cur) lines.push(cur);
    return lines.length ? lines : [''];
  };

  PdfDoc.prototype.bytes = function () {
    const chunks = [];
    let offset = 0;
    // Every character pushed here is already a real byte value (0-255): PDF structural syntax is
    // plain ASCII, and all text content has already been through escText()'s WinAnsiEncoding
    // mapping above — so .length is the exact byte count, no UTF-8 expansion needed.
    const push = (s) => { chunks.push(s); offset += s.length; };

    const offsets = [];
    push('%PDF-1.4\n');

    const nPages = this.pages.length;
    const catalogNum = 1, pagesNum = 2, fontNum = 3, fontBNum = 4;
    const firstPageObj = 5; // then one content-stream object follows each page object

    offsets[catalogNum] = offset;
    push(catalogNum + ' 0 obj\n<< /Type /Catalog /Pages ' + pagesNum + ' 0 R >>\nendobj\n');

    const kids = [];
    for (let i = 0; i < nPages; i++) kids.push((firstPageObj + i * 2) + ' 0 R');
    offsets[pagesNum] = offset;
    push(pagesNum + ' 0 obj\n<< /Type /Pages /Count ' + nPages + ' /Kids [' + kids.join(' ') + '] >>\nendobj\n');

    offsets[fontNum] = offset;
    push(fontNum + ' 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>\nendobj\n');
    offsets[fontBNum] = offset;
    push(fontBNum + ' 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>\nendobj\n');

    for (let i = 0; i < nPages; i++) {
      const pageNum = firstPageObj + i * 2;
      const contentNum = pageNum + 1;
      const content = this.pages[i].ops.join('\n');
      const contentBytes = content.length;

      offsets[pageNum] = offset;
      push(pageNum + ' 0 obj\n<< /Type /Page /Parent ' + pagesNum + ' 0 R /MediaBox [0 0 ' + PAGE_W + ' ' + PAGE_H + ']' +
        ' /Resources << /Font << /F1 ' + fontNum + ' 0 R /F2 ' + fontBNum + ' 0 R >> >> /Contents ' + contentNum + ' 0 R >>\nendobj\n');

      offsets[contentNum] = offset;
      push(contentNum + ' 0 obj\n<< /Length ' + contentBytes + ' >>\nstream\n' + content + '\nendstream\nendobj\n');
    }

    const xrefStart = offset;
    const totalObjs = firstPageObj + nPages * 2; // 1..N, object 0 is the free-list head
    push('xref\n0 ' + totalObjs + '\n');
    push('0000000000 65535 f \n');
    for (let n = 1; n < totalObjs; n++) {
      push(String(offsets[n]).padStart(10, '0') + ' 00000 n \n');
    }
    push('trailer\n<< /Size ' + totalObjs + ' /Root ' + catalogNum + ' 0 R >>\n');
    push('startxref\n' + xrefStart + '\n%%EOF');

    // every char code here is already a byte value (0-255); copy them straight out
    const full = chunks.join('');
    const bytes = new Uint8Array(full.length);
    for (let i = 0; i < full.length; i++) bytes[i] = full.charCodeAt(i) & 0xFF;
    return bytes;
  };

  PdfDoc.prototype.blob = function () {
    return new Blob([this.bytes()], { type: 'application/pdf' });
  };

  PdfDoc.prototype.download = function (filename) {
    const url = URL.createObjectURL(this.blob());
    const a = document.createElement('a');
    a.href = url; a.download = filename || 'document.pdf';
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  };

  PdfDoc.PAGE_W = PAGE_W;
  PdfDoc.PAGE_H = PAGE_H;
  global.PdfDoc = PdfDoc;
})(window);
