/**
 * SessionPort — capture.js
 * Цикл захвата JSON-слепка из ответа LLM.
 * 3 ветки: code-блоки, BEGIN/END маркеры, голый JSON (Grok).
 * Зависимости: inject.js, adapters.js
 */

let captureInterval   = null;
let captureTimeout    = null;
let captureSessionId  = 0;
let seenBlocks        = new Set();
let _captureStartTextLen = 0;  // text length of last assistant msg at capture start

// ── Запуск ─────────────────────────────────────────────────
function startCapture() {
  stopCapture();
  captureSessionId++;
  const session = captureSessionId;

  setBadge('CAPTURING');
  showToast('Жду финальный JSON от модели…', 'info');

  // CRITICAL FIX: snapshot ALL existing code blocks as "seen"
  // so we only capture NEW blocks that appear after this point.
  // This prevents re-capturing old JSON snapshots from earlier in the dialogue.
  seenBlocks = new Set();
  for (const block of document.querySelectorAll(SELECTORS.CODE_BLOCKS)) {
    const content = block.textContent.replace(/[\uFEFF\u200B\u200C\u200D\u2060]/g, '').trim();
    const fp = content.length + ':' + content.slice(0, 50) + ':' + content.slice(-100);
    seenBlocks.add(fp);
  }

  // Also snapshot current text length of last assistant message for Branch 2/3 filtering
  const lastMsg = findLastAssistantMessage();
  _captureStartTextLen = lastMsg ? (lastMsg.innerText || '').length : 0;

  captureInterval = setInterval(() => {
    if (session !== captureSessionId) return;
    tryCapture();
  }, CAPTURE_POLL_MS);

  setTimeout(() => { if (session === captureSessionId) tryCapture(); }, 3000);

  // Mid-capture sanity check: if model selector is broken after 30s, warn early
  setTimeout(() => {
    if (session !== captureSessionId) return;
    if (!findLastAssistantMessage()) {
      showToast('Сообщения модели не найдены — возможно, интерфейс платформы обновился. Обновите страницу.', 'error');
    }
  }, 30_000);

  captureTimeout = setTimeout(() => {
    if (session !== captureSessionId) return;
    stopCapture(); setBadge('ERROR');
    showToast('Захват прерван (2 мин): JSON не появился. Убедитесь что модель ответила на промпт SessionPort.', 'error');
    chrome.storage.local.get(['flow_state'], r => {
      chrome.storage.local.set({
        flow_state: { status:'IDLE', payload:null, mode: r.flow_state?.mode||null, step: r.flow_state?.step||0 }
      });
    });
  }, CAPTURE_TIMEOUT_MS);
}

// ── Остановка ───────────────────────────────────────────────
function stopCapture() {
  if (captureInterval) { clearInterval(captureInterval); captureInterval = null; }
  clearTimeout(captureTimeout); captureTimeout = null;
  seenBlocks.clear();
  _captureStartTextLen = 0;
}

// ── Ручной захват (SCAN NOW) ─────────────────────────────────
// One-shot: сканирует страницу прямо сейчас без запуска интервала.
// Используется кнопкой «Захватить вручную» и как fallback.
function captureNow() {
  // Reset seen/length so we scan everything on page
  seenBlocks.clear();
  _captureStartTextLen = 0;
  setBadge('CAPTURING');
  showToast('Сканирую страницу…', 'info');
  tryCapture();
  // Try a few more times in case page is still rendering
  let attempts = 0;
  const poll = setInterval(() => {
    attempts++;
    tryCapture();
    if (attempts >= 10) {
      clearInterval(poll);
      // If still not captured after 10 tries
      chrome.storage.local.get(['flow_state'], r => {
        if (r.flow_state?.status !== 'READY_TO_INJECT') {
          setBadge('ERROR');
          const hasMsg = !!findLastAssistantMessage();
          showToast(
            hasMsg
              ? 'SessionPort JSON не найден. Убедитесь что модель ответила на промпт — или попробуйте Full Transfer.'
              : 'Сообщения модели не найдены — возможно, интерфейс платформы обновился. Обновите страницу и попробуйте снова.',
            'error'
          );
        }
      });
    }
  }, 500);
}

