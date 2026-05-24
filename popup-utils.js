/**
 * SessionPort — popup-utils.js
 * Базовые утилиты popup. Загружается первым среди popup-скриптов.
 * Требует: shared-utils.js (PR_Utils), DOM готов (popup.html).
 */

// ── DOM shortcut ─────────────────────────────────────────
const $ = id => document.getElementById(id);

// ── Transfer ID system ───────────────────────────────────
// Each capture session gets a unique UUID baked into the prompt.
// The model echoes it back in JSON.meta.transfer_id; capture validates it.
// This eliminates cross-session contamination (old JSON on page from previous transfer).
const TRANSFER_ID_REGEX = /^pr_[a-z0-9]{16}$/;

function generateTransferId() {
  // Crypto-safe 16-char random suffix → 80 bits entropy, collision-resistant
  const bytes = new Uint8Array(10);
  crypto.getRandomValues(bytes);
  const hex = Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 16);
  return 'pr_' + hex;
}

function isValidTransferId(id) {
  return typeof id === 'string' && TRANSFER_ID_REGEX.test(id);
}

// Get last captured transfer_id (for parent_transfer_id chaining).
// Returns null if no previous capture or previous didn't have valid transfer_id.
async function getLastTransferId() {
  return new Promise(resolve => {
    chrome.runtime.sendMessage({ action: 'GET_ACTIVE' }, async resp => {
      if (chrome.runtime.lastError || !resp?.snapshot_id) { resolve(null); return; }
      try {
        const snap = await SessionPortDB.getSnapshot(resp.snapshot_id);
        const tid = snap?.payload?.meta?.transfer_id;
        resolve(isValidTransferId(tid) ? tid : null);
      } catch { resolve(null); }
    });
  });
}

// currentMode/currentStep removed — state lives in chrome.storage.local flow_state only

// ── Секции (accordion) ───────────────────────────────────
// Simple and Extended are mutual-exclusive accordion.
// Paste panel is independent — collapsing it does NOT affect others.
function _initSectionAccordion() {
  document.querySelectorAll('.section-header').forEach(header => {
    header.addEventListener('click', () => {
      const sectionId = header.dataset.section;
      const section = document.getElementById(sectionId);
      if (!section) return;

      // Paste panel toggles independently
      if (sectionId === 'sectionPaste') {
        section.classList.toggle('open');
        return;
      }

      // Simple ↔ Extended: close the other, toggle self
      document.querySelectorAll('.section').forEach(s => {
        const sid = s.id;
        if (sid !== sectionId && sid !== 'sectionPaste') {
          s.classList.remove('open');
        }
      });
      section.classList.toggle('open');
    });
  });
}
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', _initSectionAccordion);
} else {
  _initSectionAccordion();
}

// ── Status bar ───────────────────────────────────────────
const statusDot  = $('statusDot');
const statusText = $('statusText');

function setStatus(text, state = 'idle') {
  if (statusText) statusText.textContent = text;
  if (statusDot) {
    statusDot.className = 'status-dot';
    if (state === 'active')  statusDot.classList.add('active');
    if (state === 'working') statusDot.classList.add('working');
    if (state === 'error')   statusDot.classList.add('error');
  }
}

// ── Progress bar ─────────────────────────────────────────
function setProgress(pct, label) {
  // Determine which progress bar to use based on active transfer mode
  const extSection = $('sectionExtended');
  const isExtended = extSection && extSection.classList.contains('open');
  const wrap = $(isExtended ? 'progressWrapExt' : 'progressWrap');
  const bar  = $(isExtended ? 'progressBarExt'  : 'progressBar');
  if (!wrap || !bar) return;
  if (pct === 0) {
    wrap.classList.remove('show');
    bar.style.width = '0%';
    return;
  }
  wrap.classList.add('show');
  bar.style.width = pct + '%';
  if (label) setStatus(label, pct === 100 ? 'active' : 'working');
}

