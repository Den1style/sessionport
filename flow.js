/**
 * SessionPort — flow.js
 * Simple и Extended transfer flow.
 * Зависимости: popup-utils.js (setStatus, setStepState, setChecklistProgress,
 *              setProgress, saveStep, guard, sendToContentScript, base64ToUtf8)
 *              Подключается после popup-utils.js и popup.html (DOM ready).
 */

// ── Watcher handles (module-level) — prevents zombie intervals ──
let _simpleWatcherInterval  = null;
let _extendedWatcherInterval = null;

// ── Ссылки на кнопки ──────────────────────────────────────
const btnSimple1 = document.getElementById('btnSimple1');
const btnSimple2 = document.getElementById('btnSimple2');
const btnSimple3 = document.getElementById('btnSimple3');
const btnExt1    = document.getElementById('btnExt1');
const btnExt2    = document.getElementById('btnExt2');
const btnExt3    = document.getElementById('btnExt3');
const btnExt4    = document.getElementById('btnExt4');
const btnPaste   = document.getElementById('btnPaste');

// ═══════════════════════════════════════════════════════════
// ПЕРЕКЛЮЧАТЕЛЬ РЕЖИМА: Simple ↔ Extended
// ═══════════════════════════════════════════════════════════

function switchTransferMode(mode) {
  const simple   = document.getElementById('sectionSimple');
  const extended = document.getElementById('sectionExtended');
  const tabS     = document.getElementById('tabSimple');
  const tabE     = document.getElementById('tabExtended');
  if (!simple || !extended) return;

  if (mode === 'simple') {
    simple.classList.add('open');
    extended.classList.remove('open');
    tabS?.classList.add('active-simple');    tabS?.classList.remove('active-ext');
    tabE?.classList.remove('active-simple'); tabE?.classList.remove('active-ext');
  } else {
    extended.classList.add('open');
    simple.classList.remove('open');
    tabE?.classList.add('active-ext');       tabE?.classList.remove('active-simple');
    tabS?.classList.remove('active-simple'); tabS?.classList.remove('active-ext');
  }
}

// ═══════════════════════════════════════════════════════════
// СБРОС СОСТОЯНИЯ ПЕРЕНОСА
// ═══════════════════════════════════════════════════════════
function resetFlowState() {
  // Остановить watcher если запущен
  if (_simpleWatcherInterval)   { clearInterval(_simpleWatcherInterval);   _simpleWatcherInterval = null; }
  if (_extendedWatcherInterval) { clearInterval(_extendedWatcherInterval); _extendedWatcherInterval = null; }
  // Остановить captureNow timer если запущен
  if (_captureNowTimer) { clearTimeout(_captureNowTimer); _captureNowTimer = null; }
  // Скрыть overlay если показан
  if (_overlayCountdown) { clearTimeout(_overlayCountdown); _overlayCountdown = null; }
  ['overlaySimple', 'overlayExtended'].forEach(id => {
    const el = document.getElementById(id);
    if (el) { el.style.display = 'none'; el.onclick = null; }
  });
  // Сброс storage — transfer_id очистится через flow_state status=IDLE
  chrome.storage.local.set({ flow_state: { status: 'IDLE', payload: null, mode: null, step: 0, transfer_id: null } });
  const _scanBtn = document.getElementById('btnScanNow'); if (_scanBtn) _scanBtn.style.display = 'none';
  // Сброс UI всех шагов
  ['btnSimple1','btnSimple2','btnExt1','btnExt2','btnExt3','btnSimple3','btnExt4'].forEach(id => setStepState(id, 'wait'));
  // Сброс итераций шага 2 расширенного переноса
  _ext2Iterations = 0;
  const ext2Hint = document.querySelector('#btnExt2 .step-hint');
  if (ext2Hint) ext2Hint.textContent = PR_i18n.t('ext.step2.hint');
  // Шаг 1 обоих режимов — активен сразу, остальные dimmed
  document.getElementById('btnSimple1')?.classList.remove('dimmed');
  document.getElementById('btnExt1')?.classList.remove('dimmed');
  // Шаги 2+ остаются dimmed до прохождения предыдущего
  setChecklistProgress('checklistSimple', 0);
  setChecklistProgress('checklistExtended', 0);
  // Сброс обоих прогресс-баров (простой и расширенный)
  ['progressWrap', 'progressWrapExt'].forEach(id => {
    const w = document.getElementById(id);
    if (w) w.classList.remove('show');
  });
  ['progressBar', 'progressBarExt'].forEach(id => {
    const b = document.getElementById(id);
    if (b) b.style.width = '0%';
  });
  // Скрыть paste panel и деактивировать dropzone
  hidePastePanel();
  if (typeof updateDropzoneState === 'function') updateDropzoneState(false);
  if (typeof renderFiles === 'function') renderFiles([]);
  setStatus(PR_i18n.t('status.reset'), 'working');
}

