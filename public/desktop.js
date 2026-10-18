// Desktop-app extras: screen picker, update banner, version info.
// Does nothing when Miserecord runs in a normal browser.
'use strict';

(() => {
  const desk = window.miserecordDesktop;
  if (!desk) return;
  document.documentElement.classList.add('desktop');
  Log.info('app', 'running as desktop app');

  // ---------------------------------------------------------------- screen picker
  let request = null;
  let selected = null;
  let kind = 'screen';

  desk.onPickSource((req) => {
    request = req;
    selected = null;
    kind = 'screen';
    Log.info('media', 'screen picker opened', { screens: req.sources.filter((s) => s.kind === 'screen').length, windows: req.sources.filter((s) => s.kind === 'window').length });
    $('#pickerAudioRow').hidden = !req.canShareAudio;
    renderPicker();
    $('#picker').hidden = false;
  });

  function renderPicker() {
    for (const tab of document.querySelectorAll('#pickerTabs button')) tab.classList.toggle('active', tab.dataset.kind === kind);
    const grid = $('#pickerGrid');
    grid.textContent = '';
    const list = request.sources.filter((s) => s.kind === kind);
    if (!list.length) {
      const p = document.createElement('p');
      p.className = 'picker-empty';
      p.textContent = kind === 'screen' ? 'No screens found.' : 'No open windows found.';
      grid.append(p);
    }
    for (const s of list) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = `source${selected === s.id ? ' selected' : ''}`;
      const thumb = document.createElement('img');
      thumb.className = 'thumb';
      thumb.alt = '';
      if (s.thumbnail) thumb.src = s.thumbnail;
      const name = document.createElement('div');
      name.className = 'src-name';
      if (s.icon) {
        const icon = document.createElement('img');
        icon.src = s.icon;
        icon.alt = '';
        name.append(icon);
      }
      const label = document.createElement('span');
      label.textContent = s.kind === 'screen' && list.length === 1 ? 'Entire screen' : s.name;
      name.append(label);
      btn.append(thumb, name);
      btn.onclick = () => { selected = s.id; renderPicker(); };
      btn.ondblclick = () => { selected = s.id; finish(true); };
      grid.append(btn);
    }
    $('#pickerShare').disabled = !selected;
  }

  function finish(share) {
    if (!request) return;
    const req = request;
    request = null;
    $('#picker').hidden = true;
    const audio = $('#pickerAudio').checked && !$('#pickerAudioRow').hidden;
    Log.info('media', share && selected ? 'screen picked' : 'screen picker cancelled', share && selected ? { kind, audio } : undefined);
    desk.pickSource(req.id, share ? selected : null, audio);
  }

  for (const tab of document.querySelectorAll('#pickerTabs button')) {
    tab.onclick = () => { kind = tab.dataset.kind; selected = null; renderPicker(); };
  }
  $('#pickerShare').onclick = () => finish(true);
  $('#pickerCancel').onclick = () => finish(false);
  $('#pickerClose').onclick = () => finish(false);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('#picker').hidden) finish(false); });

  // ---------------------------------------------------------------- updates & version
  $('#sAbout').hidden = false;
  desk.info().then(({ version, packaged }) => {
    $('#sVersion').textContent = packaged ? version : `${version} (development)`;
    if (!packaged) {
      $('#sUpdateText').textContent = 'Updates work in the installed app';
      $('#sUpdateCheck').disabled = true;
    }
    Log.info('app', 'desktop version', { version, packaged });
  });
  $('#sUpdateCheck').onclick = () => desk.checkForUpdates();
  $('#updateRestart').onclick = () => {
    // Don't cut off a call: ask first if one is running.
    if (state.pc && !confirm('Restarting ends your current call. Restart now?')) return;
    desk.installUpdate();
  };

  desk.onUpdateStatus((u) => {
    const text = {
      checking: 'Checking for updates',
      current: 'You have the latest version',
      downloading: u.percent != null ? `Downloading update, ${u.percent}%` : `Downloading version ${u.version || ''}`.trim(),
      ready: `Version ${u.version} is ready`,
      error: "Couldn't check for updates",
    }[u.status];
    if (text) $('#sUpdateText').textContent = text;
    if (u.status !== 'downloading' || u.percent == null) Log.info('app', `update ${u.status}`, u.version || u.message || undefined);
    if (u.status === 'ready') {
      $('#updateText').textContent = `Version ${u.version} is ready`;
      $('#updateBar').hidden = false;
    }
  });
})();