// ── Checklist step state ──────────────────────────────────
// states: 'wait' | 'active' | 'done'
function setStepState(btnId, state) {
  const btn = document.getElementById(btnId);
  if (!btn) return;
  btn.classList.remove('state-wait', 'state-active', 'state-done', 'dimmed');
  btn.classList.add('state-' + state);
  if (state === 'wait') btn.classList.add('dimmed');
  const badge = btn.querySelector('.state-badge');
  if (badge) badge.textContent = state === 'active' ? PR_i18n.t('badge.active') : state === 'done' ? PR_i18n.t('badge.done') : PR_i18n.t('badge.waiting');
}

function setChecklistProgress(checklistId, stepNumber) {
  const el = document.getElementById(checklistId);
  if (!el) return;
  // UI-03: compute percent from actual step count instead of hardcoded classes
  const totalSteps = parseInt(el.dataset.steps || '3', 10);
  el.classList.remove('progress-1', 'progress-2', 'progress-3', 'progress-4');
  if (stepNumber > 0) {
    const pct = stepNumber >= totalSteps ? 100 : Math.round((stepNumber / totalSteps) * 100);
    el.style.setProperty('--checklist-progress', pct + '%');
    el.classList.add('progress-active');
  } else {
    el.style.removeProperty('--checklist-progress');
    el.classList.remove('progress-active');
  }
}

// ── saveStep — atomic read-modify-write to avoid race condition ──
// Если два saveStep вызываются подряд — последний отменяет предыдущий pending get.
let _saveStepPending = null;
function saveStep(mode, step) {
  // Отменяем предыдущий pending если ещё не выполнился
  if (_saveStepPending) { _saveStepPending.cancelled = true; }
  const token = { cancelled: false };
  _saveStepPending = token;
  chrome.storage.local.get(['flow_state'], res => {
    if (token.cancelled) return; // более новый saveStep уже в пути
    _saveStepPending = null;
    const state = res.flow_state || {};
    chrome.storage.local.set({
      flow_state: {
        status:       state.status       || 'IDLE',
        payload:      state.payload      || null,
        source_host:  state.source_host  || null,
        transfer_id:  state.transfer_id  || null,  // preserve UUID across steps
        mode,
        step
      }
    });
  });
}

// ── Double-click guard ────────────────────────────────────
const guard = async (btn, fn) => {
  if (!btn || btn.disabled || btn.classList.contains('dimmed')) return;
  btn.disabled = true;
  try { await fn(); } finally { btn.disabled = false; }
};

// ── LLM domains for tab detection ────────────────────────────
const LLM_DOMAINS = ['chatgpt.com','claude.ai','grok.com','gemini.google.com',
                     'perplexity.ai','chat.mistral.ai', 'chat.deepseek.com'];

function _isLLMTab(tab) {
  if (!tab?.url) return false;
  try { return LLM_DOMAINS.some(d => new URL(tab.url).hostname.includes(d)); }
  catch { return false; }
}

// ── sendToContentScript (active tab + auto-reinject all 4 scripts) ────
// FIX: side panel runs in its own window — lastFocusedWindow/currentWindow both
// return the side panel's window, not the LLM tab's window.
// Strategy: query ALL windows for active LLM tab; fall back to any LLM tab.
// quiet=true  — не показывать setStatus при отсутствии вкладки (для фоновых опросов)
// rawResponse  — вернуть полный объект ответа вместо response?.success
function sendToContentScript(action, data = {}, retry = true, quiet = false, rawResponse = false) {
  return new Promise(resolve => {
    // Step 1: find active LLM tab across ALL windows
    chrome.tabs.query({ active: true }, tabs => {
      const llmActive = tabs.find(_isLLMTab);
      if (llmActive) {
        _sendToTab(llmActive.id, action, data, retry, resolve, quiet, rawResponse);
        return;
      }
      // Step 2: no active LLM tab — find any LLM tab (user may have scrolled away)
      chrome.tabs.query({}, allTabs => {
        const llmAny = allTabs.filter(_isLLMTab)
          .sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0))[0];
        if (llmAny) {
          _sendToTab(llmAny.id, action, data, retry, resolve, quiet, rawResponse);
          return;
        }
        if (!quiet) setStatus(PR_i18n.t('status.no_llm'), 'error');
        resolve(false);
      });
    });
  });
}