document.getElementById('btnResetFlow')?.addEventListener('click', () => {
  resetFlowState();
});

document.getElementById('tabSimple')?.addEventListener('click',   () => switchTransferMode('simple'));
document.getElementById('tabExtended')?.addEventListener('click', () => switchTransferMode('extended'));

// ═══════════════════════════════════════════════════════════
// TRANSFER SESSION — UUID lifecycle
// ═══════════════════════════════════════════════════════════

// Begin a new transfer session: generate UUID, persist to flow_state,
// resolve parent_transfer_id from last captured snapshot. Returns {transfer_id, parent}.
async function _beginNewTransferSession(mode, step) {
  const transfer_id = generateTransferId();
  const parent      = await getLastTransferId();
  await new Promise(r => chrome.storage.local.get(['flow_state'], res => {
    const state = res.flow_state || {};
    chrome.storage.local.set({ flow_state: {
      status:      'IDLE',
      payload:     null,
      source_host: null,
      transfer_id,
      mode,
      step
    }}, r);
  }));
  return { transfer_id, parent };
}

// Get current session UUID from flow_state. Throws if missing — never call before _beginNewTransferSession.
async function _currentTransferId() {
  return new Promise(r => chrome.storage.local.get(['flow_state'], res => {
    r(res.flow_state?.transfer_id || null);
  }));
}

async function _currentParentTransferId() {
  // parent is stable for whole session — re-resolve here so it always reflects last captured
  return await getLastTransferId();
}

// ═══════════════════════════════════════════════════════════
// ПРОСТОЙ ПЕРЕНОС
// ═══════════════════════════════════════════════════════════

btnSimple1?.addEventListener('click', () => guard(btnSimple1, async () => {
  setStepState('btnSimple1', 'active');
  setProgress(10, PR_i18n.t('status.injecting'));
  // New session — generate transfer_id, resolve parent
  const { transfer_id } = await _beginNewTransferSession('simple', 0);
  const ok = await sendToContentScript('INJECT_PROMPT', { text: PROMPTS.SIMPLE_ANALYZE(transfer_id) });
  if (ok) {
    setStepState('btnSimple1', 'done');
    setStepState('btnSimple2', 'wait');
    setChecklistProgress('checklistSimple', 1);
    saveStep('simple', 1);
    btnSimple2?.classList.remove('dimmed');
    setProgress(33, PR_i18n.t('status.step1_done'));
  } else {
    setStepState('btnSimple1', 'wait');
    setProgress(0);
  }
}));

btnSimple2?.addEventListener('click', () => guard(btnSimple2, async () => {
  setProgress(50, PR_i18n.t('status.step2_start'));
  const transfer_id = await _currentTransferId();
  if (!transfer_id) { setProgress(33, PR_i18n.t('status.no_session')); return; }
  const parent = await _currentParentTransferId();
  // Pass transfer_id to content-script — it will validate captured JSON against this UUID
  await sendToContentScript('SET_EXPECTED_TRANSFER_ID', { transfer_id });
  const ok = await sendToContentScript('INJECT_PROMPT', { text: PROMPTS.SIMPLE_CONFIRM(transfer_id, parent) });
  if (!ok) { setProgress(33); return; }
  saveStep('simple', 2);
  await sendToContentScript('START_CAPTURE');
  _captureNowTimer = setTimeout(() => sendToContentScript('CAPTURE_NOW').catch(() => {}), 5000);
  _startSimpleWatcher();
}));

