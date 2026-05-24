/**
 * SessionPort — inject.js
 * Инъекция текста в редакторы LLM-платформ.
 * Зависимости: должен быть загружен до adapters.js
 * Функции используются адаптерами: injectProseMirror, injectQuill,
 * injectTextarea, injectContentEditable
 */

// ── Общие константы ─────────────────────────────────────────
const SELECTORS = {
  INPUTS:      'div.ProseMirror[contenteditable="true"], textarea, .ql-editor[contenteditable="true"], [contenteditable="true"]',
  CHAT_AREA:   'main, #thread-container, [role="main"]',
  // Extended: ChatGPT new UI uses <code class="hljs"> NOT inside <pre>
  // Claude uses <pre><code>, Grok uses similar
  // ChatGPT (modern): code.hljs NOT inside <pre>
  // ChatGPT (canvas): may be in iframe — can't reach, handled by captureNow fallback
  // Claude: pre > code  /  Grok: pre > code  /  Gemini: pre > code
  CODE_BLOCKS: [
    'pre code',           // standard (Claude, Grok, Gemini, old ChatGPT)
    'pre',                // bare pre blocks
    'code.hljs',          // ChatGPT 4o new UI
    'code[class*="language-"]', // generic highlight.js
    'div[class*="contain-inline-size"] code', // ChatGPT outer wrapper → code
    'div[class*="overflow-y-auto"] code',     // ChatGPT scroll wrapper → code
    '[data-message-author-role="assistant"] code', // any code in assistant message
  ].join(', ')
};

const MAX_JSON_BYTES     = 500_000;
const CAPTURE_POLL_MS    = 2000;
const CAPTURE_TIMEOUT_MS = 120_000;

// ── Toast ─────────────────────────────────────────────────
const TOAST_DURATION_MS = 3000;

function ensureToastHost() {
  let host = document.getElementById('pr-toast-host');
  if (!host) {
    host = document.createElement('div');
    host.id = 'pr-toast-host';
    host.style.cssText = 'position:fixed;bottom:18px;right:18px;z-index:2147483647;' +
      'display:flex;flex-direction:column;gap:6px;pointer-events:none;';
    document.body?.appendChild(host);
  }
  return host;
}

function showToast(text, type = 'success') {
  const host = ensureToastHost();
  const t = document.createElement('div');
  const colors = { success:'#22c55e', error:'#f87171', info:'#60a5fa' };
  t.style.cssText = 'background:#161822;border:1px solid ' + (colors[type]||'#334155') + ';' +
    'color:#e2e4e9;padding:8px 14px;border-radius:8px;font-size:12px;' +
    'font-family:system-ui,sans-serif;opacity:1;transition:opacity 0.5s;box-shadow:0 4px 12px rgba(0,0,0,.5);';
  t.textContent = text;
  host.appendChild(t);
  setTimeout(() => { t.style.opacity = '0'; setTimeout(() => t.remove(), 500); }, TOAST_DURATION_MS);
}

// ── Context-safe messaging (api-handle-context-invalidated) ─
function safeSendMessage(msg, callback) {
  if (!chrome.runtime?.id) return;
  try {
    chrome.runtime.sendMessage(msg, (response) => {
      if (chrome.runtime.lastError) return;
      callback?.(response);
    });
  } catch (e) {
    if (e.message?.includes('Extension context invalidated')) return;
    throw e;
  }
}

// ── Badge ──────────────────────────────────────────────────
function setBadge(state) {
  if (!chrome.runtime?.id) return;
  try {
    chrome.runtime.sendMessage({ action: 'SET_BADGE', state }).catch(() => {});
  } catch (e) {
    if (e.message?.includes('Extension context invalidated')) return;
  }
}

// ── injectContext (dispatcher) ─────────────────────────────
async function injectContext(text) {
  const adapter = getAdapter();
  const input   = adapter?.findInput() || document.querySelector(SELECTORS.INPUTS);
  if (!input) { showToast('Поле ввода не найдено', 'error'); setBadge('ERROR'); return false; }
  const injectFn = adapter?.inject ?? injectContentEditable;
  return injectFn(input, text);
}

