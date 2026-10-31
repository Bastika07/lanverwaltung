'use strict';
// CSV für Excel/LibreOffice: Semikolon, BOM, CRLF. Zeilenumbrüche (auch ein einzelnes \r) nur in Anführungszeichen,
// Formelzeichen am Anfang des Feldes und jeder enthaltenen Zeile entschärfen (Formel-Injection).

function cell(v) {
  let s = v == null ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  s = s.replace(/([\r\n])(?=[=+\-@\t])/g, "$1'");
  return /[";\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

const csv = (rows) => '﻿' + rows.map((r) => r.map(cell).join(';')).join('\r\n');

module.exports = { cell, csv };
