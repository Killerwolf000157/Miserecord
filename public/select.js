// Dropdowns in the app's own style. Windows draws the native <select> list as
// a plain system menu, so each select is given a button and a styled menu.
// The real <select> stays in the page, hidden: its value, options and
// 'change' events keep working, so the rest of the code doesn't change.
'use strict';

(() => {
  const CHECK = '<svg viewBox="0 0 24 24"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>';
  const CHEVRON = '<svg viewBox="0 0 24 24"><path d="M7 10l5 5 5-5"/></svg>';
  let open = null; // { select, button, menu, index }

  function enhance(select) {
    if (select.dataset.enhanced) return;
    select.dataset.enhanced = '1';
    select.classList.add('native-select');
    select.tabIndex = -1;
    select.setAttribute('aria-hidden', 'true');

    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'pick';
    button.setAttribute('aria-haspopup', 'listbox');
    button.setAttribute('aria-expanded', 'false');
    const labelFor = select.closest('label') && select.closest('label').querySelector('.row-label');
    if (labelFor) button.setAttribute('aria-label', labelFor.textContent.trim());
    button.innerHTML = `<span class="pick-text"></span>${CHEVRON}`;
    select.after(button);
    select._pick = button;

    const sync = () => {
      const opt = select.options[select.selectedIndex];
      button.querySelector('.pick-text').textContent = opt ? opt.textContent : '';
      button.title = opt ? opt.textContent : '';
      button.disabled = select.disabled;
      if (open && open.select === select) render();
    };
    select._syncPick = sync;

    // Code sets .value and .selectedIndex directly; keep the button in step.
    for (const prop of ['value', 'selectedIndex']) {
      const desc = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, prop);
      Object.defineProperty(select, prop, {
        configurable: true,
        get() { return desc.get.call(this); },
        set(v) { desc.set.call(this, v); sync(); },
      });
    }
    // Options are rebuilt when devices change; follow them.
    new MutationObserver(sync).observe(select, { childList: true, subtree: true, attributes: true, attributeFilter: ['disabled'] });
    select.addEventListener('change', sync);

    button.addEventListener('click', (e) => {
      e.preventDefault();
      if (open && open.select === select) close();
      else show(select);
    });
    button.addEventListener('keydown', (e) => {
      if (['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(e.key) && !open) {
        e.preventDefault();
        show(select);
      }
    });
    sync();
  }

  function show(select) {
    close();
    const menu = document.createElement('div');
    menu.className = 'pick-menu';
    menu.setAttribute('role', 'listbox');
    document.body.append(menu);
    open = { select, button: select._pick, menu, index: select.selectedIndex };
    open.button.setAttribute('aria-expanded', 'true');
    open.button.classList.add('open');
    render();
    place();
    const current = menu.querySelector('.pick-item.selected');
    if (current) current.scrollIntoView({ block: 'nearest' });
  }

  function render() {
    const { select, menu } = open;
    menu.textContent = '';
    [...select.options].forEach((opt, i) => {
      const item = document.createElement('div');
      item.className = 'pick-item';
      item.setAttribute('role', 'option');
      item.setAttribute('aria-selected', String(i === select.selectedIndex));
      item.classList.toggle('selected', i === select.selectedIndex);
      item.classList.toggle('active', i === open.index);
      item.classList.toggle('disabled', opt.disabled);
      item.innerHTML = `<span class="pick-check">${CHECK}</span><span class="pick-label"></span>`;
      item.querySelector('.pick-label').textContent = opt.textContent;
      item.title = opt.textContent;
      item.addEventListener('mousemove', () => { if (open.index !== i) { open.index = i; markActive(); } });
      item.addEventListener('click', () => choose(i));
      menu.append(item);
    });
  }

  function markActive() {
    [...open.menu.children].forEach((el, i) => el.classList.toggle('active', i === open.index));
    const el = open.menu.children[open.index];
    if (el) el.scrollIntoView({ block: 'nearest' });
  }

  // Below the button, or above it when there isn't room.
  function place() {
    const { button, menu } = open;
    const r = button.getBoundingClientRect();
    const width = Math.max(r.width, 220);
    menu.style.minWidth = `${width}px`;
    menu.style.maxWidth = `${Math.min(420, window.innerWidth - 16)}px`;
    const h = Math.min(menu.scrollHeight, 300);
    const below = window.innerHeight - r.bottom - 8;
    const top = below >= h || below >= r.top ? r.bottom + 6 : Math.max(8, r.top - h - 6);
    const left = Math.min(Math.max(8, r.right - menu.offsetWidth), window.innerWidth - menu.offsetWidth - 8);
    menu.style.top = `${top}px`;
    menu.style.left = `${left}px`;
    menu.style.maxHeight = `${Math.max(120, top > r.top ? below : r.top - 14)}px`;
  }

  function choose(i) {
    const { select, button } = open;
    const opt = select.options[i];
    if (!opt || opt.disabled) return;
    close();
    if (select.selectedIndex !== i) {
      select.selectedIndex = i;
      select.dispatchEvent(new Event('change', { bubbles: true }));
    }
    button.focus();
  }

  function close() {
    if (!open) return;
    open.button.setAttribute('aria-expanded', 'false');
    open.button.classList.remove('open');
    open.menu.remove();
    open = null;
  }

  document.addEventListener('keydown', (e) => {
    if (!open) return;
    const n = open.select.options.length;
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); const b = open.button; close(); b.focus(); return; }
    if (e.key === 'ArrowDown') { e.preventDefault(); open.index = Math.min(n - 1, open.index + 1); markActive(); }
    if (e.key === 'ArrowUp') { e.preventDefault(); open.index = Math.max(0, open.index - 1); markActive(); }
    if (e.key === 'Home') { e.preventDefault(); open.index = 0; markActive(); }
    if (e.key === 'End') { e.preventDefault(); open.index = n - 1; markActive(); }
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); choose(open.index); }
    if (e.key === 'Tab') close();
  }, true);
  document.addEventListener('mousedown', (e) => {
    if (open && !open.menu.contains(e.target) && !open.button.contains(e.target)) close();
  }, true);
  window.addEventListener('resize', close);
  document.addEventListener('scroll', (e) => { if (open && !open.menu.contains(e.target)) close(); }, true);

  for (const s of document.querySelectorAll('select')) enhance(s);
})();