// ── Основная попытка захвата ─────────────────────────────
function tryCapture() {

  // ══ Ветка 1: code-блоки (```json ... ```) ══
  const _lastMsg = findLastAssistantMessage();
  const _allBlocks = Array.from(document.querySelectorAll(SELECTORS.CODE_BLOCKS));
  const _filtered = _lastMsg ? _allBlocks.filter(b => _lastMsg.contains(b) || _lastMsg === b) : _allBlocks;
  const _blocksToScan = (_lastMsg && _filtered.length === 0) ? _allBlocks : _filtered;
  for (const block of _blocksToScan) {
    const content = block.textContent
      .replace(/[﻿​‌‍⁠]/g, '').trim();
    const fp = content.length + ':' + content.slice(0, 50) + ':' + content.slice(-100);
    if (seenBlocks.has(fp)) continue;
    if (seenBlocks.size > 500) {
      const first = seenBlocks.values().next().value;
      seenBlocks.delete(first);
    }
    if (!content.startsWith('{') || !content.endsWith('}')) continue;
    if (new TextEncoder().encode(content).length > MAX_JSON_BYTES) {
      showToast('JSON >500KB — захват отменён', 'error');
      seenBlocks.add(fp); stopCapture(); setBadge('ERROR'); return;
    }
    try {
      const parsed = JSON.parse(content);
      if (_notSessionPort(parsed)) continue;
      const isV11 = parsed?.meta?.version === '1.1';
      const requiredFields = isV11
        ? ['meta','dna','decisions','state','instructions','validation']
        : ['meta','core','ledger','runtime','validation_protocol'];
      const miss = requiredFields.filter(k => !parsed[k]);
      if (miss.length > 0) { console.warn('[PR] Пропущены поля:', miss.join(',')); continue; }
      if (_isTemplatePlaceholder(parsed)) { continue; }
      _saveAndStop(content, parsed);
      return;
    } catch (e) {
      if (!(e instanceof SyntaxError)) console.error("[PR] Unexpected capture error:", e);
      /* partial JSON — continue polling */
    }
  }

  // ══ Ветка 2+3: общие переменные — объявляем ДО Branch 2 return'ов ══
  const root    = findLastAssistantMessage();
  const fullTxt = root ? (root.innerText || root.textContent || '') : '';
  // Sliced: new text since capture started
  // If message is entirely new OR slice gives nothing — use full message
  const sliced  = (fullTxt.length > _captureStartTextLen)
    ? fullTxt.slice(_captureStartTextLen)
    : fullTxt;
  const txt = sliced.length > 0 ? sliced : fullTxt;

  // ══ Ветка 2: BEGIN/END маркеры ══
  if (root && txt) {
    const BM = '---BEGIN CONTEXT---';
    const EM = '---END CONTEXT---';
    const bi = txt.lastIndexOf(BM);
    const ei = txt.lastIndexOf(EM);

    if (bi !== -1 && ei > bi) {
      const cand = cleanJsonCandidate(txt.slice(bi + BM.length, ei).trim());
      let parsed;
      try { parsed = JSON.parse(cand); }
      catch {
        try { parsed = JSON.parse(cand.replace(/[“”]/g, '"').replace(/[‘’]/g, "'")); }
        catch { /* fall through */ }
      }
      if (parsed && !_notSessionPort(parsed)) {
        const isV11b2 = parsed?.meta?.version === '1.1';
        const reqB2 = isV11b2
          ? ['meta','dna','decisions','state']
          : ['meta','core','ledger','runtime'];
        if (reqB2.every(k => parsed[k])) {
          if (new TextEncoder().encode(cand).length > MAX_JSON_BYTES) {
            showToast('JSON >500KB — захват отменён', 'error'); stopCapture(); setBadge('ERROR'); return;
          }
          _saveAndStop(cand, parsed);
          return;
        }
      }
    }
  }

  // ══ Ветка 3: голый JSON (plain text, Grok / ChatGPT без code-блока) ══
  const PROTO_MARKER = '{"meta":{"protocol":"SessionPort"';
  // Search in sliced txt first (new content since capture start)
  // Fallback: search in full last assistant message (handles case where
  // the whole response IS the new message and slice calculation was off)
  let b3start = txt.indexOf(PROTO_MARKER);
  if (b3start === -1) {
    const lo = txt.toLowerCase();
    const li = lo.indexOf('{"meta":{"protocol":"sessionport"');
    if (li !== -1) b3start = li;
  }
  // Fallback: try full message text
  if (b3start === -1) {
    const fb3start = fullTxt.indexOf(PROTO_MARKER);
    const fb3lo    = fullTxt.toLowerCase().indexOf('{"meta":{"protocol":"sessionport"');
    const fb3      = fb3start !== -1 ? fb3start : fb3lo;
    if (fb3 !== -1) {
      // Only use if this position changed since last poll (text grew)
      // i.e. the JSON appeared or grew since capture started
      if (fullTxt.length > _captureStartTextLen) {
        b3start = fb3;
      }
    }
  }
  if (b3start === -1) return;

  // Найти парную закрывающую скобку
  let depth = 0, b3end = -1;
  for (let i = b3start; i < txt.length; i++) {
    if (txt[i] === '{') depth++;
    else if (txt[i] === '}') { depth--; if (depth === 0) { b3end = i; break; } }
  }
  // JSON ещё не дописан (стриминг)
  if (b3end === -1 || depth !== 0) return;

  const jsonCand = cleanJsonCandidate(txt.slice(b3start, b3end + 1));
  let p3;
  try { p3 = JSON.parse(jsonCand); }
  catch {
    try { p3 = JSON.parse(jsonCand.replace(/[""]/g, '"').replace(/['']/g, "'")); }
    catch { return; }
  }
  if (_notSessionPort(p3)) return;
  const isV11b3 = p3?.meta?.version === '1.1';
  const reqB3 = isV11b3 ? ['meta','dna','decisions','state'] : ['meta','core','ledger','runtime'];
  if (!reqB3.every(k => p3[k])) return;

  const b3bytes = new TextEncoder().encode(jsonCand).length;
  if (b3bytes > MAX_JSON_BYTES) {
    seenBlocks.add(b3start + ':' + b3end);
    showToast('JSON >500KB — захват отменён', 'error'); stopCapture(); setBadge('ERROR'); return;
  }
  _saveAndStop(jsonCand, p3);
}

