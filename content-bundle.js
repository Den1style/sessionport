/**
 * SessionPort — content-bundle.js  v1.0
 *
 * Статус платформ:
 *   ✅ Claude      — захват + вставка контекста + файлы
 *   ✅ ChatGPT     — захват + вставка + файлы (dropOnly)
 *   ✅ Grok        — захват + вставка + файлы (fileInput)
 *   ✅ Gemini      — захват + вставка + файлы (paste)
 *   ✅ Mistral     — захват + вставка + файлы (paste)
 *   ✅ Deepseek    — захват + вставка + файлы (fileInput)
 *   ✅ Perplexity  — захват + вставка + файлы (fileInput + dragSeq fallback)
 *
 * Схема: C=Claude G=Grok P=ChatGPT M=Mistral E=gEMini D=Deepseek X=Perplexity
 *
 * БЛОКИ:
 *   INJECT    — toast, badge, inject text functions, base64
 *   ADAPTERS  — 6 LLM adapters: findInput/findDropTarget/inject/injectFiles
 *   CAPTURE   — startCapture, tryCapture, captureNow, 3 branches
 *   CONTENT   — message handlers, SPA reset, zombie cleanup
 */

// console.log('[SessionPort] bundle start loading...');
const PR_VERSION   = '1.0';

// ╔══════════════════════════════════════════════════════════════════╗
// ║  BLOCK: INJECT                                                  ║
// ║  toast · badge · injectProseMirror/Quill/Textarea · base64     ║
// ╚══════════════════════════════════════════════════════════════════╝

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
    host.style.cssText = 'position:fixed;top:18px;right:18px;z-index:2147483647;' +
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

// ── Content-script i18n ──────────────────────────────────────
let _lang = 'ru';
try { chrome.storage.local.get('pr_lang', r => { if (r?.pr_lang) _lang = r.pr_lang; }); } catch(_) {}

