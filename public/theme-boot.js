// Apply a saved theme before first paint so there's no flash.
try { const t = localStorage.getItem('miserecord.theme'); if (t) document.documentElement.dataset.theme = t; } catch { /* storage off */ }