let _captureNowTimer = null; // глобальный таймер раннего CAPTURE_NOW

function _startSimpleWatcher() {
  // FIX: clear any previous watcher before starting new one
  if (_simpleWatcherInterval) { clearInterval(_simpleWatcherInterval); _simpleWatcherInterval = null; }
  // Показываем кнопку ручного захвата — шаг 2 запущен
  const _sb = document.getElementById('btnScanNow'); if (_sb) _sb.style.display = '';
  setProgress(66, PR_i18n.t('status.waiting_model'));
  let checks = 0;
  _simpleWatcherInterval = setInterval(() => {
    checks++;
    chrome.storage.local.get('flow_state', r => {
      if (r.flow_state?.status === 'READY_TO_INJECT') {
        clearInterval(_simpleWatcherInterval); _simpleWatcherInterval = null;
        clearTimeout(_captureNowTimer); _captureNowTimer = null;
        const _sbS = document.getElementById('btnScanNow'); if (_sbS) _sbS.style.display = 'none';
        setProgress(100, PR_i18n.t('status.captured'));
        setTimeout(() => setProgress(0), 2000);
        setStepState('btnSimple2', 'done');
        setStepState('btnSimple3', 'wait');
        setChecklistProgress('checklistSimple', 2);
        btnSimple3?.classList.remove('dimmed');
        if (typeof loadAttachedFiles === 'function') loadAttachedFiles();
        setStatus(PR_i18n.t('status.captured_add'), 'active');
      } else if (checks === 60) {
        sendToContentScript('CAPTURE_NOW').catch(() => {});
      } else if (checks > 150) {
        clearInterval(_simpleWatcherInterval); _simpleWatcherInterval = null;
        setProgress(0);
        setStatus(PR_i18n.t('status.timeout'), 'error');
        saveStep('simple', 1);
      }
    });
  }, 800);
}

// ═══════════════════════════════════════════════════════════
// РАСШИРЕННЫЙ ПЕРЕНОС
// ═══════════════════════════════════════════════════════════

btnExt1?.addEventListener('click', () => guard(btnExt1, async () => {
  setStepState('btnExt1', 'active');
  setProgress(10, PR_i18n.t('status.injecting'));
  const { transfer_id } = await _beginNewTransferSession('extended', 0);
  const ok = await sendToContentScript('INJECT_PROMPT', { text: PROMPTS.EXTENDED_PREPARE(transfer_id) });
  if (ok) {
    setStepState('btnExt1', 'done');
    setStepState('btnExt2', 'wait');
    setChecklistProgress('checklistExtended', 1);
    saveStep('extended', 1);
    btnExt2?.classList.remove('dimmed');
    setProgress(25, PR_i18n.t('status.ext1_done'));
  } else {
    setStepState('btnExt1', 'wait');
    setProgress(0);
  }
}));

let _ext2Iterations = 0;

btnExt2?.addEventListener('click', () => guard(btnExt2, async () => {
  _ext2Iterations++;
  setStepState('btnExt2', 'active');
  setProgress(35, PR_i18n.t('status.ext2_start', { n: _ext2Iterations }));
  const transfer_id = await _currentTransferId();
  if (!transfer_id) { setProgress(25, PR_i18n.t('status.no_session')); setStepState('btnExt2','wait'); return; }
  const ok = await sendToContentScript('INJECT_PROMPT', { text: PROMPTS.EXTENDED_ANCHORS(transfer_id) });
  if (ok) {
    // Не ставим done — кнопка остаётся кликабельной для повторной проверки
    setStepState('btnExt2', 'active');
    setChecklistProgress('checklistExtended', 2);
    saveStep('extended', 2);
    // Разблокируем шаг 3, но шаг 2 тоже доступен
    btnExt3?.classList.remove('dimmed');
    // Обновляем hint кнопки
    const hint = btnExt2.querySelector('.step-hint');
    if (hint) hint.textContent = PR_i18n.t('status.ext2_hint', { n: _ext2Iterations });
    setProgress(50, PR_i18n.t('status.ext2_done', { n: _ext2Iterations }));
  } else {
    setStepState('btnExt2', 'wait');
    setProgress(25);
  }
}));