const _CT = {
  ru: {
    'toast.no_input':      'Поле ввода не найдено',
    'toast.replaced':      'Предыдущий текст заменён',
    'toast.injected':      'Промпт вставлен',
    'toast.type_unsup':    'Тип поля не поддержан',
    'toast.chatgpt_type':  'Неизвестный тип поля ChatGPT',
    'toast.waiting_json':  'Жду финальный JSON от модели…',
    'toast.json_not_found':'SessionPort JSON не найден. Убедитесь что модель ответила на промпт — или попробуйте Full Transfer.',
    'toast.no_msgs':       'Сообщения модели не найдены — возможно, интерфейс платформы обновился. Обновите страницу и попробуйте снова.',
    'toast.timeout':       'Захват прерван (2 мин): JSON не появился. Убедитесь что модель ответила на промпт SessionPort.',
    'toast.json_big':      'JSON >500KB — захват отменён',
    'toast.storage_full':  'Хранилище заполнено — удалите старые слепки',
    'toast.already_cap':   'Этот JSON уже захвачен',
    'toast.captured':      'Контекст захвачен!',
    'toast.editor_timeout':'Редактор не найден за 15с',
    'toast.buf_empty':     'Буфер пуст',
    'toast.no_drop_target':'Не найден drop-target для файлов',
    'toast.files_n':       '{n} файлов прикреплено',
    'toast.attach_fail':   'Не удалось прикрепить файлы: {err}',
    'toast.file_lost':     'Файл не передан — попробуйте ещё раз',
    'toast.file_ok':       'Файл «{name}» прикреплён',
    'toast.file_fail':     'Не удалось прикрепить «{name}»',
    'toast.no_target':     'Не найдено место для прикрепления',
    'toast.attach_err':    'Ошибка прикрепления файла',
  },
  en: {
    'toast.no_input':      'Input field not found',
    'toast.replaced':      'Previous text replaced',
    'toast.injected':      'Prompt injected',
    'toast.type_unsup':    'Field type not supported',
    'toast.chatgpt_type':  'Unknown ChatGPT field type',
    'toast.waiting_json':  'Waiting for final JSON from model…',
    'toast.json_not_found':'SessionPort JSON not found. Make sure the model responded to the prompt — or try Full Transfer.',
    'toast.no_msgs':       'Model messages not found — platform UI may have changed. Refresh the page and try again.',
    'toast.timeout':       'Capture timed out (2 min): no JSON appeared. Make sure the model responded to the SessionPort prompt.',
    'toast.json_big':      'JSON >500KB — capture cancelled',
    'toast.storage_full':  'Storage full — delete old snapshots',
    'toast.already_cap':   'This JSON already captured',
    'toast.captured':      'Context captured!',
    'toast.editor_timeout':'Editor not found after 15s',
    'toast.buf_empty':     'Buffer empty',
    'toast.no_drop_target':'No drop target found for files',
    'toast.files_n':       '{n} files attached',
    'toast.attach_fail':   'Could not attach files: {err}',
    'toast.file_lost':     'File not received — try again',
    'toast.file_ok':       'File "{name}" attached',
    'toast.file_fail':     'Could not attach "{name}"',
    'toast.no_target':     'No attachment target found',
    'toast.attach_err':    'File attachment error',
  },
  de: {
    'toast.no_input':      'Eingabefeld nicht gefunden',
    'toast.replaced':      'Vorherigen Text ersetzt',
    'toast.injected':      'Prompt eingefügt',
    'toast.type_unsup':    'Feldtyp nicht unterstützt',
    'toast.chatgpt_type':  'Unbekannter ChatGPT-Feldtyp',
    'toast.waiting_json':  'Warte auf finales JSON vom Modell…',
    'toast.json_not_found':'SessionPort JSON nicht gefunden. Stellen Sie sicher, dass das Modell geantwortet hat — oder versuchen Sie Full Transfer.',
    'toast.no_msgs':       'Modell-Nachrichten nicht gefunden — UI hat sich möglicherweise geändert. Seite neu laden und erneut versuchen.',
    'toast.timeout':       'Erfassung unterbrochen (2 Min): kein JSON. Stellen Sie sicher, dass das Modell auf den SessionPort-Prompt geantwortet hat.',
    'toast.json_big':      'JSON >500KB — Erfassung abgebrochen',
    'toast.storage_full':  'Speicher voll — alte Snapshots löschen',
    'toast.already_cap':   'Dieses JSON bereits erfasst',
    'toast.captured':      'Kontext erfasst!',
    'toast.editor_timeout':'Editor nach 15s nicht gefunden',
    'toast.buf_empty':     'Puffer leer',
    'toast.no_drop_target':'Kein Drop-Ziel für Dateien gefunden',
    'toast.files_n':       '{n} Dateien angehängt',
    'toast.attach_fail':   'Dateien konnten nicht angehängt werden: {err}',
    'toast.file_lost':     'Datei nicht empfangen — erneut versuchen',
    'toast.file_ok':       'Datei „{name}" angehängt',
    'toast.file_fail':     '„{name}" konnte nicht angehängt werden',
    'toast.no_target':     'Kein Anhängeziel gefunden',
    'toast.attach_err':    'Fehler beim Anhängen der Datei',
  },
  fr: {
    'toast.no_input':      'Champ de saisie introuvable',
    'toast.replaced':      'Texte précédent remplacé',
    'toast.injected':      'Invite injectée',
    'toast.type_unsup':    'Type de champ non supporté',
    'toast.chatgpt_type':  'Type de champ ChatGPT inconnu',
    'toast.waiting_json':  'En attente du JSON final du modèle…',
    'toast.json_not_found':'JSON SessionPort introuvable. Assurez-vous que le modèle a répondu au prompt — ou essayez Full Transfer.',
    'toast.no_msgs':       "Messages du modèle introuvables — l'interface a peut-être changé. Rechargez la page et réessayez.",
    'toast.timeout':       "Capture interrompue (2 min) : aucun JSON. Assurez-vous que le modèle a répondu au prompt SessionPort.",
    'toast.json_big':      'JSON >500KB — capture annulée',
    'toast.storage_full':  "Stockage plein — supprimez d'anciens instantanés",
    'toast.already_cap':   'Ce JSON est déjà capturé',
    'toast.captured':      'Contexte capturé !',
    'toast.editor_timeout':'Éditeur introuvable après 15s',
    'toast.buf_empty':     'Tampon vide',
    'toast.no_drop_target':'Aucune cible de dépôt pour les fichiers',
    'toast.files_n':       '{n} fichiers joints',
    'toast.attach_fail':   'Impossible de joindre les fichiers : {err}',
    'toast.file_lost':     'Fichier non reçu — réessayez',
    'toast.file_ok':       'Fichier « {name} » joint',
    'toast.file_fail':     'Impossible de joindre « {name} »',
    'toast.no_target':     'Aucune cible de pièce jointe trouvée',
    'toast.attach_err':    "Erreur lors de l'attachement",
  },
  es: {
    'toast.no_input':      'Campo de entrada no encontrado',
    'toast.replaced':      'Texto anterior reemplazado',
    'toast.injected':      'Prompt inyectado',
    'toast.type_unsup':    'Tipo de campo no compatible',
    'toast.chatgpt_type':  'Tipo de campo ChatGPT desconocido',
    'toast.waiting_json':  'Esperando JSON final del modelo…',
    'toast.json_not_found':'JSON de SessionPort no encontrado. Asegúrate de que el modelo respondió al prompt — o prueba Full Transfer.',
    'toast.no_msgs':       'Mensajes del modelo no encontrados — la interfaz puede haber cambiado. Recarga la página e inténtalo de nuevo.',
    'toast.timeout':       'Captura interrumpida (2 min): no apareció JSON. Asegúrate de que el modelo respondió al prompt SessionPort.',
    'toast.json_big':      'JSON >500KB — captura cancelada',
    'toast.storage_full':  'Almacenamiento lleno — elimina capturas antiguas',
    'toast.already_cap':   'Este JSON ya está capturado',
    'toast.captured':      '¡Contexto capturado!',
    'toast.editor_timeout':'Editor no encontrado en 15s',
    'toast.buf_empty':     'Búfer vacío',
    'toast.no_drop_target':'No se encontró destino de arrastre para archivos',
    'toast.files_n':       '{n} archivos adjuntos',
    'toast.attach_fail':   'No se pudieron adjuntar archivos: {err}',
    'toast.file_lost':     'Archivo no recibido — intenta de nuevo',
    'toast.file_ok':       'Archivo "{name}" adjunto',
    'toast.file_fail':     'No se pudo adjuntar "{name}"',
    'toast.no_target':     'No se encontró destino para adjuntar',
    'toast.attach_err':    'Error al adjuntar el archivo',
  },
  pt: {
    'toast.no_input':      'Campo de entrada não encontrado',
    'toast.replaced':      'Texto anterior substituído',
    'toast.injected':      'Prompt injetado',
    'toast.type_unsup':    'Tipo de campo não suportado',
    'toast.chatgpt_type':  'Tipo de campo ChatGPT desconhecido',
    'toast.waiting_json':  'Aguardando JSON final do modelo…',
    'toast.json_not_found':'JSON SessionPort não encontrado. Verifique se o modelo respondeu ao prompt — ou tente Full Transfer.',
    'toast.no_msgs':       'Mensagens do modelo não encontradas — a interface pode ter mudado. Atualize a página e tente novamente.',
    'toast.timeout':       'Captura interrompida (2 min): nenhum JSON apareceu. Verifique se o modelo respondeu ao prompt SessionPort.',
    'toast.json_big':      'JSON >500KB — captura cancelada',
    'toast.storage_full':  'Armazenamento cheio — exclua snapshots antigos',
    'toast.already_cap':   'Este JSON já foi capturado',
    'toast.captured':      'Contexto capturado!',
    'toast.editor_timeout':'Editor não encontrado em 15s',
    'toast.buf_empty':     'Buffer vazio',
    'toast.no_drop_target':'Nenhum destino de soltura encontrado para arquivos',
    'toast.files_n':       '{n} arquivos anexados',
    'toast.attach_fail':   'Não foi possível anexar arquivos: {err}',
    'toast.file_lost':     'Arquivo não recebido — tente novamente',
    'toast.file_ok':       'Arquivo "{name}" anexado',
    'toast.file_fail':     'Não foi possível anexar "{name}"',
    'toast.no_target':     'Nenhum destino de anexo encontrado',
    'toast.attach_err':    'Erro ao anexar arquivo',
  },
  ja: {
    'toast.no_input':      '入力フィールドが見つかりません',
    'toast.replaced':      '前のテキストを置き換えました',
    'toast.injected':      'プロンプトを注入しました',
    'toast.type_unsup':    'フィールドタイプ未対応',
    'toast.chatgpt_type':  '不明なChatGPTフィールドタイプ',
    'toast.waiting_json':  'モデルから最終JSONを待っています…',
    'toast.json_not_found':'SessionPort JSONが見つかりません。モデルがプロンプトに回答したか確認 — またはFull Transferをお試しください。',
    'toast.no_msgs':       'モデルのメッセージが見つかりません — UIが変わった可能性があります。ページを再読み込みして再試行してください。',
    'toast.timeout':       '取得が中断されました（2分）: JSONが現れませんでした。モデルがSessionPortプロンプトに回答したか確認してください。',
    'toast.json_big':      'JSON >500KB — 取得をキャンセルしました',
    'toast.storage_full':  'ストレージが満杯 — 古いスナップショットを削除してください',
    'toast.already_cap':   'このJSONはすでに取得済みです',
    'toast.captured':      'コンテキストを取得しました！',
    'toast.editor_timeout':'15秒後もエディタが見つかりません',
    'toast.buf_empty':     'バッファが空です',
    'toast.no_drop_target':'ファイルのドロップ先が見つかりません',
    'toast.files_n':       '{n}個のファイルを添付しました',
    'toast.attach_fail':   'ファイルを添付できませんでした: {err}',
    'toast.file_lost':     'ファイルが届きませんでした — もう一度試してください',
    'toast.file_ok':       'ファイル「{name}」を添付しました',
    'toast.file_fail':     '「{name}」を添付できませんでした',
    'toast.no_target':     '添付先が見つかりません',
    'toast.attach_err':    'ファイル添付エラー',
  },
  ko: {
    'toast.no_input':      '입력 필드를 찾을 수 없습니다',
    'toast.replaced':      '이전 텍스트가 교체되었습니다',
    'toast.injected':      '프롬프트가 주입되었습니다',
    'toast.type_unsup':    '지원되지 않는 필드 유형',
    'toast.chatgpt_type':  '알 수 없는 ChatGPT 필드 유형',
    'toast.waiting_json':  '모델에서 최종 JSON 대기 중…',
    'toast.json_not_found':'SessionPort JSON을 찾을 수 없습니다. 모델이 프롬프트에 응답했는지 확인 — 또는 Full Transfer를 시도하세요.',
    'toast.no_msgs':       '모델 메시지를 찾을 수 없습니다 — 플랫폼 UI가 변경되었을 수 있습니다. 페이지를 새로고침하고 다시 시도하세요.',
    'toast.timeout':       '캡처 중단 (2분): JSON이 나타나지 않았습니다. 모델이 SessionPort 프롬프트에 응답했는지 확인하세요.',
    'toast.json_big':      'JSON >500KB — 캡처 취소됨',
    'toast.storage_full':  '저장공간 가득 참 — 오래된 스냅샷을 삭제하세요',
    'toast.already_cap':   '이 JSON은 이미 캡처되었습니다',
    'toast.captured':      '컨텍스트 캡처됨!',
    'toast.editor_timeout':'15초 후에도 에디터를 찾을 수 없습니다',
    'toast.buf_empty':     '버퍼가 비어 있습니다',
    'toast.no_drop_target':'파일의 드롭 대상을 찾을 수 없습니다',
    'toast.files_n':       '{n}개 파일 첨부됨',
    'toast.attach_fail':   '파일을 첨부할 수 없습니다: {err}',
    'toast.file_lost':     '파일을 받지 못했습니다 — 다시 시도하세요',
    'toast.file_ok':       '파일 "{name}" 첨부됨',
    'toast.file_fail':     '"{name}"을 첨부할 수 없습니다',
    'toast.no_target':     '첨부 대상을 찾을 수 없습니다',
    'toast.attach_err':    '파일 첨부 오류',
  },
  zh: {
    'toast.no_input':      '未找到输入框',
    'toast.replaced':      '已替换之前的文本',
    'toast.injected':      '提示词已注入',
    'toast.type_unsup':    '不支持的字段类型',
    'toast.chatgpt_type':  '未知的 ChatGPT 字段类型',
    'toast.waiting_json':  '等待模型输出最终 JSON…',
    'toast.json_not_found':'未找到 SessionPort JSON。请确认模型已回复提示词 — 或尝试 Full Transfer。',
    'toast.no_msgs':       '未找到模型消息 — 平台界面可能已更新。请刷新页面后重试。',
    'toast.timeout':       '捕获中断（2分钟）: 未出现 JSON。请确认模型已回复 SessionPort 提示词。',
    'toast.json_big':      'JSON >500KB — 捕获已取消',
    'toast.storage_full':  '存储空间已满 — 请删除旧快照',
    'toast.already_cap':   '此 JSON 已被捕获',
    'toast.captured':      '上下文已捕获！',
    'toast.editor_timeout':'15秒后仍未找到编辑器',
    'toast.buf_empty':     '缓冲区为空',
    'toast.no_drop_target':'未找到文件的拖放目标',
    'toast.files_n':       '已附加 {n} 个文件',
    'toast.attach_fail':   '无法附加文件: {err}',
    'toast.file_lost':     '未收到文件 — 请重试',
    'toast.file_ok':       '文件"{name}"已附加',
    'toast.file_fail':     '无法附加"{name}"',
    'toast.no_target':     '未找到附件目标',
    'toast.attach_err':    '文件附加错误',
  },
};

