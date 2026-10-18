// The share frame's label, in the app's language (passed as ?lang=).
'use strict';
if (new URLSearchParams(location.search).get('lang') === 'fr') {
  document.getElementById('tag').textContent = 'Partage de cet écran · toi seul vois ce cadre';
}
