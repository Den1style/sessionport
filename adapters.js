/**
 * SessionPort — adapters.js
 * Site adapters для 6 LLM-платформ.
 *
 * Каждый адаптер содержит:
 *   findInput()      — поле ввода текста
 *   findLastMessage() — последний ответ ассистента
 *   findDropTarget() — зона drop для файлов
 *   inject()         — вставка текста
 *   injectFiles()    — вставка файлов (платформо-специфично)
 *
 * Зависимости: inject.js
 */

// ── Утилита видимости ─────────────────────────────────────────
const visibleFirst = (sel) => {
  for (const el of document.querySelectorAll(sel)) {
    const r = el.getBoundingClientRect();
    if (r.width > 0 && r.height > 0 && el.offsetParent !== null) return el;
  }
  return null;
};

// ── Утилита: собрать File[] из дескрипторов ───────────────────
const _buildFiles = (fileDescriptors) => fileDescriptors.map(fd => {
  const binary = atob(fd.content_b64);
  const bytes  = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new File([bytes], fd.filename, { type: fd.mime || 'application/octet-stream' });
});

// ── Утилита: drop-only без dragenter/dragover ─────────────────
const _dropOnly = (el, files) => {
  const dt = new DataTransfer();
  files.forEach(f => dt.items.add(f));
  const rect = el.getBoundingClientRect();
  el.dispatchEvent(new DragEvent('drop', {
    bubbles: true, cancelable: true, composed: true, dataTransfer: dt,
    clientX: rect.left + rect.width / 2,
    clientY: rect.top  + rect.height / 2
  }));
  document.dispatchEvent(new DragEvent('dragend', { bubbles: true }));
};

// ── Утилита: полный drag sequence с закрытием overlay ─────────
const _dragSequence = (el, files) => {
  const dt = new DataTransfer();
  files.forEach(f => dt.items.add(f));
  const rect = el.getBoundingClientRect();
  const cx = rect.left + rect.width / 2;
  const cy = rect.top  + rect.height / 2;
  const init = { bubbles: true, cancelable: true, composed: true,
                 dataTransfer: dt, clientX: cx, clientY: cy };
  el.dispatchEvent(new DragEvent('dragenter', init));
  el.dispatchEvent(new DragEvent('dragover',  init));
  el.dispatchEvent(new DragEvent('drop',      init));
  // Закрываем overlay — отправляем dragend + dragleave
  el.dispatchEvent(new DragEvent('dragleave', { bubbles: true, dataTransfer: dt }));
  document.dispatchEvent(new DragEvent('dragend', { bubbles: true }));
};

// ── Утилита: вставка через скрытый input[type=file] ───────────
const _fileInput = (files) => {
  const input = document.querySelector('input[type="file"]');
  if (!input) return false;
  const dt = new DataTransfer();
  files.forEach(f => dt.items.add(f));
  Object.defineProperty(input, 'files', { value: dt.files, configurable: true });
  input.dispatchEvent(new Event('change', { bubbles: true }));
  input.dispatchEvent(new Event('input',  { bubbles: true }));
  try { delete input.files; } catch(_) {}
  return true;
};

// ── Метаданные для бота валидации ─────────────────────────────
const ADAPTERS_META = {
  schemaVersion: '1.0',
  generatedAt:   '2026-04-28',
  botTestContract: 'adapters.test.js'
};