function _ct(key, vars) {
  const map = _CT[_lang] || _CT.en;
  let s = (map[key] ?? _CT.en[key]) ?? key;
  if (vars) Object.keys(vars).forEach(k => { s = s.replaceAll('{' + k + '}', vars[k]); });
  return s;
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
  if (!input) { showToast(_ct('toast.no_input'), 'error'); setBadge('ERROR'); return false; }
  const injectFn = adapter?.inject ?? injectContentEditable;
  return injectFn(input, text);
}

// ── ProseMirror / Tiptap (Claude, Grok, ChatGPT, Mistral) ──
function injectProseMirror(pm, text) {
  const ex = pm.innerText.trim();
  if (ex.length > 20 && !ex.startsWith('ПРОТОКОЛ SessionPort')) {
    showToast(_ct('toast.replaced'), 'info');
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

  showToast(_ct('toast.injected'), 'success');
  return true;
}

// ── Textarea (ChatGPT legacy) ──────────────────────────────
function injectTextarea(input, text) {
  if (!(input instanceof HTMLTextAreaElement)) {
    showToast(_ct('toast.type_unsup'), 'error');
    return false;
  }
  if (input.value.trim().length > 20 && !input.value.startsWith('ПРОТОКОЛ SessionPort')) {
    showToast(_ct('toast.replaced'), 'info');
  }
  const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set;
  setter ? setter.call(input, text) : (input.value = text);
  input.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true, inputType: 'insertText', data: text }));
  input.dispatchEvent(new Event('change', { bubbles: true }));
  showToast(_ct('toast.injected'), 'success');
  return true;
}