btnExt3?.addEventListener('click', () => guard(btnExt3, async () => {
  setStepState('btnExt2', 'done');  // Якоря завершены, переходим к генерации
  setStepState('btnExt3', 'active');
  setProgress(60, PR_i18n.t('status.ext3_start'));
  const transfer_id = await _currentTransferId();
  if (!transfer_id) { setProgress(50, PR_i18n.t('status.no_session2')); setStepState('btnExt3','wait'); return; }
  const parent = await _currentParentTransferId();
  await sendToContentScript('SET_EXPECTED_TRANSFER_ID', { transfer_id });
  const ok = await sendToContentScript('INJECT_PROMPT', { text: PROMPTS.EXTENDED_TRANSFER(transfer_id, parent) });
  if (!ok) { setStepState('btnExt3', 'wait'); setProgress(50); return; }
  setStepState('btnExt3', 'done');
  setChecklistProgress('checklistExtended', 3);
  saveStep('extended', 3);
  await sendToContentScript('START_CAPTURE');
  _captureNowTimer = setTimeout(() => sendToContentScript('CAPTURE_NOW').catch(() => {}), 5000);
  _startExtendedWatcher();
}));

function _startExtendedWatcher() {
  // FIX: clear any previous watcher before starting new one
  if (_extendedWatcherInterval) { clearInterval(_extendedWatcherInterval); _extendedWatcherInterval = null; }
  setProgress(75, PR_i18n.t('status.waiting_json'));
  const _scanBtn2 = document.getElementById('btnScanNow'); if (_scanBtn2) _scanBtn2.style.display = '';
  let checks = 0;
  _extendedWatcherInterval = setInterval(() => {
    checks++;
    chrome.storage.local.get('flow_state', r => {
      if (r.flow_state?.status === 'READY_TO_INJECT') {
        clearInterval(_extendedWatcherInterval); _extendedWatcherInterval = null;
        clearTimeout(_captureNowTimer); _captureNowTimer = null;
        const _sbE = document.getElementById('btnScanNow'); if (_sbE) _sbE.style.display = 'none';
        setProgress(100, PR_i18n.t('status.captured4'));
        setTimeout(() => setProgress(0), 2000);
        setStepState('btnExt3', 'done');
        setStepState('btnExt4', 'wait');
        setChecklistProgress('checklistExtended', 3);
        btnExt4?.classList.remove('dimmed');
        if (typeof loadAttachedFiles === 'function') loadAttachedFiles();
        setStatus(PR_i18n.t('status.captured_add'), 'active');
      } else if (checks === 60) {
        // После 60 тиков (~48с) — пробуем CAPTURE_NOW на случай если JSON уже в DOM
        sendToContentScript('CAPTURE_NOW').catch(() => {});
      } else if (checks > 150) {
        clearInterval(_extendedWatcherInterval); _extendedWatcherInterval = null;
        setProgress(0);
        setStatus(PR_i18n.t('status.timeout'), 'error');
        saveStep('extended', 3);
      }
    });
  }, 800);
}

// ═══════════════════════════════════════════════════════════
// СОХРАНИТЬ ПЕРЕНОС (shared for Simple step 3 / Extended step 4)
// ═══════════════════════════════════════════════════════════

let _overlayCountdown = null;

function _showSuccessOverlay(checklistId, wasCommitted = false) {
  // Determine overlay element from checklist
  const overlayId = checklistId === 'checklistSimple' ? 'overlaySimple' : 'overlayExtended';
  const overlay = document.getElementById(overlayId);
  if (!overlay) return;

  // Clear previous
  if (_overlayCountdown) { clearTimeout(_overlayCountdown); _overlayCountdown = null; }

  overlay.style.display = 'flex';

  // Auto-dismiss after 5 sec
  _overlayCountdown = setTimeout(() => {
    _dismissOverlay(overlayId, wasCommitted);
  }, 5000);

  // Click to dismiss immediately
  overlay.onclick = () => _dismissOverlay(overlayId, wasCommitted);
}

