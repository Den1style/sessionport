/**
 * SessionPort — shared-utils.js
 * Общие утилиты для всех страниц расширения.
 * Подключается через: <script src="shared-utils.js"></script>
 * Экспортирует в window: PR_Utils
 */

const PR_Utils = (() => {

  // ── Экранирование HTML ─────────────────────────────────────
  function esc(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  // ── Склонение слова «слепок» ───────────────────────────────
  function pluralSnap(n) {
    if (typeof PR_i18n !== 'undefined') return PR_i18n.pluralSnap(n);
    const m = n % 10, c = n % 100;
    if (m === 1 && c !== 11) return 'слепок';
    if (m >= 2 && m <= 4 && (c < 10 || c >= 20)) return 'слепка';
    return 'слепков';
  }

  // ── Универсальный plural ───────────────────────────────────
  function plural(n, one, few, many) {
    const mod10 = n % 10, mod100 = n % 100;
    if (mod10 === 1 && mod100 !== 11) return one;
    if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) return few;
    return many;
  }

  // ── Форматирование байт ────────────────────────────────────
  function fmtBytes(n) {
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
    return (n / (1024 * 1024)).toFixed(2) + ' MB';
  }

  // ── Форматирование даты ────────────────────────────────────
  function fmtDate(isoStr, opts = {}) {
    const defaults = { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' };
    const locale = (typeof PR_i18n !== 'undefined') ? PR_i18n.fmtDateLocale() : 'ru-RU';
    return new Date(isoStr).toLocaleString(locale, { ...defaults, ...opts });
  }

  // ── base64 ↔ UTF-8 ─────────────────────────────────────────
  function base64ToUtf8(b64) {
    return new TextDecoder().decode(Uint8Array.from(atob(b64), c => c.charCodeAt(0)));
  }

  function utf8ToBase64(str) {
    const bytes = new TextEncoder().encode(str);
    let bin = '';
    const C = 0x8000;
    for (let i = 0; i < bytes.length; i += C) {
      bin += String.fromCharCode.apply(null, bytes.subarray(i, i + C));
    }
    return btoa(bin);
  }

  function arrayBufferToBase64(buf) {
    const bytes = new Uint8Array(buf);
    let bin = '';
    const C = 0x8000;
    for (let i = 0; i < bytes.length; i += C) {
      bin += String.fromCharCode.apply(null, bytes.subarray(i, i + C));
    }
    return btoa(bin);
  }

  // ── Иконка по расширению файла ─────────────────────────────
  function iconFor(filename) {
    const ext = (filename || '').split('.').pop().toLowerCase();
    const map = { pdf: '📄', jpg: '🖼', jpeg: '🖼', png: '🖼', gif: '🖼', webp: '🖼',
      doc: '📝', docx: '📝', txt: '📝', md: '📝',
      zip: '📦', rar: '📦', gz: '📦',
      js: '💻', ts: '💻', py: '💻', json: '💻', html: '💻', css: '💻' };
    return map[ext] || '📎';
  }

  // ── Тема: применить + сохранить ───────────────────────────
  function applyTheme(light, elements = {}) {
    document.body.classList.toggle('light', light);
    const { toggle, thumb } = elements;
    if (toggle) toggle.style.background = light ? '#aaff00' : '#334155';
    if (thumb) {
      thumb.style.left       = light ? '15px' : '2px';
      thumb.style.background = light ? '#ffffff' : '#94a3b8';
    }
  }

  function loadTheme(onApply) {
    chrome.storage.local.get('pr_theme', r => onApply(r.pr_theme === 'light'));
  }

  function saveTheme(light) {
    chrome.storage.local.set({ pr_theme: light ? 'light' : 'dark' });
  }

  // ── customConfirm (заменяет нативный confirm) ──────────────
  function customConfirm(message, opts = {}) {
    const cancelDefault = typeof PR_i18n !== 'undefined' ? PR_i18n.t('dlg.cancel') : 'Cancel';
    const { confirmText = 'OK', cancelText = cancelDefault, danger = false } = opts;
    return new Promise(resolve => {
      const isLight = document.body.classList.contains('light');
      const bg = document.createElement('div');
      bg.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.5);' +
        'display:flex;align-items:center;justify-content:center;z-index:9999;';
      const box = document.createElement('div');
      box.style.cssText = 'background:' + (isLight ? '#fff' : '#161822') + ';' +
        'border:1px solid ' + (isLight ? '#e5e7eb' : '#1e2028') + ';' +
        'padding:20px;border-radius:10px;display:flex;flex-direction:column;' +
        'gap:14px;min-width:260px;box-shadow:0 8px 24px rgba(0,0,0,0.4);';
      const lbl = document.createElement('div');
      lbl.textContent = message;
      lbl.style.cssText = 'font-size:13px;color:' + (isLight ? '#111318' : '#e2e4e9') + ';font-weight:500;';
      const btns = document.createElement('div');
      btns.style.cssText = 'display:flex;gap:8px;justify-content:flex-end;';
      const btnOk = document.createElement('button');
      btnOk.textContent = confirmText;
      btnOk.style.cssText = 'padding:6px 14px;background:' + (danger ? '#ef4444' : '#22c55e') + ';' +
        'color:#fff;border:none;border-radius:6px;cursor:pointer;font-size:12px;font-weight:500;';
      const btnCancel = document.createElement('button');
      btnCancel.textContent = cancelText;
      btnCancel.style.cssText = 'padding:6px 14px;background:transparent;' +
        'color:#6b7280;border:none;cursor:pointer;font-size:12px;';
      btns.append(btnCancel, btnOk);
      box.append(lbl, btns);
      bg.append(box);
      document.body.append(bg);
      btnOk.focus();
      const close = val => { bg.remove(); resolve(val); };
      btnOk.onclick     = () => close(true);
      btnCancel.onclick = () => close(false);
      bg.onkeydown      = e => {
        if (e.key === 'Enter')  close(true);
        if (e.key === 'Escape') close(false);
      };
    });
  }

  // ── customPrompt (заменяет нативный prompt/alert) ─────────
  function customPrompt(message, callback, opts = {}) {
    const cancelDefault = typeof PR_i18n !== 'undefined' ? PR_i18n.t('dlg.cancel') : 'Cancel';
    const { placeholder = '', confirmText = 'OK', cancelText = cancelDefault } = opts;
    const isLight = document.body.classList.contains('light');
    const bg = document.createElement('div');
    bg.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.5);' +
      'display:flex;align-items:center;justify-content:center;z-index:9999;';
    const box = document.createElement('div');
    box.style.cssText = 'background:' + (isLight ? '#fff' : '#161822') + ';' +
      'border:1px solid ' + (isLight ? '#e5e7eb' : '#1e2028') + ';' +
      'padding:20px;border-radius:10px;display:flex;flex-direction:column;' +
      'gap:10px;min-width:260px;box-shadow:0 8px 24px rgba(0,0,0,0.4);';
    const lbl = document.createElement('div');
    lbl.textContent = message;
    lbl.style.cssText = 'font-size:13px;color:' + (isLight ? '#111318' : '#e2e4e9') + ';font-weight:500;';
    const inp = document.createElement('input');
    inp.placeholder = placeholder;
    inp.style.cssText = 'padding:8px 10px;background:' + (isLight ? '#f3f4f6' : '#0f1117') + ';' +
      'border:1px solid ' + (isLight ? '#d1d5db' : '#1e2028') + ';' +
      'color:' + (isLight ? '#111318' : '#e2e4e9') + ';border-radius:6px;outline:none;font-size:13px;';
    const btns = document.createElement('div');
    btns.style.cssText = 'display:flex;gap:8px;justify-content:flex-end;margin-top:4px;';
    const btnOk = document.createElement('button');
    btnOk.textContent = confirmText;
    btnOk.style.cssText = 'padding:6px 14px;background:#22c55e;color:#fff;border:none;' +
      'border-radius:6px;cursor:pointer;font-size:12px;font-weight:500;';
    const btnCancel = document.createElement('button');
    btnCancel.textContent = cancelText;
    btnCancel.style.cssText = 'padding:6px 14px;background:transparent;' +
      'color:' + (isLight ? '#6b7280' : '#6b7280') + ';border:none;cursor:pointer;font-size:12px;';
    btns.append(btnCancel, btnOk);
    box.append(lbl, inp, btns);
    bg.append(box);
    document.body.append(bg);
    inp.focus();
    const close = val => { bg.remove(); callback(val); };
    btnOk.onclick     = () => close(inp.value);
    btnCancel.onclick = () => close(null);
    inp.onkeydown     = e => {
      if (e.key === 'Enter')  close(inp.value);
      if (e.key === 'Escape') close(null);
    };
  }

  // ── snapshot → flow_state payload ─────────────────────────
  function snapToFlowState(snap) {
    const b64 = utf8ToBase64(JSON.stringify(snap.payload));
    // Сохраняем transfer_id из снапшота — нужен для chain display и parent_transfer_id при новой сессии
    return {
      status: 'READY_TO_INJECT', payload: b64, source_host: snap.source_host,
      transfer_id: snap.transfer_id || null, mode: null, step: 0
    };
  }

  // ── Публичный API ──────────────────────────────────────────
  return {
    esc, pluralSnap, plural, fmtBytes, fmtDate,
    base64ToUtf8, utf8ToBase64, arrayBufferToBase64,
    iconFor, applyTheme, loadTheme, saveTheme,
    customPrompt, customConfirm, snapToFlowState
  };
})();