// ── Quill (Gemini) ─────────────────────────────────────────
function injectQuill(el, text) {
  el.focus();
  const ex = el.innerText.trim();
  if (ex.length > 20 && !ex.startsWith('ПРОТОКОЛ SessionPort')) {
    showToast(_ct('toast.replaced'), 'info');
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
  showToast(_ct('toast.injected'), 'success');
  return true;
}

// ── ContentEditable generic (Perplexity, fallback) ─────────
function injectContentEditable(el, text) {
  el.focus();
  const ex = el.innerText.trim();
  if (ex.length > 20 && !ex.startsWith('ПРОТОКОЛ SessionPort')) {
    showToast(_ct('toast.replaced'), 'info');
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
  showToast(_ct('toast.injected'), 'success');
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

// ╔══════════════════════════════════════════════════════════════════╗

// ╔══════════════════════════════════════════════════════════════════╗
// ║  BLOCK: ADAPTERS                                                ║
// ║  7 LLM adapters · findInput · inject · injectFiles per platform ║
// ╚══════════════════════════════════════════════════════════════════╝

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
      // font-claude-response first: Claude removed data-message-author-role in 2026-06.
      // Claude now renders each section as a SEPARATE tiny div (e.g. "---END CONTEXT---").
      // threshold >500 finds the last MEANINGFUL content div, skipping fragments.
      const byFont = document.querySelectorAll('[class*="font-claude-response"]');
      for (let i = byFont.length - 1; i >= 0; i--)
        if ((byFont[i].innerText || '').trim().length > 500) return byFont[i];
      for (let i = byFont.length - 1; i >= 0; i--)
        if ((byFont[i].innerText || '').trim().length > 10) return byFont[i];
      const byRole = document.querySelectorAll('[data-message-author-role="assistant"]');
      for (let i = byRole.length - 1; i >= 0; i--)
        if (byRole[i].innerText?.trim().length > 10) return byRole[i];
      const byClass = document.querySelectorAll('div[class*="group"][class*="relative"][class*="pb-"]');
      if (byClass.length > 0) return byClass[byClass.length - 1];
      return null;
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
      showToast(_ct('toast.chatgpt_type'), 'error');
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
      // message-content — основной селектор (Gemini 2024-2025)
      let a = document.querySelectorAll('message-content');
      if (a.length > 0) return a[a.length - 1];
      // Fallback: model-response или response-content (возможные будущие имена)
      a = document.querySelectorAll('model-response, .model-response, [data-role="model"]');
      if (a.length > 0) return a[a.length - 1];
      // Generic: последний ответ в main
      const main = document.querySelector('main, [role="main"]');
      const msgs = main?.querySelectorAll('[class*="response"], [class*="answer"], [class*="model"]');
      return (msgs && msgs.length > 0) ? msgs[msgs.length - 1] : null;
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

    findInput: () => document.querySelector('textarea[class*="ds-scroll"]') 
                  || document.querySelector('textarea'),
    findLastMessage: () => {
      const all = document.querySelectorAll('[data-role="assistant"]');
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
// ║  BLOCK: CAPTURE                                                 ║
// ║  startCapture · stopCapture · captureNow · tryCapture · 3 branches ║
// ╚══════════════════════════════════════════════════════════════════╝

let captureInterval   = null;
let captureTimeout    = null;
let captureSessionId  = 0;
let seenBlocks        = new Set();
let _captureStartTextLen = 0;  // text length of last assistant msg at capture start
let _captureNowRunning = false;  // sync guard against multiple captureNow
let _captureNowInterval = null;  // separate interval for captureNow — doesn't conflict with startCapture

// ── Запуск ─────────────────────────────────────────────────
function startCapture() {
  stopCapture();
  _savingInProgress = false;  // новый цикл захвата — разрешаем сохранение
  captureSessionId++;
  const session = captureSessionId;

  setBadge('CAPTURING');
  showToast(_ct('toast.waiting_json'), 'info');

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
      showToast(_ct('toast.no_msgs'), 'error');
    }
  }, 30_000);

  captureTimeout = setTimeout(() => {
    if (session !== captureSessionId) return;
    // Проверяем: может JSON уже захвачен — не сбрасываем
    chrome.storage.local.get(['flow_state'], r => {
      if (r.flow_state?.status === 'READY_TO_INJECT') return;
      stopCapture(); setBadge('ERROR');
      showToast(_ct('toast.timeout'), 'error');
      chrome.storage.local.set({
        flow_state: { status:'IDLE', payload:null,
                      mode: r.flow_state?.mode||null, step: r.flow_state?.step||0,
                      transfer_id: r.flow_state?.transfer_id||null }
      });
    });
  }, CAPTURE_TIMEOUT_MS);
}

// ── Остановка ───────────────────────────────────────────────
function stopCapture() {
  if (captureInterval) { clearInterval(captureInterval); captureInterval = null; }
  if (_captureNowInterval) { clearInterval(_captureNowInterval); _captureNowInterval = null; }
  clearTimeout(captureTimeout); captureTimeout = null;
  seenBlocks.clear();
  _captureStartTextLen = 0;
  _captureNowRunning = false;
  // NOTE: _savingInProgress НЕ сбрасываем здесь — он защищает от повторного toast
  // после stopCapture. Сброс происходит только в startCapture (новый цикл захвата).
}

// ── Ручной захват (SCAN NOW) ─────────────────────────────────
// One-shot: сканирует страницу прямо сейчас без запуска интервала.
// Используется кнопкой «Захватить вручную» и как fallback.

function captureNow() {
  // Sync guard: only one captureNow at a time
  if (_captureNowRunning) {
    // console.log('[PR] captureNow: уже запущен, пропускаем');
    return;
  }
  _captureNowRunning = true;

  // Async guard: check if already captured
  chrome.storage.local.get('flow_state', r => {
    if (r.flow_state?.status === 'READY_TO_INJECT') {
      // console.log('[PR] captureNow: уже захвачено, пропускаем');
      _captureNowRunning = false;
      return;
    }

    // Новый цикл сканирования — разрешаем сохранение
    _savingInProgress = false;
    // Reset seen/length so we scan everything on page (including old blocks)
    seenBlocks.clear();
    _captureStartTextLen = 0;
    setBadge('CAPTURING');

    // Останавливаем предыдущий captureNow interval, но НЕ трогаем startCapture's captureInterval
    if (_captureNowInterval) { clearInterval(_captureNowInterval); _captureNowInterval = null; }

    // Первая попытка сразу
    tryCapture();

    // Продолжаем сканирование 60 сек (120 попыток × 500мс)
    // — достаточно чтобы модель достримила JSON
    let attempts = 0;
    _captureNowInterval = setInterval(() => {
      attempts++;
      // Если _saveAndStop уже вызвал stopCapture — выходим
      if (!_captureNowInterval) { _captureNowRunning = false; return; }
      tryCapture();
      if (attempts >= 120) {
        clearInterval(_captureNowInterval); _captureNowInterval = null;
        _captureNowRunning = false;
        if (!captureInterval) {
          setBadge('ERROR');
          const hasMsg = !!findLastAssistantMessage();
          showToast(_ct(hasMsg ? 'toast.json_not_found' : 'toast.no_msgs'), 'error');
        }
      }
    }, 500);
  });
}

// ── Основная попытка захвата ─────────────────────────────
function tryCapture() {

  // ══ Ветка 1: code-блоки (```json ... ```) ══
  // ВСЕГДА ограничиваем поиск последним assistant-сообщением — это предотвращает
  // захват JSON-шаблона из пользовательского сообщения (промпта генерации),
  // который появляется в DOM ПОСЛЕ startCapture (race condition с нормальным интервалом).
  // Fallback на весь document только если assistant-сообщение не найдено или пусто.
  const _lastMsg = findLastAssistantMessage();
  const _allBlocks = Array.from(document.querySelectorAll(SELECTORS.CODE_BLOCKS));
  const _filtered = _lastMsg ? _allBlocks.filter(b => _lastMsg.contains(b) || _lastMsg === b) : _allBlocks;
  // Shadow DOM / новая структура платформы: если filtered пусто — fallback на все блоки
  const _blocksToScan = (_lastMsg && _filtered.length === 0) ? _allBlocks : _filtered;
  for (const block of _blocksToScan) {
    const content = block.textContent
      .replace(/[\uFEFF\u200B\u200C\u200D\u2060]/g, '').trim();
    const fp = content.length + ':' + content.slice(0, 50) + ':' + content.slice(-100);
    if (seenBlocks.has(fp)) continue;
    if (seenBlocks.size > 500) {
      const first = seenBlocks.values().next().value;
      seenBlocks.delete(first);
    }
    if (!content.startsWith('{') || !content.endsWith('}')) continue;
    if (new TextEncoder().encode(content).length > MAX_JSON_BYTES) {
      showToast(_ct('toast.json_big'), 'error');
      seenBlocks.add(fp); stopCapture(); setBadge('ERROR'); return;
    }
    try {
      const parsed = JSON.parse(content);
      if (_notSessionPort(parsed)) continue;
      // Canonical format check
      const isCanonical = !!parsed?.meta?.protocol;
      if (isCanonical) {
        const isV11 = parsed?.meta?.version === '1.1';
        const requiredFields = isV11
          ? ['meta','dna','decisions','state','instructions','validation']
          : ['meta','core','ledger','runtime','validation_protocol'];
        const miss = requiredFields.filter(k => !parsed[k]);
        if (miss.length > 0) { console.warn('[PR] Пропущены поля:', miss.join(',')); continue; }
        if (_isTemplatePlaceholder(parsed)) { continue; }
      } else {
        // Flat/simplified format — enough to have protocol + at least intent or runtime_state
        const hasContent = parsed.intent || parsed.runtime_state || parsed.core || parsed.critical_decisions;
        if (!hasContent) { console.warn('[PR] Flat format: нет контента'); continue; }
      }
      _saveAndStop(content, parsed);
      return;
    } catch (e) {
      if (!(e instanceof SyntaxError)) console.error("[PR] Unexpected capture error:", e);
      /* partial JSON — continue polling */
    }
  }

  // ══ Ветка 2+3: общие переменные — объявляем ДО Branch 2 return'ов ══
  const root    = findLastAssistantMessage();
  // Shadow DOM fallback: если root.innerText пуст (напр. Gemini custom element) —
  // берём весь текст страницы через document.body, это медленнее но надёжнее
  let fullTxt = root ? (root.innerText || root.textContent || '') : '';
  if (!fullTxt && root) {
    // Попытка достать текст через shadowRoot
    const sr = root.shadowRoot;
    if (sr) fullTxt = sr.innerText || sr.textContent || '';
  }
  if (!fullTxt) {
    // Последний resort: весь body — Branch 3 в любом случае ищет PROTO_MARKER
    fullTxt = document.body?.innerText || document.body?.textContent || '';
  }
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
      if (parsed && !_notSessionPort(parsed) && (
        (parsed.core && parsed.ledger && parsed.runtime) ||
        (parsed.dna && parsed.decisions && parsed.state)
      )) {
        if (new TextEncoder().encode(cand).length > MAX_JSON_BYTES) {
          showToast(_ct('toast.json_big'), 'error'); stopCapture(); setBadge('ERROR'); return;
        }
        _saveAndStop(cand, parsed);
        return;
      }
    }
  }

  // ══ Ветка 3: голый JSON (plain text, Grok / ChatGPT без code-блока) ══
  const PROTO_MARKER = '{"meta":{"protocol":"SessionPort"';
  // Search in sliced txt first (new content since capture start)
  // Fallback: search in full last assistant message (handles case where
  // the whole response IS the new message and slice calculation was off)
  let b3start = txt.indexOf(PROTO_MARKER);
  let b3source = txt;  // track which string b3start indexes into
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
        b3source = fullTxt;  // index is into fullTxt, not txt
      }
    }
  }
  if (b3start === -1) return;

  // Найти парную закрывающую скобку — в той же строке где нашли b3start
  let depth = 0, b3end = -1;
  for (let i = b3start; i < b3source.length; i++) {
    if (b3source[i] === '{') depth++;
    else if (b3source[i] === '}') { depth--; if (depth === 0) { b3end = i; break; } }
  }
  // JSON ещё не дописан (стриминг)
  if (b3end === -1 || depth !== 0) return;

  const jsonCand = cleanJsonCandidate(b3source.slice(b3start, b3end + 1));
  let p3;
  try { p3 = JSON.parse(jsonCand); }
  catch {
    try { p3 = JSON.parse(jsonCand.replace(/[""]/g, '"').replace(/['']/g, "'")); }
    catch { return; }
  }
  if (_notSessionPort(p3)) return;
  const _p3hasV10 = p3.core && p3.ledger && p3.runtime;
  const _p3hasV11 = p3.dna && p3.decisions && p3.state;
  if (!_p3hasV10 && !_p3hasV11) return;

  const b3bytes = new TextEncoder().encode(jsonCand).length;
  if (b3bytes > MAX_JSON_BYTES) {
    seenBlocks.add(b3start + ':' + b3end);
    showToast(_ct('toast.json_big'), 'error'); stopCapture(); setBadge('ERROR'); return;
  }
  _saveAndStop(jsonCand, p3);
}