function _resetStepsToInitial() {
  ['btnSimple1','btnSimple2','btnSimple3','btnExt1','btnExt2','btnExt3','btnExt4']
    .forEach(id => setStepState(id, 'wait'));
  _ext2Iterations = 0;
  const ext2Hint = document.querySelector('#btnExt2 .step-hint');
  if (ext2Hint) ext2Hint.textContent = PR_i18n.t('ext.step2.hint');
  document.getElementById('btnSimple1')?.classList.remove('dimmed');
  document.getElementById('btnExt1')?.classList.remove('dimmed');
  setChecklistProgress('checklistSimple', 0);
  setChecklistProgress('checklistExtended', 0);
  const _sb = document.getElementById('btnScanNow'); if (_sb) _sb.style.display = 'none';
}

function _dismissOverlay(overlayId, wasCommitted = false) {
  const overlay = document.getElementById(overlayId || 'overlaySimple');
  if (overlay) { overlay.style.display = 'none'; overlay.onclick = null; }
  if (_overlayCountdown) { clearTimeout(_overlayCountdown); _overlayCountdown = null; }

  // Сбрасываем оба прогресс-бара
  ['progressWrap', 'progressWrapExt'].forEach(id => {
    const w = document.getElementById(id);
    if (w) { w.classList.remove('show'); }
  });
  ['progressBar', 'progressBarExt'].forEach(id => {
    const b = document.getElementById(id);
    if (b) { b.style.width = '0%'; }
  });

  if (wasCommitted) {
    // Commit already cleared flow_state — reset steps unconditionally
    _resetStepsToInitial();
    showPastePanel();
    setStatus(PR_i18n.t('status.paste_ready'), 'active');
  } else {
    chrome.storage.local.get(['flow_state'], res => {
      const state = res.flow_state || {};
      if (state.status === 'READY_TO_INJECT' && state.payload) {
        _resetStepsToInitial();
        showPastePanel();
        setStatus(PR_i18n.t('status.paste_ready'), 'active');
      }
    });
  }
}

// Remove old btnDismissOverlay listener (element no longer exists)

async function _commitTransfer(doneBtnId, checklistId, stepCount) {
  setStepState(doneBtnId, 'done');
  setChecklistProgress(checklistId, stepCount);
  setStatus(PR_i18n.t('status.saving'), 'working');

  // 1. Update history counter + storage bar
  try {
    const snaps = await SessionPortDB.listAll({ limit: 0, fields: ['size_bytes'] });
    const el = document.getElementById('histCount');
    if (el) el.textContent = snaps.length;
    if (typeof _updateStorageBar === 'function') _updateStorageBar(snaps);
  } catch (_) {}

  // 2. Files already attached in DB — clear visual list and deactivate dropzone
  if (typeof renderFiles === 'function') renderFiles([]);
  if (typeof updateDropzoneState === 'function') updateDropzoneState(false);

  // 3. Fill snap card with payload data
  if (typeof _fillSnapCard === 'function') await _fillSnapCard();

  // 4. Сброс flow_state и active_snapshot_id — перенос завершён.
  //    active_snapshot_id = null чтобы "Захват вручную" не показывал файлы старого снапшота.
  chrome.storage.local.set({
    flow_state: { status: 'IDLE', payload: null, mode: null, step: 0, transfer_id: null }
  });
  chrome.runtime.sendMessage({ action: 'SET_ACTIVE', snapshot_id: null }, () => {
    if (chrome.runtime.lastError) console.warn('[PR] SET_ACTIVE null:', chrome.runtime.lastError.message);
  });
  // 5. Show success overlay on checklist (5 sec) — paste panel after dismiss
  _showSuccessOverlay(checklistId, true);
  setStatus(PR_i18n.t('status.saved'), 'active');
}

btnSimple3?.addEventListener('click', () => guard(btnSimple3, async () => {
  saveStep('simple', 3);
  await _commitTransfer('btnSimple3', 'checklistSimple', 3);
}));

