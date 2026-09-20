// Renders the "File health" drawer: one column per video, rows grouped by topic, severity dots,
// a "≠" marker where the files differ, plus a per-file summary and the on-demand deep scan.
// Everything is built with textContent (file names and values are untrusted strings).

const GROUP_ORDER = ['Stream', 'Timing', 'Structure', 'Audio', 'Content'];
const letter = i => String.fromCharCode(65 + i);

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

export function tally(rows) {
  let bad = 0, warn = 0;
  for (const r of rows) { if (r.severity === 'bad') bad++; else if (r.severity === 'warn') warn++; }
  return { bad, warn };
}

/**
 * @param {HTMLElement} root
 * @param {{clips: object[], onDeepScan: (i:number)=>void, onDeepScanAll: ()=>void}} o
 */
export function renderHealth(root, { clips, onDeepScan, onDeepScanAll }) {
  root.replaceChildren();
  if (!clips.length) { root.append(el('div', 'hp-note', 'Open a video to see its diagnostics.')); return; }

  const head = el('div', 'hp-head');
  head.append(el('h2', null, 'File health'));
  const files = el('div', 'hp-files');
  clips.forEach((c, i) => {
    const t = tally(c.health);
    const row = el('div', 'hp-file');
    const badge = el('span', 'badge', letter(i)); badge.style.background = `var(--c${i % 6})`;
    row.append(badge, el('span', 'nm', c.name));
    const tl = el('span', 'tally');
    tl.append(t.bad ? Object.assign(el('b', 'bad'), { textContent: `${t.bad} problem${t.bad > 1 ? 's' : ''}` }) : 'no problems');
    if (t.warn) tl.append(`, ${t.warn} warning${t.warn > 1 ? 's' : ''}`);
    row.append(tl);
    files.append(row);
  });
  head.append(files);
  root.append(head);

  // Findings: what is actually wrong, per file, before the wall of numbers.
  const findings = el('div', 'hp-note');
  const note = (sev, text) => { const n = el('div', 'note ' + sev); n.append(el('span', 'dot'), el('span', null, text)); return n; };
  clips.forEach((c, i) => {
    const problems = c.health.filter(r => r.severity === 'bad' || r.severity === 'warn');
    for (const r of problems) findings.append(note(r.severity, `${letter(i)} · ${r.label}: ${r.value}${r.detail ? ' — ' + r.detail : ''}`));
  });
  if (!findings.childNodes.length) findings.append(note('ok', 'No timing, structure or audio problems found in any file.'));
  root.append(findings);

  // Table
  const groups = new Map(GROUP_ORDER.map(g => [g, []]));
  const seen = new Set();
  clips.forEach(c => c.health.forEach(r => {
    const key = r.group + '|' + r.id;
    if (seen.has(key)) return;
    seen.add(key);
    if (!groups.has(r.group)) groups.set(r.group, []);
    groups.get(r.group).push({ id: r.id, label: r.label });
  }));

  const table = el('table', 'hp');
  const thead = el('thead'); const hr = el('tr'); hr.append(el('th', null, ''));
  clips.forEach((c, i) => { const th = el('th'); const b = el('span', 'badge hb', letter(i)); b.style.background = `var(--c${i % 6})`; th.append(b); hr.append(th); });
  thead.append(hr); table.append(thead);
  const tbody = el('tbody');
  for (const [group, rows] of groups) {
    if (!rows.length) continue;
    const gr = el('tr'); const gh = el('th', 'grp', group); gh.colSpan = clips.length + 1; gr.append(gh); tbody.append(gr);
    for (const { id, label } of rows) {
      const cells = clips.map(c => c.health.find(r => r.id === id));
      const vals = cells.map(r => (r ? r.value : ''));
      const differs = clips.length > 1 && new Set(vals).size > 1;
      const tr = el('tr', differs ? 'differs' : '');
      tr.append(el('td', 'lbl', label));
      cells.forEach(r => {
        const td = el('td', 'v');
        if (r) { td.append(el('span', 'sev ' + r.severity), document.createTextNode(r.value)); if (r.detail) td.title = r.detail; }
        else td.textContent = '—';
        tr.append(td);
      });
      tbody.append(tr);
    }
  }
  table.append(tbody);
  root.append(table);

  // Deep scan
  const actions = el('div', 'hp-actions');
  const scanNote = el('div', 'hp-note', 'Deep scan decodes each file to find repeated/frozen frames, which timestamps cannot reveal. Static shots are not judged.');
  clips.forEach((c, i) => {
    const b = el('button', 'btn small');
    if (c.deep === 'running') { b.textContent = `Scanning ${letter(i)}… ${Math.round((c.deepPct || 0) * 100)}%`; b.disabled = true; }
    else if (c.deep === 'done') { b.textContent = `Rescan ${letter(i)}`; b.addEventListener('click', () => onDeepScan(i)); }
    else { b.textContent = `Deep scan ${letter(i)}`; b.addEventListener('click', () => onDeepScan(i)); }
    actions.append(b);
  });
  if (clips.length > 1) { const all = el('button', 'btn small', 'Scan all'); all.addEventListener('click', onDeepScanAll); actions.append(all); }
  root.append(actions, scanNote);
}