// ── Внутренние хелперы ───────────────────────────────────
function _notSessionPort(parsed) {
  return String(parsed?.meta?.protocol || '').trim().toLowerCase() !== 'sessionport';
}


function _isTemplatePlaceholder(parsed) {
  if (parsed?.dna?.goal?.endsWith('(глагол+задача+приоритет)')) return true;
  if (parsed?.state?.current_task === '…') return true;
  if (parsed?.state?.next_step    === '…') return true;
  const d = parsed?.decisions;
  if (Array.isArray(d) && d.length > 0 && d.every(x => x.what === '…' || x.what === '...')) return true;
  if (parsed?.core?.intent === 'инструкция-продолжение (глагол+задача+приоритет)') return true;
  if (parsed?.runtime?.current_status === '…') return true;
  return false;
}

function _saveAndStop(jsonStr, parsed) {
  const b64 = utf8ToBase64(jsonStr);
  // Preserve existing mode/step — don't overwrite with null/0
  chrome.storage.local.get(['flow_state'], res => {
    const prev = res.flow_state || {};
    chrome.storage.local.set({
      flow_state: {
        status: 'READY_TO_INJECT',
        payload: b64,
        source_host: location.hostname,
        mode: prev.mode || null,
        step: prev.step || 0
      }
    });
  });
  safeSendMessage({ action: 'SAVE_SNAPSHOT', payload: parsed, source_host: location.hostname },
    (response) => {
      if (!response?.success && response?.code === 'QUOTA_EXCEEDED') {
        showToast('Хранилище заполнено — удалите старые слепки', 'error');
      }
    }
  );
  stopCapture(); setBadge('READY'); showToast('Контекст захвачен!', 'success');
}