btnExt4?.addEventListener('click', () => guard(btnExt4, async () => {
  saveStep('extended', 4);
  await _commitTransfer('btnExt4', 'checklistExtended', 4);
}));

// ═══════════════════════════════════════════════════════════
// ВСТАВКА (PASTE)
// ═══════════════════════════════════════════════════════════

btnPaste?.addEventListener('click', async () => {
  setStatus(PR_i18n.t('status.pasting'), 'working');
  const ok = await sendToContentScript('PASTE_CONTEXT');
  if (!ok) {
    setStatus(PR_i18n.t('status.paste_fail'), 'error');
    return;
  }

  const activeId = await new Promise(r =>
    chrome.runtime.sendMessage({ action: 'GET_ACTIVE' }, resp => r(resp?.snapshot_id)));
  if (!activeId) { setStatus(PR_i18n.t('status.pasted'), 'active'); return; }

  setStatus(PR_i18n.t('status.attaching'), 'working');

  chrome.runtime.sendMessage({ action: 'INJECT_FILES', snapshot_id: activeId }, resp => {
    if (resp?.success) {
      const n = resp.injected || 0;
      setStatus(n > 0 ? PR_i18n.t('status.pasted_n', { n }) : PR_i18n.t('status.pasted'), 'active');
    } else {
      setStatus(PR_i18n.t('status.paste_no_files'), 'error');
    }
  });
});

document.getElementById('btnPasteContextOnly')?.addEventListener('click', async () => {
  setStatus(PR_i18n.t('status.pasting_ctx'), 'working');
  const ok = await sendToContentScript('PASTE_CONTEXT');
  if (ok) setStatus(PR_i18n.t('status.pasted'), 'active');
  else    setStatus(PR_i18n.t('status.paste_fail2'), 'error');
});

document.getElementById('btnCopyJSON')?.addEventListener('click', () => {
  chrome.storage.local.get(['flow_state'], res => {
    if (!res.flow_state?.payload) { setStatus(PR_i18n.t('status.buf_empty'), 'error'); return; }
    try {
      const json = PR_Utils.base64ToUtf8(res.flow_state.payload);
      const isEn = PR_i18n.lang === 'en';
      const prompt = isEn
        ? 'SessionPort PROTOCOL — CONTEXT RESTORATION.\n\n' +
          'Read the snapshot layer by layer and restore the working context:\n' +
          '1. meta + dna — accept as project identity (goal, language, style, constraints)\n' +
          '2. decisions — memorize all. type:"rejected" — never suggest again, reason is in "why"\n' +
          '3. state — continue from here. state.next_step — your first action\n' +
          '4. instructions — follow as your own rules\n' +
          '5. open_threads (if present) — unresolved questions; keep them live, do not treat them as closed\n' +
          '6. implicit (if present): calibrate style and detail from user_profile; honor adaptation_log — do not re-suggest what the user already abandoned; assumptions by confidence — low: do not act silently, ask first; medium: act but flag the assumption in your first reply; high: accept as fact\n\n' +
          'After loading, answer the questions from validation.questions. Answers must match validation.expected — if not, re-read the snapshot.\n\n' +
          '---BEGIN CONTEXT---\n' + json + '\n---END CONTEXT---'
        : 'ПРОТОКОЛ SessionPort — ВОССТАНОВЛЕНИЕ КОНТЕКСТА.\n\n' +
          'Прочитай слепок послойно и восстанови рабочий контекст:\n' +
          '1. meta + dna — прими как идентичность проекта (цель, язык, стиль, ограничения)\n' +
          '2. decisions — запомни все. type:"rejected" — никогда не предлагай повторно, причина в "why"\n' +
          '3. state — продолжай отсюда. state.next_step — твоё первое действие\n' +
          '4. instructions — следуй как собственным правилам\n' +
          '5. open_threads (если есть) — нерешённые вопросы; держи их в работе, не считай закрытыми\n' +
          '6. implicit (если есть): откалибруй стиль и детальность по user_profile; соблюдай adaptation_log — не предлагай заново то, от чего пользователь уже отказался; assumptions по confidence — low: не действуй молча, сначала уточни; medium: действуй, но отметь допущение в первом ответе; high: прими как факт\n\n' +
          'После загрузки ответь на вопросы из validation.questions. Ответы должны соответствовать validation.expected — если нет, перечитай слепок.\n\n' +
          '---BEGIN CONTEXT---\n' + json + '\n---END CONTEXT---';
      navigator.clipboard.writeText(prompt)
        .then(() => setStatus(PR_i18n.t('status.copied'), 'active'))
        .catch(() => setStatus(PR_i18n.t('status.copy_fail'), 'error'));
    } catch (e) { setStatus(PR_i18n.t('status.decode_err'), 'error'); }
  });
});

