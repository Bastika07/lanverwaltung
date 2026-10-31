'use strict';
const fs = require('node:fs');
const path = require('node:path');

function checkRole(report, coverage, exit, role) {
  if (![0, 2].includes(exit)) throw new Error(`${role}: ZAP fehlgeschlagen oder unvollständig (Exit ${exit}).`);
  if (coverage.role !== role || coverage.role_verified !== true) throw new Error(`${role}: Rollenprüfung fehlt.`);
  if (!Array.isArray(coverage.active_scans) || !coverage.active_scans.length ||
      !coverage.active_scans.every((scan) => String(scan.progress) === '100' && Number(scan.reqCount) > 0) ||
      !(coverage.message_count > 0)) throw new Error(`${role}: Kein abgeschlossener aktiver Scan mit Anfragen.`);
  if (!Array.isArray(report.site) || !report.site.length) throw new Error(`${role}: ZAP-Bericht enthält keine Ziele.`);
  let warnings = 0;
  for (const site of report.site) {
    if (site['@name'] !== 'http://127.0.0.1:3000' || !Array.isArray(site.alerts)) throw new Error(`${role}: Unerwartetes Ziel oder ungültige Befundliste.`);
    for (const alert of site.alerts) {
      const risk = String(alert.riskcode);
      if (!['0', '1', '2', '3'].includes(risk)) throw new Error(`${role}: Ungültiger Schweregrad.`);
      if (Number(risk) >= 2) throw new Error(`${role}: ZAP-Befund mit Schweregrad Mittel/Hoch (Regel ${alert.pluginid}).`);
      if (risk === '1') warnings++;
    }
  }
  return `${role}: Aktiver Scan vollständig; ${warnings} niedrige Befundarten zur Prüfung.`;
}

if (require.main === module) {
  try {
    const directory = process.argv[2];
    if (!directory) throw new Error('ZAP-Berichtverzeichnis fehlt.');
    for (const role of ['anonymous', 'buyer']) {
      const json = (file) => JSON.parse(fs.readFileSync(path.join(directory, role, file), 'utf8'));
      const exitText = fs.readFileSync(path.join(directory, `${role}.exit`), 'utf8').trim();
      const exit = /^\d+$/.test(exitText) ? Number(exitText) : NaN;
      console.log(checkRole(json('report.json'), json('coverage.json'), exit, role));
    }
  } catch (err) { console.error(`DAST-Prüfung fehlgeschlagen: ${err.message}`); process.exitCode = 1; }
}
module.exports = { checkRole };
