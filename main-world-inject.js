// ═══════════════════════════════════════════════════════════
// MAIN-WORLD INTERCEPTOR for Gemini showOpenFilePicker
// ═══════════════════════════════════════════════════════════
// Этот скрипт работает в main world страницы (world: "MAIN" в manifest).
// Переопределяет window.showOpenFilePicker — когда Gemini вызывает file picker,
// наш override возвращает подготовленный File без открытия диалога.
//
// Coordination с isolated world (content-bundle.js) идёт через CustomEvent:
//   - PR_DRAG_ARMED (file payload) → MAIN world запоминает файл
//   - PR_DRAG_FIRED → isolated world знает что файл доставлен
// ═══════════════════════════════════════════════════════════

(function () {
  if (window.__prShowOpenFilePickerPatched) return;
  window.__prShowOpenFilePickerPatched = true;

  // Файл подготовленный к перехвату — устанавливается перед drop
  let armedFile = null;       // { filename, mime, content_b64 }
  let armedExpiresAt = 0;     // unix ms; через 5 секунд авто-сброс

  // Кеш всех staged файлов — заполняется из isolated world на dragenter
  let armedFiles = {}; // dragId → fileData

  // ГЛАВНЫЙ ОБРАБОТЧИК: слушаем drop прямо в main world синхронно
  const PR_DRAG_TYPE = 'application/x-SessionPort-drag';
  const PR_DRAG_TYPE_ALT = 'text/x-SessionPort-drag';

  document.addEventListener('drop', (e) => {
    const types = e.dataTransfer?.types ? Array.from(e.dataTransfer.types) : [];
    const isPR = types.includes(PR_DRAG_TYPE) || types.includes(PR_DRAG_TYPE_ALT);
    if (!isPR) return;

    // Читаем dragId — доступен только в drop
    let dragId = null;
    try { dragId = e.dataTransfer.getData(PR_DRAG_TYPE) || e.dataTransfer.getData(PR_DRAG_TYPE_ALT); } catch(_) {}
    if (!dragId) return;

    const fileData = armedFiles[dragId];
    if (!fileData) return;

    // СИНХРОННО кликаем кнопку — user gesture активен прямо сейчас
    const fileBtn = document.querySelector('button.hidden-local-file-upload-button');
    if (fileBtn) {
      armedFile = fileData;
      armedExpiresAt = Date.now() + 5000;
      fileBtn.click();
    } else {
      console.warn('[PR-main] drop: file button not found');
    }
  }, true);

  window.addEventListener('PR_DRAG_ARMED_ALL', (e) => {
    if (!e.detail?.files) return;
    armedFiles = e.detail.files;
  });

  window.addEventListener('PR_DRAG_DISARM', () => {
    armedFile = null;
    armedExpiresAt = 0;
    armedFiles = {};
  });

  // Build File from base64 staged data
  function _buildFile(data) {
    const bin = atob(data.content_b64);
    const arr = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    return new File([arr], data.filename, { type: data.mime || 'application/octet-stream' });
  }

  // Override showOpenFilePicker: если armed — возвращаем наш файл, иначе оригинал
  const orig = window.showOpenFilePicker?.bind(window);
  if (typeof orig === 'function') {
    window.showOpenFilePicker = async function (...args) {
      const isArmed = armedFile && Date.now() < armedExpiresAt;
      if (!isArmed) return orig.apply(window, args);

      const file = _buildFile(armedFile);
      // disarm после первого срабатывания
      armedFile = null;
      armedExpiresAt = 0;
      window.dispatchEvent(new CustomEvent('PR_DRAG_FIRED', { detail: { filename: file.name } }));

      // Build minimal FileSystemFileHandle-compatible object
      // Gemini читает только .getFile() и .name
      return [{
        kind: 'file',
        name: file.name,
        getFile: async () => file,
        // Заглушки для совместимости
        isSameEntry: async () => false,
        queryPermission: async () => 'granted',
        requestPermission: async () => 'granted'
      }];
    };
  }
})();