// ═══════════════════════════════════════════════════════════
// ВОССТАНОВЛЕНИЕ STATE ПРИ ОТКРЫТИИ POPUP
// ═══════════════════════════════════════════════════════════
function restoreFlowState() {
  chrome.storage.local.get(['flow_state'], res => {
    const state = res.flow_state || {};
    if (state.mode === 'simple') {
      switchTransferMode('simple');
      if (state.step >= 1) btnSimple2?.classList.remove('dimmed');
      if (state.step === 2 && state.status !== 'READY_TO_INJECT') {
        // Popup was closed while waiting for capture — JSON may already be in DOM
        // Use CAPTURE_NOW (clears seenBlocks) so existing blocks are scanned too
        setStatus(PR_i18n.t('status.reconnecting'), 'working');
        sendToContentScript('CAPTURE_NOW').catch(() => {});
        _startSimpleWatcher();
      }
    } else if (state.mode === 'extended') {
      switchTransferMode('extended');
      if (state.step >= 1) {
        setStepState('btnExt1', 'done');
        btnExt2?.classList.remove('dimmed');
      }
      if (state.step >= 2) {
        // Шаг 2 остаётся active (не done) — можно повторять
        setStepState('btnExt2', 'active');
        btnExt3?.classList.remove('dimmed');
      }
      if (state.step === 3 && state.status !== 'READY_TO_INJECT') {
        // Popup was closed while waiting for capture — JSON may already be in DOM
        setStatus(PR_i18n.t('status.reconnecting'), 'working');
        sendToContentScript('CAPTURE_NOW').catch(() => {});
        _startExtendedWatcher();
      }
    }
    // Bug-2: paste уже выполнена — восстанавливаем paste-panel для повторной вставки
    if (state.status === 'PASTED') {
      showPastePanel();
      setStatus(PR_i18n.t('status.pasted_again'), 'active');
      return;
    }

    if (state.status === 'READY_TO_INJECT') {
      if (state.mode === 'simple' && state.step >= 3) {
        // Commit already done — show paste panel directly
        setStepState('btnSimple1', 'done');
        setStepState('btnSimple2', 'done');
        setStepState('btnSimple3', 'done');
        setChecklistProgress('checklistSimple', 3);
        showPastePanel();
        setStatus(PR_i18n.t('status.paste_ready'), 'active');
      } else if (state.mode === 'extended' && state.step >= 4) {
        // Commit already done — show paste panel directly
        setStepState('btnExt1', 'done');
        setStepState('btnExt2', 'done');
        setStepState('btnExt3', 'done');
        setStepState('btnExt4', 'done');
        setChecklistProgress('checklistExtended', 4);
        showPastePanel();
        setStatus(PR_i18n.t('status.paste_ready'), 'active');
      } else if (state.mode === 'simple') {
        // Capture completed — show save button
        setStepState('btnSimple1', 'done');
        setStepState('btnSimple2', 'done');
        btnSimple3?.classList.remove('dimmed');
        setChecklistProgress('checklistSimple', 2);
        if (typeof loadAttachedFiles === 'function') loadAttachedFiles();
        setStatus(PR_i18n.t('status.captured_add'), 'active');
      } else if (state.mode === 'extended') {
        setStepState('btnExt1', 'done');
        setStepState('btnExt2', 'done');
        setStepState('btnExt3', 'done');
        btnExt4?.classList.remove('dimmed');
        setChecklistProgress('checklistExtended', 3);
        if (typeof loadAttachedFiles === 'function') loadAttachedFiles();
        setStatus(PR_i18n.t('status.captured_add'), 'active');
      }
    }
  });
}

