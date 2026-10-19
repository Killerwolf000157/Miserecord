// The in-game overlay's page: draws the people in the call from what the main
// window sends (social.js Overlay), through overlay-preload.js.
'use strict';

const list = document.getElementById('list');
const MIC = '<svg class="i mic" viewBox="0 0 24 24"><path d="M9 5a3 3 0 0 1 6 0v6a3 3 0 0 1-6 0zM5 11a7 7 0 0 0 14 0M12 18v3M4 4l16 16"/></svg>';
const EAR = '<svg class="i ear" viewBox="0 0 24 24"><path d="M4 14v-2a8 8 0 0 1 16 0v2M4 14h3v6H4zM17 14h3v6h-3zM4 4l16 16"/></svg>';

window.overlay.onData((data) => {
  if (!data) { list.textContent = ''; return; }
  document.body.classList.toggle('right', String(data.corner).endsWith('right'));
  list.textContent = '';
  for (const p of data.people || []) {
    const row = document.createElement('div');
    row.className = `p${p.speaking ? ' speaking' : ''}${p.muted ? ' muted' : ''}${p.deafened ? ' deafened' : ''}`;
    const a = document.createElement('div');
    a.className = 'a';
    a.textContent = String(p.name || '?').trim().charAt(0).toUpperCase();
    const n = document.createElement('div');
    n.className = 'n';
    n.textContent = String(p.name || '');
    row.append(a, n);
    row.insertAdjacentHTML('beforeend', MIC + EAR);
    list.append(row);
  }
});
