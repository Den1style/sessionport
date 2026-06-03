/**
 * SessionPort — content.js (orchestrator)
 * v2.4 refactored: inject.js + adapters.js + capture.js
 *
 * Порядок загрузки важен (manifest.json):
 *   inject.js → adapters.js → capture.js → content.js
 */

// ═══════════════════════════════════════════════════════════
// MESSAGING
// ═══════════════════════════════════════════════════════════
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {

  if (msg.action === 'INJECT_PROMPT') {
    injectContext(msg.text).then(s => sendResponse({ success: s }));
    return true;
  }

  if (msg.action === 'SET_EXPECTED_TRANSFER_ID') {
    setExpectedTransferId(msg.transfer_id || null);
    sendResponse({ success: true });
    return false;
  }

  if (msg.action === 'START_CAPTURE') {
    startCapture();
    sendResponse({ success: true });
    return false;
  }

  if (msg.action === 'CAPTURE_NOW') {
    captureNow();
    sendResponse({ success: true });
    return false;
  }

  if (msg.action === 'PASTE_CONTEXT') {
    chrome.storage.local.get(['flow_state'], r => {
      if (r.flow_state?.payload) {
        waitForEditorAndInject(r.flow_state.payload);
        sendResponse({ success: true });
      } else {
        showToast('Буфер пуст', 'error'); setBadge('ERROR');
        sendResponse({ success: false });
      }
    });
    return true;
  }

  if (msg.action === 'RUN_DIAG') {
    const a   = getAdapter();
    const inp = a?.findInput() || document.querySelector(SELECTORS.INPUTS);
    const lm  = findLastAssistantMessage();
    const adapterDiag = getAdaptersDiag(); // полный статус всех адаптеров
    sendResponse({
      host:         location.hostname,
      adapter:      a ? Object.keys(ADAPTERS).find(k => location.hostname.includes(k)) : 'none',
      inputFound:   !!inp,
      inputTag:     inp?.tagName,
      inputClass:   inp?.className?.slice(0, 100),
      lastMsgFound: !!lm,
      lastMsgTag:   lm?.tagName,
      lastMsgClass: lm?.className?.slice(0, 100),
      codeBlocks:   document.querySelectorAll(SELECTORS.CODE_BLOCKS).length,
      adaptersDiag: adapterDiag
    });
    return false;
  }

  if (msg.action === 'GET_DROP_TARGET') {
    const adapter = getAdapter();
    const target  = adapter?.findDropTarget?.()
      || adapter?.findInput?.()
      || document.querySelector(SELECTORS.INPUTS);
    if (!target) {
      sendResponse({ success: false, error: 'no drop target' });
      return false;
    }
    const tag = 'pr-drop-' + Math.random().toString(16).slice(2, 8);
    target.setAttribute('data-pr-drop', tag);
    const selector = `[data-pr-drop="${tag}"]`;
    sendResponse({ success: true, selector });
    // Clean up tag after 10 seconds
    setTimeout(() => target.removeAttribute('data-pr-drop'), 10000);
    return false;
  }

  if (msg.action === 'INJECT_FILES_PAYLOAD') {
    const adapter = getAdapter();
    const target  = adapter?.findDropTarget?.()
      || adapter?.findInput?.()
      || document.querySelector(SELECTORS.INPUTS);
    if (!target) {
      showToast('Не найден drop-target для файлов', 'error');
      sendResponse({ success: false, error: 'no drop target' });
      return false;
    }
    const tag = 'pr-drop-' + Math.random().toString(16).slice(2, 8);
    target.setAttribute('data-pr-drop', tag);
    const selector = `[data-pr-drop="${tag}"]`;

    chrome.runtime.sendMessage({
      action: 'EXECUTE_FILE_DROP_IN_MAIN_WORLD',
      files: msg.files,
      targetSelector: selector
    }, resp => {
      setTimeout(() => target.removeAttribute('data-pr-drop'), 1000);
      if (resp?.success) {
        showToast(`${resp.injected || msg.files.length} файлов прикреплено`, 'success');
        sendResponse({ success: true, injected: resp.injected });
      } else {
        showToast('Не удалось прикрепить файлы: ' + (resp?.error || '?'), 'error');
        sendResponse({ success: false, error: resp?.error });
      }
    });
    return true;
  }

  return false;
});

// ═══════════════════════════════════════════════════════════
// SPA NAVIGATION RESET
// ═══════════════════════════════════════════════════════════
const _resetOnNav = () => {
  if (captureInterval) { stopCapture(); setBadge('IDLE'); }
};
window.addEventListener('popstate', _resetOnNav);
const _origPush    = history.pushState;
const _origReplace = history.replaceState;
history.pushState    = function(...a) { const r = _origPush.apply(this, a);    _resetOnNav(); return r; };
history.replaceState = function(...a) { const r = _origReplace.apply(this, a); _resetOnNav(); return r; };

// ═══════════════════════════════════════════════════════════
// INIT — сброс зависших CAPTURING сессий (zombie reset)
// ═══════════════════════════════════════════════════════════
chrome.storage.local.get(['flow_state'], r => {
  if (r.flow_state?.status === 'CAPTURING') {
    chrome.storage.local.set({
      flow_state: { status: 'IDLE', payload: null, mode: r.flow_state.mode, step: r.flow_state.step }
    });
    setBadge('IDLE');
  }
});
