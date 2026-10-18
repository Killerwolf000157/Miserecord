// Apply a saved theme before first paint so there's no flash.
try { const t = localStorage.getItem('miserecord.theme'); if (t) document.documentElement.dataset.theme = t; } catch { /* storage off */ }
// The desktop app on Windows draws its own top bar under the window buttons.
if (window.miserecordDesktop && window.miserecordDesktop.ownTitleBar) document.documentElement.classList.add('own-titlebar');
