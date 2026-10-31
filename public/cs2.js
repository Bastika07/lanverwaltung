'use strict';
/* global api, esc, toast, adminViews, adminTabs, render */
// CS2-Matches über TMT2 (Fork von JensForstmann/tmt2): Matches für Turnierpaarungen anlegen, Stand verfolgen,
// Ergebnisse in den Turnierbaum übernehmen. Nur im Admin-Bereich; TMT2 selbst läuft als eigener Container.

const CS2_STATES = { ELECTION: 'Mapwahl', MATCH_MAP: 'läuft', FINISHED: 'beendet', STOPPED: 'abgebrochen' };
const CS2_FORMATS = [['bo1', 'Best of 1'], ['bo3', 'Best of 3'], ['bo5', 'Best of 5']];

function cs2Maps(m) {
  if (!m.maps.length) return '<span class="meta">Maps noch offen</span>';
  return m.maps.map((x) => `<span class="nowrap">${esc(x.name || '?')} <strong>${x.a}:${x.b}</strong>${x.done ? '' : ' …'}</span>`).join(' · ');
}

adminViews.cs2 = {
  label: 'CS2-Matches', module: 'cs2', order: 47, events: ['cs2', 'tournament'],
  async render() {
    const d = await api('GET', '/cs2');
    const formats = CS2_FORMATS.map(([k, l]) => `<option value="${k}">${l}</option>`).join('');
    const app = document.getElementById('app');
    app.innerHTML = `${adminTabs('cs2')}
      ${d.configured ? '' : `<div class="card hint-card"><h2>TMT2 ist nicht eingerichtet</h2>
        <p>Starte den TMT2-Container und setze <code>TMT2_URL</code> und <code>TMT2_TOKEN</code> (siehe README, Abschnitt „CS2-Matches (TMT2)“).</p></div>`}
      <div class="two">
        <form id="cs2New" class="card"><h2>Neues Match <span class="meta">${esc(d.event.name)}</span></h2>
          <div class="field"><label for="cs2Pair">Turnierpaarung</label><select id="cs2Pair">
            ${d.candidates.map((c, i) => `<option value="${i}">${esc(c.tournament)} · ${esc(c.label)}: ${esc(c.teamA)} vs ${esc(c.teamB)}</option>`).join('')}
            <option value="free">Freies Match (Teamnamen eingeben)</option></select></div>
          <div class="row two-inputs" id="cs2Free" hidden>
            <div class="field"><label for="cs2A">Team A</label><input id="cs2A" maxlength="60"></div>
            <div class="field"><label for="cs2B">Team B</label><input id="cs2B" maxlength="60"></div>
          </div>
          <div class="field"><label for="cs2Format">Format</label><select id="cs2Format" style="max-width:200px">${formats}</select></div>
          <p class="error" id="cs2Error"></p>
          <button class="primary" type="submit" ${d.configured ? '' : 'disabled'}>In TMT2 anlegen</button>
          <p class="hint">TMT2 nimmt einen freien Server aus seiner Gameserver-Verwaltung. Die Spieler wählen ingame mit <code>.team a</code> bzw. <code>.team b</code> ihr Team und bannen und picken die Maps.
            ${d.webhook ? 'Das Endergebnis kommt automatisch in den Turnierbaum.' : 'Ohne <code>TMT2_WEBHOOK_URL</code> holst du den Stand mit „Abgleichen“.'}</p>
          ${d.publicUrl ? `<p><a class="btn" href="${esc(d.publicUrl)}" target="_blank" rel="noopener">TMT2 öffnen ↗</a></p>` : ''}
        </form>
        <form id="cs2Pool" class="card"><h2>Mappool</h2>
          <div class="field"><label for="cs2Maps">Eine Map pro Zeile</label><textarea id="cs2Maps" class="short" rows="8">${esc(d.mapPool.join('\n'))}</textarea>
            <p class="hint">z. B. <code>de_mirage</code>; Workshop-Maps als <code>3070923343/fy_pool_day</code>. BO1 bannt bis auf eine Map, BO3/BO5 bannen zwei, picken abwechselnd und spielen die letzte Map als Entscheidung.</p></div>
          <p class="error" id="cs2PoolError"></p>
          <button type="submit">Speichern</button>
        </form>
      </div>
      <div class="card"><h2>Matches (${d.matches.length})</h2>
        ${d.matches.length ? `<div style="overflow-x:auto"><table class="admin-list"><tbody>${d.matches.map((m) => `<tr class="${m.state === 'STOPPED' ? 'past' : ''}">
          <td><strong>${esc(m.teamA)}</strong> vs <strong>${esc(m.teamB)}</strong>
            <div class="meta">${m.tournament ? `${esc(m.tournament.name)} · ${esc(m.label)} · ` : ''}${esc(m.format.toUpperCase())}</div></td>
          <td>${cs2Maps(m)}<div class="meta">Maps ${m.wonA}:${m.wonB}</div></td>
          <td><span class="badge">${esc(CS2_STATES[m.state] || m.state)}</span>
            ${m.reported ? '<div class="meta">✅ im Turnier eingetragen</div>' : ''}${m.note ? `<div class="meta"><strong>${esc(m.note)}</strong></div>` : ''}</td>
          <td><div class="row">${m.link ? `<a class="btn small" href="${esc(m.link)}" target="_blank" rel="noopener">TMT2 ↗</a>` : ''}
            <button class="small" data-cs2sync="${esc(m.id)}">Abgleichen</button>
            <button class="small danger" data-cs2del="${esc(m.id)}" title="In TMT2 beenden und entfernen">🗑</button></div></td></tr>`).join('')}</tbody></table></div>`
    : '<p class="meta">Noch keine Matches.</p>'}
      </div>`;

    const pair = document.getElementById('cs2Pair');
    const free = () => { document.getElementById('cs2Free').hidden = pair.value !== 'free'; };
    pair.onchange = free; free();
    document.getElementById('cs2New').onsubmit = async (e) => {
      e.preventDefault();
      const c = d.candidates[Number(pair.value)];
      const body = { format: document.getElementById('cs2Format').value,
        ...(pair.value === 'free' ? { teamA: document.getElementById('cs2A').value, teamB: document.getElementById('cs2B').value } : { tournamentId: c.tournamentId, matchId: c.matchId }) };
      try { await api('POST', '/cs2/matches', body); toast('Match in TMT2 angelegt'); render(); }
      catch (err) { document.getElementById('cs2Error').textContent = err.message; }
    };
    document.getElementById('cs2Pool').onsubmit = async (e) => {
      e.preventDefault();
      try { await api('PUT', '/cs2/config', { mapPool: document.getElementById('cs2Maps').value.split('\n').map((s) => s.trim()).filter(Boolean) }); toast('Gespeichert'); render(); }
      catch (err) { document.getElementById('cs2PoolError').textContent = err.message; }
    };
    app.querySelectorAll('button[data-cs2sync]').forEach((b) => {
      b.onclick = async () => { try { await api('POST', `/cs2/matches/${b.dataset.cs2sync}/sync`); render(); } catch (err) { toast(err.message); } };
    });
    app.querySelectorAll('button[data-cs2del]').forEach((b) => {
      b.onclick = async () => {
        if (!confirm('Match in TMT2 beenden und hier entfernen? Ein schon übernommenes Ergebnis bleibt im Turnier.')) return;
        try { await api('DELETE', '/cs2/matches/' + b.dataset.cs2del); render(); } catch (err) { toast(err.message); }
      };
    });
  },
};