// ── Внутренние хелперы ───────────────────────────────────
function _notSessionPort(parsed) {
  // Основной формат: { meta: { protocol: "SessionPort" } }
  const metaOk = String(parsed?.meta?.protocol || '').trim().toLowerCase() === 'sessionport';
  if (metaOk) return false;
  // Упрощённый формат (Grok/старые версии): { protocol: "SessionPort" }
  const rootOk = String(parsed?.protocol || '').trim().toLowerCase() === 'sessionport';
  return !rootOk;
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
let _savingInProgress = false;        // sync guard against concurrent _saveAndStop calls
let _expectedTransferId = null;       // UUID set by popup before INJECT_PROMPT generation step
let _lastSavedTransferId = null;      // UUID of last successfully saved snapshot (prevents same-session double-capture)

const _PR_TRANSFER_ID_RE = /^pr_[a-z0-9]{16}$/;

function _saveAndStop(jsonStr, parsed) {
  // Sync guard: prevent two concurrent tryCapture calls from double-saving
  if (_savingInProgress) {
    // console.log('[PR] _saveAndStop: уже в процессе сохранения');
    return;
  }

  const tid = parsed?.meta?.transfer_id;

  // Primary identity check: transfer_id must match expected (set by popup before generation prompt).
  // This eliminates capture of stale JSON from previous transfers on the same page.
  if (_expectedTransferId) {
    if (!tid || !_PR_TRANSFER_ID_RE.test(tid)) {
      console.warn('[PR] _saveAndStop: JSON без валидного transfer_id, ожидался', _expectedTransferId, '— пропуск');
      return;
    }
    if (tid !== _expectedTransferId) {
      console.warn('[PR] _saveAndStop: transfer_id не совпадает (got', tid, 'expected', _expectedTransferId, ') — это чужой JSON, пропуск');
      return;
    }
  }

  // Same-session double-capture guard: if we already saved this exact transfer_id, skip.
  // Covers: user clicks "Захватить вручную" after auto-capture, two intervals racing, etc.
  if (tid && tid === _lastSavedTransferId) {
    // console.log('[PR] _saveAndStop: этот transfer_id уже сохранён, пропуск');
    return;
  }

  _savingInProgress = true;
  if (tid) _lastSavedTransferId = tid;

  const b64 = utf8ToBase64(jsonStr);
  chrome.storage.local.get(['flow_state'], res => {
    const prev = res.flow_state || {};
    if (prev.status === 'READY_TO_INJECT') {
      console.warn('[PR] _saveAndStop: уже READY_TO_INJECT — двойной захват заблокирован');
      _savingInProgress = false;
      stopCapture();
      return;
    }
    chrome.storage.local.set({
      flow_state: {
        status:      'READY_TO_INJECT',
        payload:     b64,
        source_host: location.hostname,
        transfer_id: tid || prev.transfer_id || null,
        mode:        prev.mode || null,
        step:        prev.step || 0
      }
    });
  });
  safeSendMessage({ action: 'SAVE_SNAPSHOT', payload: parsed, source_host: location.hostname },
    (response) => {
      if (!response?.success && response?.code === 'QUOTA_EXCEEDED') {
        showToast(_ct('toast.storage_full'), 'error');
      }
      if (response?.reason === 'dedup') {
        // Dedup: снапшот не создан — откатить flow_state в предыдущее состояние
        // чтобы UI не показывал "захват" с пустым snapshot
        chrome.storage.local.get(['flow_state'], r2 => {
          const fs = r2.flow_state || {};
          if (fs.status === 'READY_TO_INJECT') {
            chrome.storage.local.set({
              flow_state: { ...fs, status: 'IDLE', payload: null }
            });
            setBadge('IDLE');
            showToast(_ct('toast.already_cap'), 'info');
          }
        });
      }
    }
  );
  // Clear expected — this session is done
  _expectedTransferId = null;
  stopCapture(); setBadge('READY'); showToast(_ct('toast.captured'), 'success');
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
  return `ПРОТОКОЛ SessionPort — ВОССТАНОВЛЕНИЕ КОНТЕКСТА.\n\nПрочитай слепок послойно и восстанови рабочий контекст:\n1. meta + dna — прими как идентичность проекта (цель, язык, стиль, ограничения)\n2. decisions — запомни все. type:"rejected" — никогда не предлагай повторно, причина в "why"\n3. state — продолжай отсюда. state.next_step — твоё первое действие\n4. instructions — следуй как собственным правилам\n5. open_threads (если есть) — нерешённые вопросы, держи их в работе, не считай закрытыми\n6. implicit (если есть): откалибруй стиль и детальность по user_profile; соблюдай adaptation_log — не предлагай заново то, от чего пользователь уже отказался; assumptions по confidence — low: не действуй молча, сначала уточни; medium: действуй, но отметь допущение в первом ответе; high: прими как факт\n\nПосле загрузки ответь на вопросы из validation.questions. Ответы должны соответствовать validation.expected — если нет, перечитай слепок.\n\n---BEGIN CONTEXT---\n${json}\n---END CONTEXT---`;
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
      chrome.storage.local.get(['flow_state'], r => {
        const prev = r.flow_state || {};
        chrome.storage.local.set({ flow_state: {
          status: 'PASTED', payload: prev.payload || null,
          mode: prev.mode || null, step: prev.step || 0,
          transfer_id: prev.transfer_id || null,
          inject_files: prev.inject_files || false
        }});
      });
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
        chrome.storage.local.get(['flow_state'], r => {
          const prev = r.flow_state || {};
          chrome.storage.local.set({ flow_state: {
            status: 'PASTED', payload: prev.payload || null,
            mode: prev.mode || null, step: prev.step || 0,
            transfer_id: prev.transfer_id || null,
            inject_files: prev.inject_files || false
          }});
        });
        setBadge('IDLE');
      }
    });
  });
  injectObserver.observe(document.body, { childList: true, subtree: true });
  injectTimeout = setTimeout(() => {
    injectTimeout = null;
    if (injectObserver) { injectObserver.disconnect(); injectObserver = null; }
    showToast(_ct('toast.editor_timeout'), 'error'); setBadge('ERROR');
  }, 15_000);
}