// ── JSON cleaner ─────────────────────────────────────────
function cleanJsonCandidate(raw) {
  let s = raw.trim();
  s = s.replace(/^```(?:json)?\s*\n?/i, '').replace(/\n?```\s*$/i, '');
  s = s.replace(/^json\s*\n?/i, '');
  s = s.replace(/[\uFEFF\u200B\u200C\u200D\u2060]/g, '');
  // Grok/innerText вставляет голые \n внутри JSON-строк — экранируем
  s = s.replace(/"([^"\\]*(?:\\.[^"\\]*)*)"/g, (match, content) => {
    return '"' + content
      .replace(/\n/g, '\\n')
      .replace(/\r/g, '\\r')
      .replace(/\t/g, '\\t') + '"';
  });
  return s.trim();
}

// ── Transfer prompt builder ──────────────────────────────
function buildTransferPrompt(json) {
  return `ПРОТОКОЛ SessionPort — ВОССТАНОВЛЕНИЕ КОНТЕКСТА.\n\nПрочитай слепок послойно и восстанови рабочий контекст:\n1. meta + dna — прими как идентичность проекта (цель, язык, стиль, ограничения)\n2. decisions — запомни все. type:"rejected" — никогда не предлагай повторно, причина в "why"\n3. state — продолжай отсюда. state.next_step — твоё первое действие\n4. instructions — следуй как собственным правилам\n5. implicit (если есть) — откалибруй стиль и детальность по user_profile; assumptions с confidence:low — уточни у пользователя\n\nПосле загрузки ответь на вопросы из validation.questions. Ответы должны соответствовать validation.expected — если нет, перечитай слепок.\n\n---BEGIN CONTEXT---\n${json}\n---END CONTEXT---`;
}

// ── Paste: wait for editor and inject ───────────────────
let injectObserver = null;
let injectTimeout  = null;

async function waitForEditorAndInject(b64) {
  if (injectObserver) { injectObserver.disconnect(); injectObserver = null; }
  clearTimeout(injectTimeout); injectTimeout = null;

  const input = getAdapter()?.findInput() || document.querySelector(SELECTORS.INPUTS);
  if (input) {
    const ok = await injectContext(buildTransferPrompt(base64ToUtf8(b64)));
    if (ok) {
      chrome.storage.local.set({ flow_state: { status: 'IDLE', payload: null, mode: null, step: 0 } });
      setBadge('IDLE');
    }
    return;
  }

  injectObserver = new MutationObserver((_, obs) => {
    const el = getAdapter()?.findInput() || document.querySelector(SELECTORS.INPUTS);
    if (!el) return;
    obs.disconnect(); injectObserver = null;
    clearTimeout(injectTimeout); injectTimeout = null;
    injectContext(buildTransferPrompt(base64ToUtf8(b64))).then(ok => {
      if (ok) {
        chrome.storage.local.set({ flow_state: { status: 'IDLE', payload: null, mode: null, step: 0 } });
        setBadge('IDLE');
      }
    });
  });
  injectObserver.observe(document.body, { childList: true, subtree: true });
  injectTimeout = setTimeout(() => {
    injectTimeout = null;
    if (injectObserver) { injectObserver.disconnect(); injectObserver = null; }
    showToast('Редактор не найден за 15с', 'error'); setBadge('ERROR');
  }, 15_000);
}