// ── ProseMirror / Tiptap (Claude, Grok, ChatGPT, Mistral) ──
function injectProseMirror(pm, text) {
  const ex = pm.innerText.trim();
  if (ex.length > 20 && !ex.startsWith('ПРОТОКОЛ SessionPort')) {
    showToast('Предыдущий текст заменён', 'info');
  }

  pm.focus();
  const sel = window.getSelection();
  const cr  = document.createRange();
  cr.selectNodeContents(pm);
  sel.removeAllRanges();
  sel.addRange(cr);

  // Step 1: clear via beforeinput deleteContentBackward
  pm.dispatchEvent(new InputEvent('beforeinput', {
    bubbles: true, cancelable: true, composed: true, inputType: 'deleteContentBackward'
  }));
  pm.innerHTML = '';

  // Step 2: insert via execCommand (deprecated but most reliable for React/Tiptap)
  // This goes through the browser's native editing pipeline, not around it
  const inserted = document.execCommand('insertText', false, text);

  // Step 3: if execCommand didn't work (some browsers/frameworks block it),
  // fall back to DOM + synthetic events
  if (!inserted || pm.innerText.trim().length < 10) {
    pm.innerHTML = '';
    for (const line of text.split('\n')) {
      const p = document.createElement('p');
      p.appendChild(line.length === 0 ? document.createElement('br') : document.createTextNode(line));
      pm.appendChild(p);
    }
    // Move cursor to end
    const ln = pm.lastChild;
    if (ln) {
      const er = document.createRange();
      er.selectNodeContents(ln); er.collapse(false);
      sel.removeAllRanges(); sel.addRange(er);
    }
    // Fire input events so React/Tiptap picks up the change
    pm.dispatchEvent(new InputEvent('beforeinput', {
      bubbles: true, cancelable: false, composed: true, inputType: 'insertText', data: text
    }));
    pm.dispatchEvent(new InputEvent('input', {
      bubbles: true, composed: true, inputType: 'insertText', data: text
    }));
  }

  showToast('Промпт вставлен', 'success');
  return true;
}

// ── Textarea (ChatGPT legacy) ──────────────────────────────
function injectTextarea(input, text) {
  if (!(input instanceof HTMLTextAreaElement)) {
    showToast('Тип поля не поддержан', 'error');
    return false;
  }
  if (input.value.trim().length > 20 && !input.value.startsWith('ПРОТОКОЛ SessionPort')) {
    showToast('Предыдущий текст заменён', 'info');
  }
  const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set;
  setter ? setter.call(input, text) : (input.value = text);
  input.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true, inputType: 'insertText', data: text }));
  input.dispatchEvent(new Event('change', { bubbles: true }));
  showToast('Промпт вставлен', 'success');
  return true;
}

// ── Quill (Gemini) ─────────────────────────────────────────
function injectQuill(el, text) {
  el.focus();
  const ex = el.innerText.trim();
  if (ex.length > 20 && !ex.startsWith('ПРОТОКОЛ SessionPort')) {
    showToast('Предыдущий текст заменён', 'info');
  }
  el.innerHTML = '';
  for (const line of text.split('\n')) {
    const p = document.createElement('p');
    p.appendChild(line.length === 0 ? document.createElement('br') : document.createTextNode(line));
    el.appendChild(p);
  }
  el.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true, inputType: 'insertText', data: text }));
  el.dispatchEvent(new Event('blur', { bubbles: true }));
  el.dispatchEvent(new Event('focus', { bubbles: true }));
  showToast('Промпт вставлен', 'success');
  return true;
}

// ── ContentEditable generic (Perplexity, fallback) ─────────
function injectContentEditable(el, text) {
  el.focus();
  const ex = el.innerText.trim();
  if (ex.length > 20 && !ex.startsWith('ПРОТОКОЛ SessionPort')) {
    showToast('Предыдущий текст заменён', 'info');
  }
  el.innerHTML = '';
  for (const line of text.split('\n')) {
    const p = document.createElement('p');
    p.appendChild(line.length === 0 ? document.createElement('br') : document.createTextNode(line));
    el.appendChild(p);
  }
  const sel = window.getSelection();
  const ln = el.lastChild;
  if (ln) {
    const r = document.createRange();
    r.selectNodeContents(ln); r.collapse(false);
    sel.removeAllRanges(); sel.addRange(r);
  }
  el.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true, inputType: 'insertText', data: text }));
  showToast('Промпт вставлен', 'success');
  return true;
}

// ── base64 utils (нужны capture.js) ───────────────────────
function utf8ToBase64(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = '';
  const C = 0x8000;
  for (let i = 0; i < bytes.length; i += C) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + C));
  }
  return btoa(bin);
}

function base64ToUtf8(b64) {
  return new TextDecoder().decode(Uint8Array.from(atob(b64), c => c.charCodeAt(0)));
}

// ── findLastAssistantMessage ───────────────────────────────
function findLastAssistantMessage() {
  const adapter = getAdapter();
  if (adapter?.findLastMessage) {
    const el = adapter.findLastMessage();
    if (el) return el;
  }
  // Generic fallback
  const all = document.querySelectorAll('[data-message-author-role="assistant"]');
  return all.length > 0 ? all[all.length - 1] : null;
}