// ╔══════════════════════════════════════════════════════════════════╗
// ║  BLOCK: CONTENT                                                 ║
// ║  message handlers · SPA reset · zombie session cleanup         ║
// ╚══════════════════════════════════════════════════════════════════╝

// ═══════════════════════════════════════════════════════════
// MESSAGING
// ═══════════════════════════════════════════════════════════
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {


  if (msg.action === 'INJECT_PROMPT_APPEND') {
    const adapter = getAdapter();
    const input   = adapter?.findInput?.() || document.querySelector(SELECTORS.INPUTS);
    if (!input) { showToast('Поле ввода не найдено', 'error'); sendResponse({ success: false }); return true; }
    let current = '';
    if (input instanceof HTMLTextAreaElement) {
      current = input.value || '';
    } else {
      current = input.innerText || '';
    }
    const sep      = current.trimEnd().length > 0 ? '\n' : '';
    const fullText = current.trimEnd() + sep + msg.text.trim();
    const injectFn = adapter?.inject ?? injectContentEditable;
    const ok = injectFn(input, fullText);
    showToast(_ct('toast.prompt_inserted') || 'Промпт добавлен', 'success');
    sendResponse({ success: !!ok });
    return true;
  }

  if (msg.action === 'INJECT_PROMPT_FILE') {
    const adapter    = getAdapter();
    const dropTarget = adapter?.findDropTarget?.() || adapter?.findInput?.() || document.querySelector(SELECTORS.INPUTS);
    if (!dropTarget || !msg.data_b64) { sendResponse({ success: false }); return true; }
    const tag      = 'pr-drop-' + Math.random().toString(16).slice(2, 8);
    const selector = `[data-pr-drop="${tag}"]`;
    dropTarget.setAttribute('data-pr-drop', tag);
    chrome.runtime.sendMessage({
      action: 'EXECUTE_FILE_DROP_IN_MAIN_WORLD',
      files:  [{ content_b64: msg.data_b64, filename: msg.filename, mime: msg.mime || 'application/octet-stream' }],
      targetSelector: selector
    }, resp => {
      setTimeout(() => dropTarget.removeAttribute('data-pr-drop'), 1000);
      sendResponse({ success: !!resp?.success });
    });
    return true;
  }

  if (msg.action === 'INJECT_PROMPT') {
    injectContext(msg.text).then(s => sendResponse({ success: s }));
    return true;
  }

  if (msg.action === 'SET_EXPECTED_TRANSFER_ID') {
    if (msg.transfer_id && _PR_TRANSFER_ID_RE.test(msg.transfer_id)) {
      _expectedTransferId = msg.transfer_id;
      // Reset _lastSavedTransferId so we can capture this fresh session
      // (only matters if user re-runs same UUID, which shouldn't happen but is safe)
      _lastSavedTransferId = null;
      // console.log('[PR] expected transfer_id set:', _expectedTransferId);
    } else {
      _expectedTransferId = null;
      console.warn('[PR] SET_EXPECTED_TRANSFER_ID: invalid id', msg.transfer_id);
    }
    sendResponse({ success: true });
    return false;
  }

  if (msg.action === 'CLEAR_EXPECTED_TRANSFER_ID') {
    _expectedTransferId = null;
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
        showToast(_ct('toast.buf_empty'), 'error'); setBadge('ERROR');
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
      showToast(_ct('toast.no_drop_target'), 'error');
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
        showToast(_ct('toast.files_n', { n: resp.injected || msg.files.length }), 'success');
        sendResponse({ success: true, injected: resp.injected });
      } else {
        showToast(_ct('toast.attach_fail', { err: resp?.error || '?' }), 'error');
        sendResponse({ success: false, error: resp?.error });
      }
    });
    return true;
  }

  return false;
});