restoreFlowState();

// ── Ручной захват ─────────────────────────────────────────
document.getElementById('btnScanNow')?.addEventListener('click', async () => {
  setStatus(PR_i18n.t('status.scanning'), 'working');
  const ok = await sendToContentScript('CAPTURE_NOW');
  if (!ok) {
    setStatus(PR_i18n.t('status.conn_fail'), 'error');
    return;
  }
  // Poll for result — captureNow сканирует до 60с
  let checks = 0;
  const poll = setInterval(() => {
    checks++;
    chrome.storage.local.get('flow_state', r => {
      if (r.flow_state?.status === 'READY_TO_INJECT') {
        clearInterval(poll);
        setStatus(PR_i18n.t('status.json_captured'), 'active');
        showPastePanel();
      } else if (checks >= 75) {
        // 75 × 800мс = 60с — совпадает с captureNow timeout
        clearInterval(poll);
        setStatus(PR_i18n.t('status.json_not_found'), 'error');
      }
    });
  }, 800);
});

// ═══════════════════════════════════════════════════════════
// ТЕСТ — загружает тестовый слепок и файл без LLM
// ═══════════════════════════════════════════════════════════
document.getElementById('btnTest')?.addEventListener('click', async () => {
  setStatus(PR_i18n.t('status.test_loading'), 'working');

  try {
    const snapUrl  = chrome.runtime.getURL('test-snapshot.json');
    const fileUrl  = chrome.runtime.getURL('test-file.txt');

    const snapResp = await fetch(snapUrl);
    const snapJson = await snapResp.json();
    const fileResp = await fetch(fileUrl);
    const fileText = await fileResp.text();

    // Не пишем в DB — только flow_state (не засоряет историю).
    // Сбрасываем active_snapshot_id чтобы панель файлов не показывала файлы старого снапшота.
    chrome.runtime.sendMessage({ action: 'SET_ACTIVE', snapshot_id: null });
    const payload64 = PR_Utils.utf8ToBase64(JSON.stringify(snapJson));
    await new Promise(r => chrome.storage.local.set({
      flow_state: {
        status: 'READY_TO_INJECT',
        payload: payload64,
        source_host: 'test',
        mode: 'simple', step: 2,
        transfer_id: snapJson?.meta?.transfer_id || null,
        _test_file: { text: fileText, name: 'test-file.txt' }
      }
    }, r));

    setStatus(PR_i18n.t('status.pasting'), 'working');

    // Автовставка контекста в активную LLM-вкладку
    const ctxOk = await sendToContentScript('PASTE_CONTEXT');
    if (!ctxOk) {
      setStatus(PR_i18n.t('status.test_no_llm'), 'error');
      showPastePanel('status.test_warn');
      return;
    }

    setStatus(PR_i18n.t('status.test_attaching'), 'working');

    // Пауза — даём Claude время обработать вставку контекста
    await new Promise(r => setTimeout(r, 800));

    // Стейджим файл в storage и шлём через MAIN world
    const b64 = btoa(unescape(encodeURIComponent(fileText)));
    const dragId = 'pr-test-file-' + Date.now();
    await new Promise(r => chrome.storage.local.set({
      ['pr_drag_file_' + dragId]: {
        drag_id: dragId,
        filename: 'test-file.txt',
        mime: 'text/plain',
        size_bytes: fileText.length,
        content_b64: b64
      }
    }, r));

    // Push файл в активную LLM-вкладку через PUSH_DRAG_FILE
    await sendToContentScript('PUSH_DRAG_FILE_DIRECT', { drag_id: dragId });

    // Cleanup staged key через 10с
    setTimeout(() => chrome.storage.local.remove('pr_drag_file_' + dragId), 10_000);

    setStatus(PR_i18n.t('status.test_done'), 'active');

  } catch (err) {
    setStatus(PR_i18n.t('status.test_err') + err.message, 'error');
    console.error('[PR-test]', err);
  }
});
