'use strict';
// Slash-Befehle für Discord. Antworten sind (bis auf Durchsagen) nur für den Aufrufer sichtbar.

const Bracket = require('../public/bracket.js');

const STR = 3;
const BOOL = 5;
const opt = (name, description, extra = {}) => ({ type: STR, name, description, ...extra });

module.exports = function commands(ctx) {
  const { Discord, settings, announcements, people, schedule } = ctx;
  // Discord-Befehle gelten immer dem aktuellen Event (nie dem, das ein Admin gerade bearbeitet)
  const tournaments = () => ctx.tournaments.of(ctx.event.current());

  // ---------- Berechtigung für Durchsagen ----------
  let roleCache = { at: 0, roles: [] };
  async function mayAnnounce(member) {
    const perms = BigInt(member.permissions || '0');
    if ((perms & 0x8n) || (perms & 0x20n)) return true; // Administrator / Server verwalten
    const roleName = settings().announceRole;
    if (!roleName) return true; // keine Einschränkung eingestellt
    if (Date.now() - roleCache.at > 60000) roleCache = { at: Date.now(), roles: await Discord.call('GET', `/guilds/${Discord.GUILD}/roles`) };
    const role = roleCache.roles.find((r) => r.name.toLowerCase() === roleName.toLowerCase());
    return !!role && member.roles.includes(role.id);
  }

  // Person zum Discord-Konto; legt sie bei Bedarf mit dem Discord-Namen an.
  // create: auch am aktuellen Event teilnehmen lassen (z. B. bei /anmelden)
  function personFor(user, create) {
    const linked = people.byDiscord(user.id, create);
    if (linked || !create) return linked || null;
    return people.selfLink(user, user.name);
  }

  const filterBy = (list, focused) => {
    const q = String((focused && focused.value) || '').toLowerCase();
    return list.filter((x) => x.name.toLowerCase().includes(q));
  };
  const inTournament = (t, name) => t.participants.some((n) => n.toLowerCase() === name.toLowerCase());
  // Eigener Eintrag nur über die gebundene Personen-ID, nie über den (beanspruchbaren) Anzeigenamen.
  const ownEntry = (t, person) => t.participants.find((n) => Object.hasOwn(t.playerIds || {}, n) && t.playerIds[n] === person.id);

  // ---------- Teams (nur lesend, für Auswahllisten und Texte; ändern nur über das Turniermodul) ----------
  const isTeam = (t) => (t.teamSize || 1) > 1;
  // Teamnamen sind frei wählbar (auch „__proto__“): nur eigene Einträge lesen.
  const teamIds = (t, team) => (t.members && Object.hasOwn(t.members, team) ? t.members[team] : []);
  const teamOf = (t, person) => Object.keys(t.members || {}).find((team) => teamIds(t, team).includes(person.id)) || null;
  const freeTeams = (t) => t.participants.filter((team) => teamIds(t, team).length < t.teamSize);
  const teamLine = (t, team) => `**${Discord.md(team)}** (${teamIds(t, team).length}/${t.teamSize})`;
  // ---------- Anmeldeschluss, Teilnehmerlimit, Coins (geprüft im Turniermodul) ----------
  const full = (t) => !!t.maxParticipants && t.participants.length >= t.maxParticipants;
  const costLabel = (t) => (tournaments().coins(null).budget && t.coins ? `, ${t.coins} 🪙` : '');
  const coinsLeftText = (person) => { const c = tournaments().coins(person); return c.budget ? ` Noch ${c.left} von ${c.budget} 🪙.` : ''; };
  // Ablehnungen des Turniermoduls (err.code) als Discord-Text; own: eigene Texte je Code für einzelne Befehle
  function said(t, run, own = {}) {
    try { return run(); } catch (err) {
      const d = err.data || {};
      const texts = {
        closed: 'Für dieses Turnier ist die Anmeldung nicht (mehr) offen.',
        'closed-leave': 'Abmelden geht nur, solange die Anmeldung offen ist. Bitte bei der Orga melden.',
        'team-tournament': `**${Discord.md(t.name)}** ist ein Teamturnier – nutze /team gruenden oder /team beitreten.`,
        'single-tournament': `**${Discord.md(t.name)}** ist kein Teamturnier – nutze /anmelden.`,
        'no-person': 'Verknüpfe dich zuerst mit /ich und deinem Namen.',
        full: `**${Discord.md(t.name)}** ist voll (${d.max} ${isTeam(t) ? 'Teams' : 'Plätze'}).`,
        coins: `Dafür fehlen dir Coins: **${Discord.md(t.name)}** kostet ${d.cost} 🪙, du hast noch ${d.left} von ${d.budget}. Mit /coins siehst du, wofür du angemeldet bist.`,
        'in-team': d.team && `Du bist schon im Team ${teamLine(t, d.team)}. Erst /team verlassen.`,
        'team-exists': `Das Team „${d.name}“ gibt es schon – mit /team beitreten kannst du beitreten.`,
        'no-team': 'Dieses Team gibt es nicht.',
        'team-full': d.team && `Das Team ${teamLine(t, d.team)} ist schon voll.`,
      };
      const text = own[err.code] ? own[err.code](d) : texts[err.code];
      if (err.code && text) throw new Error(text);
      throw err;
    }
  }

  const findOpen = (value) => {
    const t = tournaments().openForSignup().find((x) => x.id === value || x.name.toLowerCase() === String(value).toLowerCase());
    if (!t) throw new Error('Für dieses Turnier ist die Anmeldung nicht (mehr) offen.');
    return t;
  };

  const defs = [
    {
      module: 'announcements',
      name: 'announce', description: 'Durchsage: Lampe, Beamer, Webseite und Discord',
      options: [opt('nachricht', 'Text der Durchsage', { required: true, max_length: 300 }),
        { type: BOOL, name: 'vorlesen', description: 'In Discord und auf dem Beamer vorlesen (ohne Angabe: Einstellung)' }],
      async run(c) {
        if (!(await mayAnnounce(c.member))) throw new Error(`Dafür brauchst du die Rolle „${settings().announceRole}“.`);
        const a = announcements.create({ text: c.opts.nachricht, by: c.user.name, source: 'discord', speak: c.opts.vorlesen });
        return a.until ? `📢 Durchsage läuft (${Math.round((Date.parse(a.until) - Date.parse(a.at)) / 1000)} s).` : '📢 Durchsage läuft – beenden mit /announce_ende.';
      },
    },
    {
      module: 'announcements',
      name: 'announce_ende', description: 'Laufende Durchsage beenden (Lampe aus)',
      async run(c) {
        if (!(await mayAnnounce(c.member))) throw new Error(`Dafür brauchst du die Rolle „${settings().announceRole}“.`);
        return announcements.end() ? '🟢 Durchsage beendet.' : 'Es läuft gerade keine Durchsage.';
      },
    },
    {
      module: 'people',
      name: 'ich', description: 'Dein Discord-Konto mit deinem Namen auf der LAN verknüpfen',
      options: [opt('name', 'Dein Name in der Teilnehmerliste', { required: true, autocomplete: true, max_length: 60 }),
        opt('ticketcode', 'Ticketcode als Nachweis für eine bestehende Person', { max_length: 64 })],
      autocomplete: (c) => filterBy(people.list().filter((p) => p.discordId === c.user.id), c.focused)
        .map((p) => ({ name: p.name, value: p.name })),
      run(c) {
        const name = String(c.opts.name).trim();
        const p = people.selfLink(c.user, name, c.opts.ticketcode);
        return `✅ Du bist jetzt **${Discord.md(p.name)}**. Geschützte Teilnehmerrechte brauchen ein gültiges Ticket oder eine Bestätigung der Orga.`;
      },
    },
    {
      module: 'people',
      name: 'clan', description: 'Deinen Clan bzw. dein Team setzen (erscheint im Sitzplan)',
      options: [opt('name', 'Name des Clans – leer lassen zum Entfernen', { max_length: 40 })],
      run(c) {
        const p = people.personByDiscord(c.user.id); // global – ohne dabei am Event teilzunehmen
        if (!p) throw new Error('Verknüpfe dich zuerst mit /ich und deinem Namen.');
        const clan = String(c.opts.name || '').trim();
        people.setClan(p.id, clan);
        return clan ? `✅ Clan von **${Discord.md(p.name)}**: **${Discord.md(clan)}**` : `✅ Clan von **${Discord.md(p.name)}** entfernt.`;
      },
    },
    {
      module: 'tournaments',
      name: 'anmelden', description: 'Für ein Turnier anmelden',
      options: [opt('turnier', 'Turnier mit offener Anmeldung', { required: true, autocomplete: true })],
      autocomplete(c) {
        const me = personFor(c.user, false);
        return filterBy(tournaments().openForSignup().filter((t) => !isTeam(t) && (!me || !inTournament(t, me.name))), c.focused)
          .map((t) => ({ name: `${t.name} (${t.participants.length}${t.maxParticipants ? '/' + t.maxParticipants : ''} angemeldet${full(t) ? ', voll' : ''}${costLabel(t)})`, value: t.id }));
      },
      run(c) {
        const t = findOpen(c.opts.turnier);
        const { person: p, already } = said(t, () => tournaments().join({ discordId: c.user.id, person: () => personFor(c.user, true) }, t));
        if (already) return `Du bist bei **${Discord.md(t.name)}** schon angemeldet.`;
        return `✅ Angemeldet bei **${Discord.md(t.name)}** als **${Discord.md(p.name)}** (${t.participants.length} Teilnehmer).${t.coins ? coinsLeftText(p) : ''}`;
      },
    },
    {
      module: 'tournaments',
      name: 'abmelden', description: 'Von einem Turnier abmelden (solange es noch nicht gestartet ist)',
      options: [opt('turnier', 'Turnier', { required: true, autocomplete: true })],
      autocomplete(c) {
        const me = personFor(c.user, false);
        if (!me) return [];
        return filterBy(tournaments().openForSignup().filter((t) => !isTeam(t) && ownEntry(t, me)), c.focused).map((t) => ({ name: t.name, value: t.id }));
      },
      run(c) {
        const t = tournaments().openForSignup().find((x) => x.id === c.opts.turnier);
        if (!t) throw new Error('Abmelden geht nur, solange die Anmeldung offen ist. Bitte bei der Orga melden.');
        const { notSignedUp } = said(t, () => tournaments().leave({ discordId: c.user.id, person: () => personFor(c.user, false) }, t));
        if (notSignedUp) return `Du bist bei **${Discord.md(t.name)}** nicht angemeldet. Wurdest du von der Orga eingetragen, melde dich bitte dort ab.`;
        return `👋 Abgemeldet von **${Discord.md(t.name)}**.`;
      },
    },
    {
      module: 'tournaments',
      name: 'team', description: 'Teamturniere: Team gründen, beitreten oder verlassen',
      options: [
        { type: 1, name: 'gruenden', description: 'Neues Team anmelden (du bist Teamchef)', options: [
          opt('turnier', 'Teamturnier mit offener Anmeldung', { required: true, autocomplete: true }),
          opt('name', 'Name des Teams', { required: true, max_length: 40 }),
        ] },
        { type: 1, name: 'beitreten', description: 'Einem bestehenden Team beitreten', options: [
          opt('turnier', 'Teamturnier', { required: true, autocomplete: true }),
          opt('team', 'Team', { required: true, autocomplete: true }),
        ] },
        { type: 1, name: 'verlassen', description: 'Dein Team in einem Turnier verlassen', options: [
          opt('turnier', 'Teamturnier', { required: true, autocomplete: true }),
        ] },
      ],
      autocomplete(c) {
        const me = personFor(c.user, false);
        const open = tournaments().openForSignup().filter(isTeam);
        if (c.focused.name === 'team') {
          const t = open.find((x) => x.id === c.opts.turnier);
          return t ? filterBy(freeTeams(t).map((name) => ({ name })), c.focused).map((x) => ({ name: `${x.name} (${teamIds(t, x.name).length}/${t.teamSize})`, value: x.name })) : [];
        }
        const list = open.filter((t) => {
          const mine = me && teamOf(t, me);
          if (c.sub === 'verlassen') return !!mine;
          if (mine) return false;
          return c.sub === 'beitreten' ? freeTeams(t).length > 0 : true;
        });
        return filterBy(list, c.focused).map((t) => ({ name: `${t.name} (${t.participants.length}${t.maxParticipants ? '/' + t.maxParticipants : ''} Teams, je ${t.teamSize}${costLabel(t)})`, value: t.id }));
      },
      run(c) {
        const t = findOpen(c.opts.turnier);
        const actor = { discordId: c.user.id, person: () => personFor(c.user, true) };
        if (c.sub === 'gruenden') {
          const { person: p, team } = said(t, () => tournaments().foundTeam(actor, t, c.opts.name),
            { 'in-team': (d) => `Du bist bei **${Discord.md(t.name)}** schon im Team ${teamLine(t, d.team)}.` });
          return { content: `🛡️ **${Discord.md(p.name)}** hat das Team **${Discord.md(team)}** für **${Discord.md(t.name)}** gegründet (1/${t.teamSize}). Beitreten mit \`/team beitreten\`.`, ephemeral: false };
        }
        if (c.sub === 'beitreten') {
          const { person: p, team } = said(t, () => tournaments().joinTeam(actor, t, c.opts.team));
          return { content: `➕ **${Discord.md(p.name)}** ist Team ${teamLine(t, team)} bei **${Discord.md(t.name)}** beigetreten.`, ephemeral: false };
        }
        // verlassen
        const { team, notInTeam, emptied } = said(t, () => tournaments().leaveTeam(actor, t));
        if (notInTeam) return `Du bist bei **${Discord.md(t.name)}** in keinem Team.`;
        if (emptied) return `👋 Du hast **${Discord.md(team)}** verlassen – das Team war leer und ist abgemeldet.`;
        return `👋 Du hast **${Discord.md(team)}** verlassen.`;
      },
    },
    {
      module: 'tournaments',
      name: 'coins', description: 'Deine Turnier-Coins: wie viele du noch hast und wofür du angemeldet bist',
      run(c) {
        if (!tournaments().coins(null).budget) return 'Bei diesem Event gibt es kein Coin-System – du kannst dich für alle Turniere anmelden.';
        const { budget, left, tournaments: mine } = tournaments().coins(personFor(c.user, false));
        return `🪙 Du hast noch **${left}** von ${budget} Coins.`
          + (mine.length ? '\n' + mine.map((x) => `– ${Discord.md(x.name)}: ${x.coins} 🪙`).join('\n') : '\nDu bist noch für kein Turnier mit Coins angemeldet.')
          + '\nFreie Turniere kosten nichts. Abmelden gibt die Coins zurück, solange die Anmeldung offen ist.';
      },
    },
    {
      module: 'tickets',
      name: 'ticket', description: 'Deine Tickets und der Zahlungsstatus',
      run(c) {
        const orders = ctx.tickets.ordersOf(c.user.id);
        if (!orders.length) return '🎟️ Du hast noch keine Tickets. Bestellen kannst du auf der Webseite unter „Tickets“ (Anmeldung mit Discord).';
        return orders.map((o) => `🎟️ **${o.ref}** (${Discord.md(o.eventName)}) – ${o.tickets.map((t) => `${Discord.md(t.holder)} (${Discord.md(t.typeName)})`).join(', ')}\n`
          + (o.status === 'paid' ? '✅ bezahlt' : `⏳ offen – ${ctx.tickets.paymentText(o)}`)).join('\n\n');
      },
    },
    {
      module: 'schedule',
      name: 'programm', description: 'Die nächsten Programmpunkte',
      run() {
        const list = schedule.upcoming(6);
        if (!list.length) return 'Im Programm steht gerade nichts an.';
        return '🗓️ **Programm**\n' + list.map((e) => `${schedule.ts(e.start, 't')} (${schedule.ts(e.start, 'R')}) – **${Discord.md(e.title)}**`).join('\n');
      },
    },
    {
      module: 'tournaments',
      name: 'jetzt', description: 'Welche Turnierspiele gerade dran sind',
      run() {
        const lines = tournaments().running().flatMap((t) => Bracket.playable(tournaments().view(t))
          .map((m) => `${m.playing ? '▶️' : '⚔️'} ${Discord.md(t.name)} · ${Discord.md(m.label)}: **${Discord.md(t.participants[m.a])}** vs **${Discord.md(t.participants[m.b])}**${m.playing ? ' (läuft)' : ''}`));
        return lines.length ? lines.join('\n') : 'Gerade sind keine Turnierspiele offen.';
      },
    },
    {
      module: 'seating',
      name: 'platz', description: 'Wo sitzt jemand?',
      options: [opt('name', 'Name (leer lassen für dich selbst)', { autocomplete: true })],
      autocomplete: (c) => filterBy(people.list(), c.focused).map((p) => ({ name: p.name, value: p.name })),
      run(c) {
        const p = c.opts.name ? people.byName(c.opts.name) : personFor(c.user, false);
        if (!p) return c.opts.name ? 'Diese Person kenne ich nicht.' : 'Du bist noch nicht verknüpft – nutze /ich.';
        const seat = people.seatOf(p);
        return seat ? `💺 **${Discord.md(p.name)}** sitzt auf Platz **${Discord.md(seat.label || '?')}**.` : `**${Discord.md(p.name)}** hat noch keinen Platz.`;
      },
    },
  ];

  // Nur Befehle aktiver Module werden bei Discord registriert und ausgeführt
  const active = () => defs.filter((d) => ctx.moduleOn(d.module));
  return {
    commands: () => active().map(({ run, autocomplete, module, ...d }) => d),
    // Module nur für Teilnehmer mit Ticket: Befehl antwortet sonst mit Hinweis (/ich bleibt frei, damit man sich verknüpfen kann)
    find(name) {
      const d = active().find((x) => x.name === name);
      if (!d || d.name === 'ich') return d;
      // /platz verrät Namen und Plätze: Teilnehmerliste und Sitzplan müssen beide sichtbar sein
      const keys = d.name === 'platz' ? ['people', 'seating'] : [d.module];
      const allowed = (c) => keys.every((key) => ctx.mayViewDiscord(c.user.id, key));
      return {
        ...d,
        autocomplete: d.autocomplete && ((c) => (allowed(c) ? d.autocomplete(c) : [])),
        run: (c) => {
          if (!allowed(c)) throw new Error('Das gibt es nur für Teilnehmer mit Ticket. Verknüpfe dich mit /ich oder melde dich auf der Webseite unter „Tickets“ an.');
          return d.run(c);
        },
      };
    },
  };
};