// ═══════════════════════════════════════════════════════════
// CROSS-WINDOW DRAG INTERCEPTOR
// Side panel attaches text/x-SessionPort-drag = dragId on dragstart.
// We watch for that marker and, on drop, fetch the real File from
// background storage and re-dispatch a synthetic drop with a real
// File object — works on every platform's native drop handler.
// ═══════════════════════════════════════════════════════════
(function _initDragInterceptor() {
  const PR_DRAG_TYPE = 'application/x-SessionPort-drag';
  const PR_DRAG_TYPE_ALT = 'text/x-SessionPort-drag';
  const PR_URI_PREFIX = 'SessionPort-drag://';
  // Cache: dragId → { filename, mime, content_b64 }
  const _stagedCache = new Map();
  let lastDropTarget = null;
  let _seenDragOnce = false;

  // Check via multiple channels — Chromium cross-window drag may strip custom MIMEs
  const _hasPRMarker = (dt) => {
    if (!dt || !dt.types) return false;
    try {
      const arr = Array.from(dt.types);
      // Проверяем только наши кастомные типы — НЕ text/uri-list
      // text/uri-list присутствует во всех drop с файлами (добавляется браузером автоматически)
      // и вызывает ложное срабатывание на синтетических drop от кнопки вставки
      if (arr.indexOf(PR_DRAG_TYPE) !== -1) return 'app';
      if (arr.indexOf(PR_DRAG_TYPE_ALT) !== -1) return 'text';
    } catch (_) {}
    return false;
  };

  // Try every channel to extract dragId
  const _readDragId = (dt) => {
    if (!dt) return null;
    let id = null;
    try { id = dt.getData(PR_DRAG_TYPE); } catch (_) {}
    if (id) return id;
    try { id = dt.getData(PR_DRAG_TYPE_ALT); } catch (_) {}
    if (id) return id;
    // uri-list fallback только если кастомные типы не сработали
    try {
      const uri = dt.getData('text/uri-list') || '';
      if (uri.startsWith(PR_URI_PREFIX)) return uri.slice(PR_URI_PREFIX.length);
    } catch (_) {}
    return null;
  };

  // ── Локальный кеш файлов для drag ────────────────────────
  // Грузим ВСЕ staged файлы из storage.local при загрузке страницы.
  // storage.local синхронизируется немедленно внутри одного браузера —
  // к моменту когда пользователь начнёт тащить файл данные уже в _stagedCache.
  const _loadAllStagedFiles = () => {
    chrome.storage.local.get(null, all => {
      if (chrome.runtime.lastError) return;
      Object.keys(all).forEach(k => {
        if (k.startsWith('pr_drag_file_') && all[k]?.filename) {
          const dragId = k.slice('pr_drag_file_'.length);
          _stagedCache.set(dragId, all[k]);
        }
      });
      // staged files loaded
    });
  };
  _loadAllStagedFiles();

  // Обновляем кеш когда side panel добавляет/убирает файлы
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    Object.keys(changes).forEach(k => {
      if (!k.startsWith('pr_drag_file_')) return;
      const dragId = k.slice('pr_drag_file_'.length);
      if (changes[k].newValue) {
        _stagedCache.set(dragId, changes[k].newValue);
        // console.log('[PR-drag] storage update:', changes[k].newValue.filename, 'id:', dragId);
      } else {
        _stagedCache.delete(dragId);
      }
    });
  });

  // Background пушит данные файла сюда при рендере side panel (дополнительный канал)
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.action === 'PUSH_DRAG_FILE' && msg.drag_id && msg.file) {
      _stagedCache.set(msg.drag_id, msg.file);
      // console.log('[PR-drag] push received:', msg.file.filename, 'id:', msg.drag_id);
    }
  });

  // Test: inject staged file via MAIN world (same path as INJECT_FILES — correct per-platform logic)
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.action !== 'PUSH_DRAG_FILE_DIRECT' || !msg.drag_id) return false;
    chrome.storage.local.get('pr_drag_file_' + msg.drag_id, res => {
      const fd = res['pr_drag_file_' + msg.drag_id];
      if (!fd) { console.warn('[PR-test] staged file not found:', msg.drag_id); sendResponse({ success: false }); return; }
      // Route through background → MAIN world (correct overlay/react-dnd handling per platform)
      // targetSelector is used only as generic fallback — platform-specific logic in dispatchFileDropInMainWorld ignores it
      const selector = 'body';
      chrome.runtime.sendMessage({
        action: 'EXECUTE_FILE_DROP_IN_MAIN_WORLD',
        files: [fd],
        targetSelector: selector,
        tabId: null  // background will use sender tab
      }, r => {
        if (chrome.runtime.lastError) console.warn('[PR-test] inject:', chrome.runtime.lastError.message);
        sendResponse(r || { success: false });
      });
    });
    return true;
  });

  const _prefetchFile = (dragId) => {
    if (_stagedCache.has(dragId)) return;
    _stagedCache.set(dragId, null);
    chrome.runtime.sendMessage({ action: 'GET_DRAG_FILE', drag_id: dragId }, (resp) => {
      if (chrome.runtime.lastError || !resp?.success) {
        console.warn('[PR-drag] prefetch failed:',
          resp?.error || chrome.runtime.lastError?.message);
        _stagedCache.delete(dragId);
        return;
      }
      // console.log('[PR-drag] prefetched file:', resp.file.filename, 'for drag', dragId);
      _stagedCache.set(dragId, resp.file);
    });
  };

  document.addEventListener('dragenter', (e) => {
    const marker = _hasPRMarker(e.dataTransfer);
    if (!marker) return;
    if (!_seenDragOnce) {
      // console.log('[PR-drag] dragenter detected, types:', Array.from(e.dataTransfer.types));
      _seenDragOnce = true;
    }
    try { e.dataTransfer.dropEffect = 'copy'; } catch (_) {}
    const dragId = _readDragId(e.dataTransfer);
    if (dragId) _prefetchFile(dragId);

    // ARM main world на dragenter.
    // ПРОБЛЕМА: getData() не работает в dragenter при cross-window drag (только в drop).
    // Поэтому армируем ВСЕ staged файлы — main world разберётся когда получит drop с dragId.
    if (_stagedCache.size > 0) {
      // Передаём весь кеш в main world
      const allFiles = {};
      _stagedCache.forEach((v, k) => { if (v) allFiles[k] = v; });
      window.dispatchEvent(new CustomEvent('PR_DRAG_ARMED_ALL', { detail: { files: allFiles } }));
      // console.log('[PR-drag] armed main world with', Object.keys(allFiles).length, 'files on dragenter');
    }
  }, true);

  document.addEventListener('dragover', (e) => {
    if (!_hasPRMarker(e.dataTransfer)) return;
    e.preventDefault();
    try { e.dataTransfer.dropEffect = 'copy'; } catch (_) {}
    lastDropTarget = e.target;
  }, true);

  document.addEventListener('drop', (e) => {
    const marker = _hasPRMarker(e.dataTransfer);
    if (!marker) return;

    const dragId = _readDragId(e.dataTransfer);
    // console.log('[PR-drag] drop intercepted, marker:', marker, 'id:', dragId, 'types:', Array.from(e.dataTransfer.types));
    if (!dragId) {
      console.warn('[PR-drag] no dragId in drop event — not our drag');
      return;
    }

    e.preventDefault();
    // На Gemini НЕ делаем stopImmediatePropagation — main world должен получить drop
    // чтобы кликнуть скрепку синхронно пока user gesture активен
    const isGemini = location.hostname.includes('gemini.google.com');
    if (!isGemini) e.stopImmediatePropagation();

    // console.log('[PR-drag] cache size:', _stagedCache.size, 'has key:', _stagedCache.has(dragId), 'keys:', [..._stagedCache.keys()]);
    let cached = _stagedCache.get(dragId);

    if (cached) {
      _attachFileSync(cached, e.target || lastDropTarget, e.clientX, e.clientY);
    } else {
      // File is in session storage (staged at render time) — fetch it now
      // console.log('[PR-drag] fetching from session storage...');
      chrome.runtime.sendMessage({ action: 'GET_DRAG_FILE', drag_id: dragId }, (resp) => {
        if (chrome.runtime.lastError || !resp?.success) {
          showToast(_ct('toast.file_lost'), 'error');
          return;
        }
        _attachFileSync(resp.file, lastDropTarget, 0, 0);
      });
    }
  }, true);

  // SYNC attach: builds File and dispatches drop directly. Keeps user-gesture context.
  // Works on Claude/ChatGPT/Grok via real drop event. For Gemini/Mistral attempts
  // input[type=file] which now has a chance because we're inside the gesture window.
  function _attachFileSync(fileData, dropTarget, cx, cy) {
    try {
      const bin = atob(fileData.content_b64);
      const arr = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
      const realFile = new File([arr], fileData.filename,
        { type: fileData.mime || 'application/octet-stream' });
      // console.log('[PR-drag] _attachFileSync file:', realFile.name, realFile.size, 'bytes');

      // Strategy 1: input[type=file] уже в DOM (Claude, Grok, Deepseek, ChatGPT)
      // Может НЕ работать на Perplexity — проверяем что файл реально принят.
      const inp = document.querySelector('input[type="file"]');
      if (inp) {
        // console.log('[PR-drag] using input strategy, inp.id:', inp.id);
        const dt = new DataTransfer();
        dt.items.add(realFile);
        const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
          window.HTMLInputElement.prototype, 'files')?.set;
        if (nativeInputValueSetter) {
          nativeInputValueSetter.call(inp, dt.files);
        } else {
          Object.defineProperty(inp, 'files', { value: dt.files, configurable: true });
        }
        inp.dispatchEvent(new Event('change', { bubbles: true }));
        inp.dispatchEvent(new Event('input',  { bubbles: true }));
        // console.log('[PR-drag] events dispatched, files:', inp.files?.length);
        // ЕСЛИ файл реально прикрепился — выходим. Иначе пробуем следующие стратегии.
        if (inp.files?.length > 0) {
          showToast(_ct('toast.file_ok', { name: realFile.name }), 'success');
          return;
        }
        // console.log('[PR-drag] input strategy rejected file, falling through to next strategy');
      }

      // Strategy 2: Gemini — synthetic paste event на .ql-editor
      // Angular xap-CDK dropzone отвергает synthetic drop (isTrusted check).
      // Но Quill paste handler принимает synthetic ClipboardEvent с mutable
      // DataTransfer — Gemini обрабатывает paste-with-file как обычный upload.
      // Подтверждено эмпирически: появляется file-preview-chip в attachment-preview-wrapper.
      const qlEditor = document.querySelector('.ql-editor[contenteditable="true"]');
      if (qlEditor && location.hostname.includes('gemini.google.com')) {
        // console.log('[PR-drag] Gemini strategy: synthetic paste on .ql-editor');
        try { qlEditor.focus(); } catch(_) {}
        const pasteData = new DataTransfer();
        pasteData.items.add(realFile);
        const pasteEvent = new ClipboardEvent('paste', {
          clipboardData: pasteData,
          bubbles: true, cancelable: true, composed: true,
        });
        const accepted = !qlEditor.dispatchEvent(pasteEvent);
        // console.log('[PR-drag] paste accepted:', accepted, 'prevented:', pasteEvent.defaultPrevented);
        if (pasteEvent.defaultPrevented) {
          showToast(_ct('toast.file_ok', { name: realFile.name }), 'success');
        } else {
          showToast(_ct('toast.file_fail', { name: realFile.name }), 'error');
        }
        return;
      }

      // Strategy 2b: Mistral — synthetic paste на .ProseMirror (та же стратегия что Gemini)
      const pmEditor = document.querySelector('div.ProseMirror[contenteditable="true"]');
      if (pmEditor && location.hostname.includes('chat.mistral.ai')) {
        // console.log('[PR-drag] Mistral strategy: synthetic paste on .ProseMirror');
        try { pmEditor.focus(); } catch(_) {}
        const pasteData = new DataTransfer();
        pasteData.items.add(realFile);
        const pasteEvent = new ClipboardEvent('paste', {
          clipboardData: pasteData,
          bubbles: true, cancelable: true, composed: true,
        });
        pmEditor.dispatchEvent(pasteEvent);
        // console.log('[PR-drag] mistral paste prevented:', pasteEvent.defaultPrevented);
        if (pasteEvent.defaultPrevented) {
          showToast(_ct('toast.file_ok', { name: realFile.name }), 'success');
        } else {
          showToast(_ct('toast.file_fail', { name: realFile.name }), 'error');
        }
        return;
      }

      // Strategy 3: synthesized drop event на drop target (остальные fallback)
      const adapter = getAdapter();
      const target = adapter?.findDropTarget?.() || dropTarget;
      if (!target) {
        showToast(_ct('toast.no_target'), 'error');
        return;
      }
      const dt = new DataTransfer();
      dt.items.add(realFile);
      const init = {
        bubbles: true, cancelable: true, composed: true,
        dataTransfer: dt, clientX: cx, clientY: cy
      };
      target.dispatchEvent(new DragEvent('dragenter', init));
      target.dispatchEvent(new DragEvent('dragover',  init));
      target.dispatchEvent(new DragEvent('drop',      init));
      target.dispatchEvent(new DragEvent('dragleave', { bubbles: true, dataTransfer: dt }));
      document.dispatchEvent(new DragEvent('dragend',  { bubbles: true }));
      showToast(_ct('toast.file_ok', { name: realFile.name }), 'success');
    } catch (err) {
      console.error('[PR-drag] sync attach failed:', err);
      showToast(_ct('toast.attach_err'), 'error');
    }
  }

  // Cleanup on dragend
  document.addEventListener('dragend', () => {
    lastDropTarget = null;
    // _stagedCache is repopulated via storage.onChanged on next dragenter
    // No need to clear here — aggressive clear caused race with rapid drag-drops
  }, true);
})();

