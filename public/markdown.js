'use strict';
/* global marked, esc */
// Lokal ausgelieferter Parser; nur Textformatierung, keine aktiven HTML-Inhalte oder Bilder.
const markdownParser = new marked.Marked({
  gfm: true,
  breaks: true, // Bestehende Klartexte behalten ihre Zeilenumbrüche.
  renderer: {
    html({ text }) { return esc(text); },
    image({ text }) { return esc(text); },
    link({ href, title, tokens }) {
      const label = this.parser.parseInline(tokens);
      // Explizite Protokoll-Whitelist, auch für Autolinks und Referenzlinks.
      if (!/^(?:https?:\/\/|mailto:|#)/i.test(href) || /[\x00-\x20\x7f]/.test(href)) return label;
      return `<a href="${esc(href)}"${title ? ` title="${esc(title)}"` : ''} target="_blank" rel="noopener noreferrer">${label}</a>`;
    },
  },
});

// Zweite Schutzschicht am fertigen HTML: Text ist bereits maskiert, übrig bleiben nur Tags des Renderers.
// Alles, was nicht exakt einem erwarteten Tag entspricht, wird wieder zu Text – auch bei künftigen Parser-Änderungen.
const MARKDOWN_TAGS = [
  /^<\/?(?:p|strong|em|del|code|pre|h[1-6]|ul|ol|li|blockquote|table|thead|tbody|tr|th|td)>$/,
  /^<(?:br|hr)>$/,
  /^<(?:th|td) align="(?:left|center|right)">$/,
  /^<ol start="\d{1,9}">$/,
  /^<code class="language-[\w+#.-]{1,40}">$/,
  /^<input (?:checked="" )?disabled="" type="checkbox">$/,
  /^<a href="(?:https?:\/\/|mailto:|#)[^"\s]*"(?: title="[^"]*")? target="_blank" rel="noopener noreferrer">$/i,
  /^<\/a>$/,
];
function sanitizeMarkdownHtml(html) {
  return html.replace(/<[^>]*>?/g, (tag) => (MARKDOWN_TAGS.some((re) => re.test(tag)) ? tag : esc(tag)));
}

function markdown(text) {
  return sanitizeMarkdownHtml(markdownParser.parse(String(text ?? '')));
}

function markdownHelp(id) {
  return `<details class="markdown-help" data-markdown-for="${esc(id)}"><summary>Markdown-Hilfe &amp; Vorschau</summary>
    <p class="hint"><code>**fett**</code> · <code>*kursiv*</code> · <code>~~durchgestrichen~~</code> · <code>[Link](https://…)</code><br>
    <code>## Überschrift</code> · <code>- Listenpunkt</code> · <code>1. Nummerierung</code> · <code>&gt; Zitat</code> · <code>\u0060Code\u0060</code><br>
    Tabellen und Codeblöcke (drei Backticks) sind möglich. HTML und Bilder werden nicht eingebunden.</p>
    <div class="markdown markdown-preview" aria-label="Markdown-Vorschau"></div></details>`;
}

function updateMarkdownPreview(details) {
  if (!details.open) return;
  const input = document.getElementById(details.dataset.markdownFor);
  if (input) details.querySelector('.markdown-preview').innerHTML = markdown(input.value);
}

// Delegation funktioniert auch für nachträglich hinzugefügte Listen-/Sponsorenfelder.
document.addEventListener('toggle', (event) => {
  if (event.target.matches?.('[data-markdown-for]')) updateMarkdownPreview(event.target);
}, true);
document.addEventListener('input', (event) => {
  if (!event.target.id) return;
  document.querySelectorAll('[data-markdown-for]').forEach((details) => {
    if (details.dataset.markdownFor === event.target.id) updateMarkdownPreview(details);
  });
});