function _sendToTab(tabId, action, data, retry, resolve, quiet = false, rawResponse = false) {
  chrome.tabs.sendMessage(tabId, { action, ...data }, response => {
    if (chrome.runtime.lastError) {
      if (retry) {
        if (!quiet) setStatus(PR_i18n.t('status.connecting'), 'working');
        chrome.runtime.sendMessage({ action: 'INJECT_CONTENT_SCRIPTS', tabId }, res => {
          if (res?.success) {
            setTimeout(() => sendToContentScript(action, data, false, quiet, rawResponse).then(resolve), 600);
          } else {
            if (!quiet) setStatus(PR_i18n.t('status.conn_fail'), 'error');
            resolve(false);
          }
        });
      } else {
        if (!quiet) setStatus(PR_i18n.t('status.conn_fail'), 'error');
        resolve(false);
      }
      return;
    }
    resolve(rawResponse ? response : (response?.success ?? false));
  });
}

// ── Paste panel ───────────────────────────────────────────
function showPastePanel(msgKey = null) {
  const section = $('sectionPaste');
  if (!section) return;
  section.style.display = '';
  section.classList.remove('hidden');
  section.classList.add('open');
  const srcW = $('srcWarning');
  if (srcW) {
    srcW.style.display = msgKey ? 'block' : 'none';
    if (msgKey) {
      srcW.dataset.i18nMsg = msgKey;
      srcW.textContent = PR_i18n.t(msgKey);
    } else {
      delete srcW.dataset.i18nMsg;
    }
  }
  setStatus(msgKey ? PR_i18n.t(msgKey) : PR_i18n.t('status.paste_ready'), 'active');
}

function hidePastePanel() {
  const section = $('sectionPaste');
  if (!section) return;
  section.classList.remove('open');
  section.classList.add('hidden');
  section.style.display = 'none';
}

// ── Theme ─────────────────────────────────────────────────
const themeToggle = $('themeToggle');
const themeThumb  = $('themeThumb');

function applyPopupTheme(light) {
  document.body.classList.toggle('light', light);
  if (themeToggle) themeToggle.style.background = light ? '#aaff00' : '#334155';
  if (themeThumb) {
    themeThumb.style.left       = light ? '15px' : '2px';
    themeThumb.style.background = light ? '#ffffff' : '#94a3b8';
  }
  // Sync map theme toggle if it exists
  const mt  = document.getElementById('mapThemeToggle');
  const mth = document.getElementById('mapThemeThumb');
  if (mt)  mt.style.background  = light ? '#aaff00' : '#334155';
  if (mth) { mth.style.left = light ? '14px' : '2px'; mth.style.background = light ? '#fff' : '#94a3b8'; }
  if (typeof _buildMapProjSel === 'function' && typeof _mapRenderer !== 'undefined' && _mapRenderer) {
    _buildMapProjSel(_mapRenderer.snaps || []);
  }
}

PR_Utils.loadTheme(light => applyPopupTheme(light));

themeToggle?.addEventListener('click', () => {
  const next = !document.body.classList.contains('light');
  PR_Utils.saveTheme(next);
  applyPopupTheme(next);
});

// Синхронизация темы: если dashboard переключает — popup подхватывает
chrome.storage.onChanged.addListener(changes => {
  if (changes.pr_theme) {
    const light = changes.pr_theme.newValue === 'light';
    applyPopupTheme(light);
    // Пересоздать кнопки проектов в mind map если открыт
    if (typeof _buildHistMapProjSel === 'function' && typeof _hmapRenderer !== 'undefined' && _hmapRenderer) {
      _buildHistMapProjSel(_hmapRenderer.snaps || []);
    }
  }
});