// ═══════════════════════════════════════════════════════════
// SPA NAVIGATION RESET
// ═══════════════════════════════════════════════════════════
const _resetOnNav = () => {
  if (captureInterval || _captureNowInterval) { stopCapture(); setBadge('IDLE'); }
};
window.addEventListener('popstate', _resetOnNav);
const _origPush    = history.pushState;
const _origReplace = history.replaceState;
history.pushState    = function(...a) { const r = _origPush.apply(this, a);    _resetOnNav(); return r; };
history.replaceState = function(...a) { const r = _origReplace.apply(this, a); _resetOnNav(); return r; };

// ═══════════════════════════════════════════════════════════
// INIT — сброс зависших CAPTURING сессий + restore session state
// ═══════════════════════════════════════════════════════════
if (chrome.runtime?.id) chrome.storage.local.get(['flow_state'], r => {
  const state = r.flow_state || {};
  // Restore expected transfer_id if a session is in progress (capture-pending)
  // This survives content-script reload during streaming.
  if (state.transfer_id && _PR_TRANSFER_ID_RE.test(state.transfer_id) &&
      state.status !== 'READY_TO_INJECT') {
    _expectedTransferId = state.transfer_id;
  }
  // If READY_TO_INJECT — capture already happened, remember its UUID to dedup repeat attempts
  if (state.status === 'READY_TO_INJECT' && state.transfer_id) {
    _lastSavedTransferId = state.transfer_id;
  }
  if (state.status === 'CAPTURING') {
    chrome.storage.local.set({
      flow_state: { ...state, status: 'IDLE', payload: null }
    });
    setBadge('IDLE');
  }
});

// Listen for flow_state changes — re-sync expected/last-saved across content-script lifetime
chrome.storage.onChanged.addListener(changes => {
  if (!chrome.runtime?.id) return;
  if (!changes.flow_state) return;
  const ns = changes.flow_state.newValue || {};
  // Reset to IDLE → user pressed ↺, clear all session UUIDs
  if (ns.status === 'IDLE' && !ns.transfer_id) {
    _expectedTransferId = null;
    _lastSavedTransferId = null;
    return;
  }
  // New session UUID set by popup (shouldn't override an active expected if equal)
  if (ns.transfer_id && _PR_TRANSFER_ID_RE.test(ns.transfer_id) &&
      ns.status !== 'READY_TO_INJECT') {
    _expectedTransferId = ns.transfer_id;
  }
});

// console.log('[SessionPort] bundle fully loaded, version:', PR_VERSION);
