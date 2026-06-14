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
      // Layer-by-layer restoration instructions in all 9 UI languages.
      // Kept in sync with buildTransferPrompt() in capture.js / content-bundle.js
      // (the content world cannot share scope with the popup on LLM pages).
      const RESTORE_INTRO = {
        en: `SessionPort PROTOCOL — CONTEXT RESTORATION.

Read the snapshot layer by layer and restore the working context:
1. meta + dna — accept as project identity (goal, language, style, constraints, trajectory — where the project is heading)
2. decisions — memorize all. type:"rejected" — never suggest again, the reason is in "why"
3. state — continue from here. state.next_step — your first action
4. instructions — follow as your own rules
5. open_threads (if present) — unresolved questions; keep them live, do not treat them as closed
6. implicit (if present): calibrate style and detail from user_profile; honor adaptation_log — do not re-suggest what the user already abandoned; assumptions by confidence — low: do not act silently, ask first; medium: act but flag the assumption in your first reply; high: accept as fact

Rely only on the snapshot. If something needed for the next step is missing, ask — do not invent it.

First, in one line, confirm where we left off: goal + next step. Then answer the questions from validation.questions — answers must match validation.expected; if not, re-read the snapshot. After that, continue the work.`,
        ru: `ПРОТОКОЛ SessionPort — ВОССТАНОВЛЕНИЕ КОНТЕКСТА.

Прочитай слепок послойно и восстанови рабочий контекст:
1. meta + dna — прими как идентичность проекта (цель, язык, стиль, ограничения, trajectory — куда движется проект)
2. decisions — запомни все. type:"rejected" — никогда не предлагай повторно, причина в "why"
3. state — продолжай отсюда. state.next_step — твоё первое действие
4. instructions — следуй как собственным правилам
5. open_threads (если есть) — нерешённые вопросы; держи их в работе, не считай закрытыми
6. implicit (если есть): откалибруй стиль и детальность по user_profile; соблюдай adaptation_log — не предлагай заново то, от чего пользователь уже отказался; assumptions по confidence — low: не действуй молча, сначала уточни; medium: действуй, но отметь допущение в первом ответе; high: прими как факт

Опирайся только на данные слепка. Если для следующего шага чего-то не хватает — спроси, не выдумывай.

Сначала одной строкой подтверди, где мы остановились: цель + следующий шаг. Затем ответь на вопросы из validation.questions — ответы должны соответствовать validation.expected; если нет, перечитай слепок. После этого продолжай работу.`,
        de: `SessionPort PROTOKOLL — KONTEXT-WIEDERHERSTELLUNG.

Lies den Snapshot Schicht für Schicht und stelle den Arbeitskontext wieder her:
1. meta + dna — als Projektidentität übernehmen (Ziel, Sprache, Stil, Einschränkungen, trajectory — wohin sich das Projekt bewegt)
2. decisions — alle merken. type:"rejected" — nie wieder vorschlagen, der Grund steht in "why"
3. state — hier fortfahren. state.next_step — deine erste Aktion
4. instructions — als eigene Regeln befolgen
5. open_threads (falls vorhanden) — ungelöste Fragen; halte sie aktiv, betrachte sie nicht als abgeschlossen
6. implicit (falls vorhanden): Stil und Detailgrad aus user_profile kalibrieren; adaptation_log beachten — schlage nicht erneut vor, was der Nutzer bereits aufgegeben hat; assumptions nach confidence — low: nicht stillschweigend handeln, erst nachfragen; medium: handeln, aber die Annahme in deiner ersten Antwort kennzeichnen; high: als Fakt akzeptieren

Stütze dich nur auf den Snapshot. Fehlt etwas für den nächsten Schritt — frage nach, erfinde nichts.

Bestätige zuerst in einer Zeile, wo wir stehen geblieben sind: Ziel + nächster Schritt. Beantworte dann die Fragen aus validation.questions — die Antworten müssen validation.expected entsprechen; falls nicht, lies den Snapshot erneut. Fahre danach mit der Arbeit fort.`,
        fr: `PROTOCOLE SessionPort — RESTAURATION DU CONTEXTE.

Lis le snapshot couche par couche et restaure le contexte de travail :
1. meta + dna — accepte comme identité du projet (objectif, langue, style, contraintes, trajectory — vers où va le projet)
2. decisions — mémorise toutes. type:"rejected" — ne plus jamais suggérer, la raison est dans "why"
3. state — continue à partir d'ici. state.next_step — ta première action
4. instructions — suis-les comme tes propres règles
5. open_threads (si présent) — questions non résolues ; garde-les actives, ne les considère pas comme closes
6. implicit (si présent) : calibre le style et le niveau de détail depuis user_profile ; respecte adaptation_log — ne re-suggère pas ce que l'utilisateur a déjà abandonné ; assumptions par confidence — low : n'agis pas en silence, demande d'abord ; medium : agis mais signale l'hypothèse dans ta première réponse ; high : accepte comme un fait

Appuie-toi uniquement sur le snapshot. S'il manque quelque chose pour l'étape suivante — demande, n'invente pas.

D'abord, en une ligne, confirme où nous en étions : objectif + prochaine étape. Puis réponds aux questions de validation.questions — les réponses doivent correspondre à validation.expected ; sinon, relis le snapshot. Ensuite, poursuis le travail.`,
        es: `PROTOCOLO SessionPort — RESTAURACIÓN DEL CONTEXTO.

Lee el snapshot capa por capa y restaura el contexto de trabajo:
1. meta + dna — acepta como identidad del proyecto (objetivo, idioma, estilo, restricciones, trajectory — hacia dónde va el proyecto)
2. decisions — memoriza todas. type:"rejected" — nunca volver a sugerir, la razón está en "why"
3. state — continúa desde aquí. state.next_step — tu primera acción
4. instructions — síguelas como tus propias reglas
5. open_threads (si está presente) — preguntas sin resolver; mantenlas activas, no las consideres cerradas
6. implicit (si está presente): calibra el estilo y el detalle desde user_profile; respeta adaptation_log — no vuelvas a sugerir lo que el usuario ya abandonó; assumptions por confidence — low: no actúes en silencio, pregunta primero; medium: actúa pero señala la suposición en tu primera respuesta; high: acéptalo como un hecho

Apóyate solo en el snapshot. Si falta algo para el siguiente paso — pregunta, no lo inventes.

Primero, en una línea, confirma dónde lo dejamos: objetivo + siguiente paso. Luego responde las preguntas de validation.questions — las respuestas deben coincidir con validation.expected; si no, vuelve a leer el snapshot. Después, continúa el trabajo.`,
        zh: `SessionPort 协议 — 上下文恢复。

逐层阅读快照并恢复工作上下文：
1. meta + dna — 作为项目身份接受（目标、语言、风格、约束、trajectory — 项目的走向）
2. decisions — 全部记住。type:"rejected" — 永不再建议，原因在 "why" 中
3. state — 从这里继续。state.next_step — 你的第一个动作
4. instructions — 作为你自己的规则遵守
5. open_threads（如果有）— 未解决的问题；保持其活跃，不要视为已关闭
6. implicit（如果有）：根据 user_profile 校准风格和详细程度；遵守 adaptation_log — 不要再次建议用户已经放弃的内容；assumptions 按 confidence — low：不要默默行动，先询问；medium：行动但在首次回复中标注该假设；high：作为事实接受

仅依据快照。如果下一步缺少所需信息 — 询问，不要编造。

首先用一行确认我们停在哪里：目标 + 下一步。然后回答 validation.questions 中的问题 — 答案必须符合 validation.expected；若不符，重新阅读快照。之后继续工作。`,
        ja: `SessionPort プロトコル — コンテキスト復元。

スナップショットをレイヤーごとに読み、作業コンテキストを復元してください：
1. meta + dna — プロジェクトのアイデンティティとして受け入れる（目標、言語、スタイル、制約、trajectory — プロジェクトの向かう先）
2. decisions — すべて記憶する。type:"rejected" — 二度と提案しない、理由は "why" にある
3. state — ここから続ける。state.next_step — あなたの最初のアクション
4. instructions — 自分自身のルールとして従う
5. open_threads（あれば）— 未解決の質問；アクティブに保ち、解決済みと見なさない
6. implicit（あれば）：user_profile からスタイルと詳細度を調整する；adaptation_log を尊重する — ユーザーが既に放棄したものを再提案しない；assumptions は confidence ごとに — low：黙って行動せず、まず尋ねる；medium：行動するが最初の返信でその仮定を明示する；high：事実として受け入れる

スナップショットのみに基づいてください。次のステップに必要なものが欠けている場合は — 尋ね、作り上げないでください。

まず1行で、どこまで進んだかを確認してください：目標 + 次のステップ。次に validation.questions の質問に答えてください — 答えは validation.expected と一致する必要があります；一致しない場合はスナップショットを読み直してください。その後、作業を続けてください。`,
        ko: `SessionPort 프로토콜 — 컨텍스트 복원.

스냅샷을 레이어별로 읽고 작업 컨텍스트를 복원하세요:
1. meta + dna — 프로젝트 정체성으로 수용 (목표, 언어, 스타일, 제약, trajectory — 프로젝트가 향하는 방향)
2. decisions — 모두 기억. type:"rejected" — 다시는 제안하지 말 것, 이유는 "why"에 있음
3. state — 여기서 계속. state.next_step — 당신의 첫 번째 행동
4. instructions — 자신의 규칙으로 따를 것
5. open_threads (있으면) — 미해결 질문; 살아있게 유지하고 종료된 것으로 취급하지 말 것
6. implicit (있으면): user_profile로 스타일과 detail을 보정; adaptation_log 준수 — 사용자가 이미 포기한 것을 다시 제안하지 말 것; assumptions는 confidence별로 — low: 조용히 행동하지 말고 먼저 질문; medium: 행동하되 첫 답변에서 가정을 표시; high: 사실로 수용

스냅샷에만 근거하세요. 다음 단계에 필요한 것이 빠져 있으면 — 물어보고, 지어내지 마세요.

먼저 한 줄로 우리가 어디까지 했는지 확인하세요: 목표 + 다음 단계. 그런 다음 validation.questions의 질문에 답하세요 — 답은 validation.expected와 일치해야 합니다; 그렇지 않으면 스냅샷을 다시 읽으세요. 그 후 작업을 계속하세요.`,
        pt: `PROTOCOLO SessionPort — RESTAURAÇÃO DO CONTEXTO.

Leia o snapshot camada por camada e restaure o contexto de trabalho:
1. meta + dna — aceite como identidade do projeto (objetivo, idioma, estilo, restrições, trajectory — para onde o projeto está indo)
2. decisions — memorize todas. type:"rejected" — nunca sugerir novamente, o motivo está em "why"
3. state — continue a partir daqui. state.next_step — sua primeira ação
4. instructions — siga como suas próprias regras
5. open_threads (se presente) — questões não resolvidas; mantenha-as ativas, não as considere encerradas
6. implicit (se presente): calibre o estilo e o detalhe a partir de user_profile; respeite adaptation_log — não sugira novamente o que o usuário já abandonou; assumptions por confidence — low: não aja em silêncio, pergunte primeiro; medium: aja mas sinalize a suposição na sua primeira resposta; high: aceite como fato

Baseie-se apenas no snapshot. Se faltar algo para o próximo passo — pergunte, não invente.

Primeiro, em uma linha, confirme onde paramos: objetivo + próximo passo. Depois responda às perguntas de validation.questions — as respostas devem corresponder a validation.expected; se não, releia o snapshot. Em seguida, continue o trabalho.`
      };
      const _L = ['en','ru','de','fr','es','zh','ja','ko','pt'].includes(PR_i18n.lang) ? PR_i18n.lang : 'en';
      const prompt = (RESTORE_INTRO[_L] || RESTORE_INTRO.en) +
        '\n\n---BEGIN CONTEXT---\n' + json + '\n---END CONTEXT---';
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
