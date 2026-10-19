// Desktop-app extras: screen picker, update banner, version info.
// Does nothing when Miserecord runs in a normal browser.
'use strict';

(() => {
  const desk = window.miserecordDesktop;
  if (!desk) return;
  document.documentElement.classList.add('desktop');
  Log.info('app', 'running as desktop app');
  if (desk.setHideFromShare) desk.setHideFromShare(settings.hideFromShare);

  // ---------------------------------------------------------------- window buttons
  // Minimize, maximize and close follow the app's light or dark theme.
  if (desk.ownTitleBar) {
    const dark = matchMedia('(prefers-color-scheme: dark)');
    const sync = () => {
      const t = document.documentElement.dataset.theme;
      desk.setTitleBarTheme(t ? t === 'dark' : dark.matches);
    };
    sync();
    dark.addEventListener('change', sync);
    new MutationObserver(sync).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  }

  // ---------------------------------------------------------------- screen picker
  let request = null;
  let selected = null;
  let kind = 'screen';

  desk.onPickSource((req) => {
    request = req;
    selected = null;
    kind = 'screen';
    $('#pickerAudioRow').hidden = !req.canShareAudio;
    renderPicker();
    $('#picker').hidden = false;
  });

  desk.onPickSources((update) => {
    if (!request || request.id !== update.id) return;
    const first = !request.sources;
    request.sources = update.sources;
    if (update.failed) {
      toast("Couldn't list your screens and windows.", 'err');
      request = null;
      $('#picker').hidden = true;
      state.pickerCancelled = true;
      return;
    }
    if (first) {
      Log.info('media', 'screen picker opened', { screens: update.sources.filter((s) => s.kind === 'screen').length, windows: update.sources.filter((s) => s.kind === 'window').length });
      // With one screen there's nothing to choose: it's ready to share.
      const screens = update.sources.filter((s) => s.kind === 'screen');
      if (screens.length === 1 && !selected) selected = screens[0].id;
    }
    if (selected && !request.sources.some((s) => s.id === selected)) selected = null;
    renderPicker();
  });

  function renderPicker() {
    for (const tab of document.querySelectorAll('#pickerTabs button')) tab.classList.toggle('active', tab.dataset.kind === kind);
    const grid = $('#pickerGrid');
    grid.textContent = '';
    if (!request.sources) {
      // Placeholders until Windows has listed the screens and windows.
      for (let i = 0; i < (kind === 'screen' ? 1 : 4); i++) {
        const ph = document.createElement('div');
        ph.className = 'source loading';
        ph.innerHTML = '<div class="thumb"></div><div class="src-name"><span></span></div>';
        grid.append(ph);
      }
      $('#pickerShare').disabled = true;
      return;
    }
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
      else thumb.classList.add('pending');
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
      if (label.textContent === s.name) label.setAttribute('translate', 'no');
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
    // Cancelling makes the page see a generic abort; mark it so no error shows.
    if (!(share && selected)) state.pickerCancelled = true;
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
    APP_VERSION = String(version || APP_VERSION);
  });
  $('#sUpdateCheck').onclick = () => desk.checkForUpdates();
  $('#sUninstall').onclick = () => {
    $('#uninstallDelete').checked = false;
    $('#uninstallCallNote').hidden = !state.mode;
    syncUninstallNote();
    $('#uninstallSheet').hidden = false;
  };
  const syncUninstallNote = () => {
    $('#uninstallDataNote').textContent = $('#uninstallDelete').checked
      ? 'Your saved friends, settings and logs will be erased. To call your friends again, you would swap codes again.'
      : 'Your friends and settings stay on this computer, so they come back if you reinstall.';
  };
  $('#uninstallDelete').onchange = syncUninstallNote;
  $('#uninstallCancel').onclick = () => { $('#uninstallSheet').hidden = true; };
  $('#uninstallGo').onclick = async () => {
    const deleteData = $('#uninstallDelete').checked;
    $('#uninstallSheet').hidden = true;
    if (state.mode) leave();
    Log.info('app', 'uninstall requested', { deleteData });
    const res = await desk.uninstall(deleteData);
    if (!res.ok) toast(res.reason, 'err');
  };
  $('#updateRestart').onclick = () => {
    // Don't cut off a call: ask first if one is running.
    if (isConnected() && !confirm(I18n.t('Restarting ends your current call. Restart now?'))) return;
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