// ── Адаптеры ──────────────────────────────────────────────────
const ADAPTERS = {

  'claude.ai': {
    version: '1.2.9', lastVerified: '2026-04-28',
    stability: 'medium',
    notes: 'input[type=file] стабилен. ProseMirror/Tiptap для текста.',

    findInput: () => visibleFirst(
      'div.tiptap.ProseMirror[contenteditable="true"], div.ProseMirror[contenteditable="true"]'
    ),
    findLastMessage: () => {
      const byRole = document.querySelectorAll('[data-message-author-role="assistant"]');
      for (let i = byRole.length - 1; i >= 0; i--)
        if (byRole[i].innerText?.trim().length > 10) return byRole[i];
      const byClass = document.querySelectorAll('div[class*="group"][class*="relative"][class*="pb-"]');
      if (byClass.length > 0) return byClass[byClass.length - 1];
      const byFont = document.querySelectorAll('[class*="font-claude-response"]');
      return byFont.length > 0 ? byFont[byFont.length - 1] : null;
    },
    findDropTarget: () => visibleFirst('div.ProseMirror[contenteditable="true"]'),
    inject: (...args) => injectProseMirror(...args),

    // ✅ Проверено: dragenter+dragover+drop на composer (как в оригинале)
    injectFiles: (fileDescriptors) => {
      const files = _buildFiles(fileDescriptors);
      // Стратегия 1: input[type=file] если есть
      if (_fileInput(files)) return { success: true, injected: files.length };
      // Стратегия 2: drag sequence на outer composer (оригинальный рабочий подход)
      const pm = visibleFirst('div.ProseMirror[contenteditable="true"]');
      const composer = pm?.closest('fieldset, form, [class*="composer"]')
                    || pm?.parentElement
                    || pm;
      if (!composer) return { success: false, error: 'no drop target' };
      _dragSequence(composer, files);
      return { success: true, injected: files.length };
    }
  },

  'chatgpt.com': {
    version: '1.2.9', lastVerified: '2026-04-28',
    stability: 'high',
    notes: 'dragenter+dragover+drop на form — React handler принимает файл. Overlay закрывается через dragleave+dragend.',

    findInput: () => visibleFirst(
      'div.ProseMirror[contenteditable="true"], #prompt-textarea'
    ),
    findLastMessage: () => {
      const all  = Array.from(document.querySelectorAll('[data-message-author-role="assistant"]'));
      const real = all.filter(el => (el.innerText || '').trim().length > 50);
      return real.length > 0 ? real[real.length - 1] : all[all.length - 1] || null;
    },
    findDropTarget: () => {
      // Форма нужна для drag sequence — React drop handler висит на ней
      return document.querySelector('form[data-type="unified-composer"], form')
          || visibleFirst('div.ProseMirror[contenteditable="true"], #prompt-textarea');
    },
    inject: (el, t) => {
      if (el.classList?.contains('ProseMirror')) return injectProseMirror(el, t);
      if (el instanceof HTMLTextAreaElement)      return injectTextarea(el, t);
      showToast('Неизвестный тип поля ChatGPT', 'error');
      return false;
    },

    // 🧪 В тесте: dragenter+dragover+drop на форму (оригинальный рабочий подход)
    injectFiles: (fileDescriptors) => {
      const files = _buildFiles(fileDescriptors);
      // Ищем форму — несколько вариантов селектора
      const form = document.querySelector('form[data-type="unified-composer"]')
                || document.querySelector('form:has(#prompt-textarea)')
                || document.querySelector('form:has(div.ProseMirror)')
                || document.querySelector('form');
      if (!form) return { success: false, error: 'form not found' };
      _dragSequence(form, files);
      // Попытка закрыть overlay через Escape
      setTimeout(() => {
        document.dispatchEvent(new KeyboardEvent('keydown', {
          key: 'Escape', keyCode: 27, bubbles: true, cancelable: true
        }));
      }, 300);
      return { success: true, injected: files.length };
    }
  },

  'grok.com': {
    version: '1.2.9', lastVerified: '2026-04-28',
    stability: 'medium',
    notes: 'File handler на main, не на ProseMirror. Без dragenter — нет дубля.',

    findInput: () => visibleFirst(
      'div.tiptap.ProseMirror[contenteditable="true"], div.ProseMirror[contenteditable="true"]'
    ),
    findLastMessage: () => {
      const main = document.querySelector('main, [role="main"]');
      if (!main) return null;
      const blocks = main.querySelectorAll('div.prose, [class*="markdown"]');
      for (let i = blocks.length - 1; i >= 0; i--)
        if (blocks[i].innerText.trim().length > 10) return blocks[i];
      return null;
    },
    findDropTarget: () => visibleFirst('div.ProseMirror[contenteditable="true"]'),
    inject: (...args) => injectProseMirror(...args),

    injectFiles: (fileDescriptors) => {
      const files   = _buildFiles(fileDescriptors);
      const dropZone = document.querySelector('main, [role="main"]') || document.body;
      _dropOnly(dropZone, files);
      return { success: true, injected: files.length };
    }
  },

  'gemini.google.com': {
    version: '1.2.28', lastVerified: '2026-05-05',
    stability: 'high',
    notes: 'Quill editor. Файлы: synthetic paste event с File на .ql-editor.',

    findInput: () => document.querySelector('.ql-editor[contenteditable="true"]'),
    findLastMessage: () => {
      const a = document.querySelectorAll('message-content');
      return a.length > 0 ? a[a.length - 1] : null;
    },
    findDropTarget: () => document.querySelector('.ql-editor[contenteditable="true"]'),
    inject: (...args) => injectQuill(...args),

    injectFiles: (fileDescriptors) => {
      const files = _buildFiles(fileDescriptors);
      const ql = document.querySelector('.ql-editor[contenteditable="true"]');
      if (!ql) return { success: false, error: 'gemini: .ql-editor not found' };
      try { ql.focus(); } catch(_) {}
      const dt = new DataTransfer();
      files.forEach(f => dt.items.add(f));
      const ev = new ClipboardEvent('paste', {
        clipboardData: dt, bubbles: true, cancelable: true, composed: true,
      });
      ql.dispatchEvent(ev);
      if (ev.defaultPrevented) return { success: true, injected: files.length };
      return { success: false, error: 'gemini: paste not accepted' };
    }
  },

  'chat.mistral.ai': {
    version: '1.2.30', lastVerified: '2026-05-05',
    stability: 'high',
    notes: 'ProseMirror. Файлы: synthetic paste event с File на .ProseMirror.',

    findInput: () => visibleFirst('div.ProseMirror[contenteditable="true"]'),
    findLastMessage: () => {
      const a = document.querySelectorAll('[class*="group/message"]');
      return a.length > 0 ? a[a.length - 1] : null;
    },
    findDropTarget: () => {
      const pm = visibleFirst('div.ProseMirror[contenteditable="true"]');
      return pm?.closest('form, [class*="composer"]') || pm;
    },
    inject: (...args) => injectProseMirror(...args),

    injectFiles: (fileDescriptors) => {
      const files = _buildFiles(fileDescriptors);
      const pm = visibleFirst('div.ProseMirror[contenteditable="true"]');
      if (!pm) return { success: false, error: 'mistral: .ProseMirror not found' };
      try { pm.focus(); } catch(_) {}
      const dt = new DataTransfer();
      files.forEach(f => dt.items.add(f));
      const ev = new ClipboardEvent('paste', {
        clipboardData: dt, bubbles: true, cancelable: true, composed: true,
      });
      pm.dispatchEvent(ev);
      if (ev.defaultPrevented) return { success: true, injected: files.length };
      return { success: false, error: 'mistral: paste not accepted' };
    }
  },

  'chat.deepseek.com': {
    version: '1.2.9', lastVerified: '2026-05-03',
    stability: 'medium',
    notes: 'textarea input. input[type=file] для файлов.',

    findInput: () => document.querySelector('textarea._27c9245, textarea[class*="ds-scroll"]') 
                  || document.querySelector('textarea'),
    findLastMessage: () => {
      const all = document.querySelectorAll('[class*="aa40b5de"], [data-role="assistant"]');
      return all.length > 0 ? all[all.length - 1] : null;
    },
    findDropTarget: () => document.querySelector('textarea'),
    inject: (el, t) => injectTextarea(el, t),
    injectFiles: (fileDescriptors) => {
      const files = _buildFiles(fileDescriptors);
      if (_fileInput(files)) return { success: true, injected: files.length };
      return { success: false, error: 'deepseek: file input not found' };
    }
  },

  'perplexity.ai': {
    version: '1.2.36', lastVerified: '2026-05-07',
    stability: 'medium',
    notes: 'Free tier поддерживает файлы с мая 2026. input[type=file] preferred, dragSeq fallback.',

    findInput: () => document.querySelector(
      '[contenteditable="true"][class*="overflow-auto"], [contenteditable="true"][class*="caret-"]'
    ),
    findLastMessage: () => {
      const a = document.querySelectorAll('[class*="prose"]');
      return a.length > 0 ? a[a.length - 1] : null;
    },
    findDropTarget: () => {
      const ed = document.querySelector(
        '[contenteditable="true"][class*="overflow-auto"], [contenteditable="true"][class*="caret-"]'
      );
      return ed?.closest('form') || ed;
    },
    inject: (...args) => injectContentEditable(...args),

    injectFiles: (fileDescriptors) => {
      const files = _buildFiles(fileDescriptors);
      // Пробуем input[type=file] — надёжнее dragSeq
      const inp = document.querySelector('input[type="file"]');
      if (inp) {
        const dt = new DataTransfer();
        files.forEach(f => dt.items.add(f));
        const nativeDesc = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'files');
        if (nativeDesc?.set) nativeDesc.set.call(inp, dt.files);
        else Object.defineProperty(inp, 'files', { value: dt.files, configurable: true });
        inp.dispatchEvent(new Event('change', { bubbles: true }));
        return { success: true, injected: files.length };
      }
      // Fallback: dragSeq на form
      const target = document.querySelector(
        '[contenteditable="true"][class*="overflow-auto"], [contenteditable="true"][class*="caret-"]'
      );
      if (!target) return { success: false, error: 'no target' };
      const form = target.closest('form') || target;
      _dragSequence(form, files);
      return { success: true, injected: files.length };
    }
  }
};

// ── getAdapter ────────────────────────────────────────────────
function getAdapter() {
  const h = location.hostname;
  const k = Object.keys(ADAPTERS).find(k => h.includes(k));
  return k ? ADAPTERS[k] : null;
}

// ── Диагностика ───────────────────────────────────────────────
function getAdaptersDiag() {
  return Object.entries(ADAPTERS).map(([site, a]) => ({
    site,
    version:       a.version,
    lastVerified:  a.lastVerified,
    stability:     a.stability,
    hasInput:      (() => { try { return !!a.findInput();       } catch(e) { return null; } })(),
    hasMessage:    (() => { try { return !!a.findLastMessage(); } catch(e) { return null; } })(),
    hasInjectFiles: typeof a.injectFiles === 'function'
  }));
}
