/**
 * SessionPort — prompts.js
 * Prompt Library: создание, редактирование, вставка пользовательских промптов в LLM.
 * Отдельный модуль — подключается в popup.html перед popup-shell.js.
 *
 * Зависимости: db.js (SessionPortDB + openDB), shared-utils.js (PR_Utils),
 *              i18n.js (PR_i18n), popup-utils.js (sendToContentScript, setStatus).
 *
 * ИНТЕГРАЦИЯ:
 *  1. popup.html: добавить CSS (блок PROMPTS CSS) + HTML (2 screen div) + <script src="prompts.js">
 *  2. popup-shell.js: добавить 'screenPrompts','screenPromptEdit' в SCREENS,
 *     кнопку btnPrompts → showScreen('prompts'), навигацию back-кнопок,
 *     if (name === 'prompts') initPromptsScreen(); if (name === 'promptEdit') initPromptEditScreen();
 *  3. content-bundle.js: добавить handler INJECT_PROMPT_APPEND (см. комментарий внизу файла)
 *  4. db.js: DB_VERSION = 5, objectStore 'prompts' + 'prompt_files' (см. комментарий внизу файла)
 */

// ═══════════════════════════════════════════════════════════
// DB LAYER (prompts) — использует openDB() из db.js
// ═══════════════════════════════════════════════════════════

const PromptsDB = (() => {

  // ── helpers ──
  function _tx(storeName, mode = 'readonly') {
    return window._promptsDB.transaction(storeName, mode).objectStore(storeName);
  }
  function _wrap(req) {
    return new Promise((res, rej) => {
      req.onsuccess = e => res(e.target.result);
      req.onerror   = e => rej(e.target.error);
    });
  }
  function _makeId() {
    return 'pr_' + (crypto.randomUUID ? crypto.randomUUID() : Date.now() + '_' + Math.random().toString(16).slice(2, 10));
  }

  // ── Open DB with prompts stores ──
  // Пока не bump-аем DB_VERSION основной БД — используем отдельную БД для промптов.
  // Это позволяет подключить модуль без изменения db.js.
  const PROMPTS_DB_NAME    = 'sessionport_prompts_v1';
  const PROMPTS_DB_VERSION = 1;

  function openPromptsDB() {
    if (window._promptsDB && window._promptsDB.version === PROMPTS_DB_VERSION) {
      return Promise.resolve(window._promptsDB);
    }
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(PROMPTS_DB_NAME, PROMPTS_DB_VERSION);
      req.onupgradeneeded = e => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains('prompts')) {
          const store = db.createObjectStore('prompts', { keyPath: 'prompt_id' });
          store.createIndex('by_updated',  'updated_at', { unique: false });
          store.createIndex('by_favorite', 'favorite',   { unique: false });
        }
        if (!db.objectStoreNames.contains('prompt_files')) {
          db.createObjectStore('prompt_files', { keyPath: 'prompt_id' });
        }
        if (!db.objectStoreNames.contains('prompt_trash')) {
          const trash = db.createObjectStore('prompt_trash', { keyPath: 'prompt_id' });
          trash.createIndex('by_deleted', 'deleted_at', { unique: false });
        }
      };
      req.onsuccess = e => { window._promptsDB = e.target.result; resolve(window._promptsDB); };
      req.onerror   = e => reject(e.target.error);
    });
  }

  // ── CRUD ──

  async function getAll() {
    await openPromptsDB();
    return _wrap(_tx('prompts').index('by_updated').getAll()).then(arr => arr.reverse());
  }

  async function get(id) {
    await openPromptsDB();
    return _wrap(_tx('prompts').get(id));
  }

  async function save(prompt) {
    await openPromptsDB();
    prompt.updated_at = new Date().toISOString();
    if (!prompt.created_at) prompt.created_at = prompt.updated_at;
    if (!prompt.prompt_id)  prompt.prompt_id  = _makeId();
    return _wrap(_tx('prompts', 'readwrite').put(prompt));
  }

  async function softDelete(id) {
    await openPromptsDB();
    const tx = window._promptsDB.transaction(['prompts', 'prompt_trash'], 'readwrite');
    const promptsStore = tx.objectStore('prompts');
    const trashStore   = tx.objectStore('prompt_trash');
    const getReq = promptsStore.get(id);
    return new Promise((res, rej) => {
      getReq.onsuccess = () => {
        const p = getReq.result;
        if (!p) { res(false); return; }
        p.deleted_at = new Date().toISOString();
        promptsStore.delete(id);
        trashStore.put(p);
      };
      tx.oncomplete = () => res(true);
      tx.onerror = e => rej(e.target.error);
    });
  }

  async function permanentDelete(id) {
    // Tombstone first: if process dies after this line, data remains but won't be re-imported
    await addPermanentlyDeletedId(id);
    await openPromptsDB();
    const transaction = window._promptsDB.transaction(['prompt_trash', 'prompt_files'], 'readwrite');
    transaction.objectStore('prompt_trash').delete(id);
    transaction.objectStore('prompt_files').delete(id);
    return new Promise((res, rej) => {
      transaction.oncomplete = () => res(true);
      transaction.onerror = e => rej(e.target.error);
    });
  }

  // Tombstone helpers — stored in chrome.storage.local so they survive DB re-opens
  // Format: [{id, deleted_at}] (legacy plain strings are handled gracefully)
  function getPermanentlyDeletedIds() {
    return new Promise(r => chrome.storage.local.get('prompts_perm_deleted', data => {
      const entries = data.prompts_perm_deleted || [];
      r(new Set(entries.map(e => (typeof e === 'string' ? e : e.id))));
    }));
  }
  function addPermanentlyDeletedId(id) {
    return new Promise(r => chrome.storage.local.get('prompts_perm_deleted', data => {
      const entries = data.prompts_perm_deleted || [];
      const knownIds = new Set(entries.map(e => (typeof e === 'string' ? e : e.id)));
      if (!knownIds.has(id)) entries.push({ id, deleted_at: Date.now() });
      chrome.storage.local.set({ prompts_perm_deleted: entries }, r);
    }));
  }
  async function cleanOrphanedFiles() {
    await openPromptsDB();
    const activeIds  = new Set((await getAll()).map(p => p.prompt_id));
    const trashedIds = new Set((await listTrashed()).map(p => p.prompt_id));
    const validIds   = new Set([...activeIds, ...trashedIds]);
    const allFiles   = await _wrap(_tx('prompt_files').getAll());
    const orphans    = allFiles.filter(f => !validIds.has(f.prompt_id));
    if (!orphans.length) return 0;
    const tx = window._promptsDB.transaction('prompt_files', 'readwrite');
    const store = tx.objectStore('prompt_files');
    for (const f of orphans) store.delete(f.prompt_id);
    return new Promise((res, rej) => {
      tx.oncomplete = () => res(orphans.length);
      tx.onerror = e => rej(e.target.error);
    });
  }

  async function restore(id) {
    await openPromptsDB();
    const transaction = window._promptsDB.transaction(['prompt_trash', 'prompts'], 'readwrite');
    const trashStore = transaction.objectStore('prompt_trash');
    const getReq = trashStore.get(id);
    return new Promise((res, rej) => {
      getReq.onsuccess = () => {
        const p = getReq.result;
        if (!p) { res(false); return; }
        delete p.deleted_at;
        p.updated_at = new Date().toISOString();
        trashStore.delete(id);
        transaction.objectStore('prompts').put(p);
      };
      transaction.oncomplete = () => res(true);
      transaction.onerror = e => rej(e.target.error);
    });
  }

  async function listTrashed() {
    await openPromptsDB();
    return _wrap(_tx('prompt_trash').index('by_deleted').getAll()).then(arr => arr.reverse());
  }

  // ── Files ──

  async function attachFile(prompt_id, name, mime, size, data_b64) {
    await openPromptsDB();
    return _wrap(_tx('prompt_files', 'readwrite').put({
      prompt_id, name, mime, size, data_b64, attached_at: new Date().toISOString()
    }));
  }

  async function getFile(prompt_id) {
    await openPromptsDB();
    return _wrap(_tx('prompt_files').get(prompt_id));
  }

  async function detachFile(prompt_id) {
    await openPromptsDB();
    return _wrap(_tx('prompt_files', 'readwrite').delete(prompt_id));
  }

  // ── Export / Import (for Google Drive sync) ──

  async function exportAll() {
    await openPromptsDB();
    const prompts = await _wrap(_tx('prompts').getAll());
    const files   = await _wrap(_tx('prompt_files').getAll());
    const trash   = await _wrap(_tx('prompt_trash').getAll());
    // Only sync trash items deleted within 30 days — older ones are clutter
    const cutoff = Date.now() - 30 * 86400000;
    const recentTrash = trash.filter(t =>
      !t.deleted_at || new Date(t.deleted_at).getTime() > cutoff
    );
    return { schema: 'sessionport_prompts_v1', exported_at: new Date().toISOString(), prompts, files, trash: recentTrash };
  }

  async function importAll(data, strategy = 'local_wins') {
    await openPromptsDB();
    const existing = await getAll();
    const existingMap = new Map(existing.map(p => [p.prompt_id, p]));

    // IDs that are locally soft-deleted: don't re-import as active
    const trashed = await listTrashed();
    const trashedIds = new Set(trashed.map(p => p.prompt_id));

    // IDs that were permanently deleted: never re-import from remote
    const permDeletedIds = await getPermanentlyDeletedIds();

    const transaction = window._promptsDB.transaction(['prompts', 'prompt_files', 'prompt_trash'], 'readwrite');
    const promptsStore = transaction.objectStore('prompts');
    const filesStore   = transaction.objectStore('prompt_files');
    const trashStore   = transaction.objectStore('prompt_trash');

    let imported = 0, skipped = 0, updated = 0;

    for (const p of (data.prompts || [])) {
      // Guard: locally trashed or permanently deleted — don't resurrect
      if (trashedIds.has(p.prompt_id) || permDeletedIds.has(p.prompt_id)) {
        skipped++;
        continue;
      }
      const local = existingMap.get(p.prompt_id);
      if (!local) {
        promptsStore.put(p);
        imported++;
      } else if (strategy === 'local_wins') {
        skipped++;
      } else if (strategy === 'remote_wins') {
        promptsStore.put(p);
        updated++;
      } else if (strategy === 'newest_wins') {
        if (new Date(p.updated_at) > new Date(local.updated_at)) {
          promptsStore.put(p);
          updated++;
        } else {
          skipped++;
        }
      }
    }
    for (const f of (data.files || [])) {
      if (permDeletedIds.has(f.prompt_id)) continue;
      // Files follow the same strategy as their prompt — don't overwrite local file on local_wins
      if (strategy === 'local_wins' && existingMap.has(f.prompt_id)) continue;
      filesStore.put(f);
    }
    for (const t of (data.trash || [])) {
      if (permDeletedIds.has(t.prompt_id)) continue;
      // Don't push back to trash a prompt the user already restored (it's now in active)
      if (existingMap.has(t.prompt_id)) continue;
      trashStore.put(t);
    }

    return new Promise((res, rej) => {
      transaction.oncomplete = () => res({ imported, skipped, updated });
      transaction.onerror = e => rej(e.target.error);
    });
  }

  return {
    openPromptsDB, getAll, get, save, softDelete, permanentDelete, restore, listTrashed,
    attachFile, getFile, detachFile, exportAll, importAll,
    getPermanentlyDeletedIds, cleanOrphanedFiles
  };
})();


// ═══════════════════════════════════════════════════════════
// SCREEN 1 — PROMPT LIBRARY (screenPrompts)
// ═══════════════════════════════════════════════════════════

let _promptsSearchQuery = '';

async function initPromptsScreen() {
  await PromptsDB.openPromptsDB();
  _renderPromptsList();
}

// Per-group collapse state  (tag → boolean collapsed)
const _promptsGroupCollapsed = {};

async function _renderPromptsList() {
  const listEl  = document.getElementById('promptsList');
  const emptyEl = document.getElementById('promptsEmpty');
  if (!listEl) return;

  let prompts = await PromptsDB.getAll().catch(() => []);
  const totalCount = prompts.length;

  // Apply search
  if (_promptsSearchQuery) {
    const q = _promptsSearchQuery.toLowerCase();
    prompts = prompts.filter(p =>
      (p.title || '').toLowerCase().includes(q) ||
      (p.tags || []).some(t => t.toLowerCase().includes(q))
    );
  }

  // Sort: favorites first, then by updated_at desc
  prompts.sort((a, b) => {
    if (a.favorite && !b.favorite) return -1;
    if (!a.favorite && b.favorite) return 1;
    return (b.updated_at || '').localeCompare(a.updated_at || '');
  });

  // Update badge
  const badge = document.getElementById('promptsBadge');
  if (badge) badge.textContent = totalCount;

  if (prompts.length === 0 && !_promptsSearchQuery) {
    listEl.innerHTML = '';
    if (emptyEl) emptyEl.style.display = 'block';
    return;
  }
  if (emptyEl) emptyEl.style.display = 'none';

  if (prompts.length === 0) {
    listEl.innerHTML = '<div class="pr-empty-filtered">' + PR_i18n.t('prompts.no_match') + '</div>';
    return;
  }

  // Grouped view when no filter/search active; flat list otherwise
  const useGroups = !_promptsSearchQuery;

  // Build card HTML per prompt
  const cardMap = {};
  for (const p of prompts) {
    const file = await PromptsDB.getFile(p.prompt_id).catch(() => null);
    cardMap[p.prompt_id] = _buildPromptCard(p, file);
  }

  if (!useGroups) {
    listEl.innerHTML = prompts.map(p => cardMap[p.prompt_id]).join('');
    return;
  }

  // Group by first tag; untagged → special group
  const groups = new Map();
  const untagged = [];
  const favorites = prompts.filter(p => p.favorite);
  for (const p of prompts) {
    const tag = (p.tags || [])[0];
    if (tag) {
      if (!groups.has(tag)) groups.set(tag, []);
      groups.get(tag).push(p);
    } else {
      untagged.push(p);
    }
  }

  const _makeGroup = (key, labelHtml, items) => {
    const collapsed = !!_promptsGroupCollapsed[key];
    const cls = collapsed ? ' collapsed' : '';
    const cards = items.map(p => cardMap[p.prompt_id]).join('');
    return `<div class="pr-group${cls}" data-group-tag="${PR_Utils.esc(key)}">
  <button class="pr-group-hdr" data-toggle-group="${PR_Utils.esc(key)}">
    <span class="pr-group-arrow">▾</span>
    ${labelHtml}
    <span class="pr-group-count">&nbsp;·&nbsp;${items.length}</span>
    <div class="pr-group-line"></div>
  </button>
  <div class="pr-group-cards">${cards}</div>
</div>`;
  };

  let html = '';

  // Избранное — всегда первая группа
  if (favorites.length > 0) {
    html += _makeGroup('__favorites__',
      `<span class="pr-group-name pr-group-fav">★ ${PR_i18n.t('prompts.in_favorites')}</span>`, favorites);
  }

  for (const [tag, items] of groups) {
    html += _makeGroup(tag, `<span class="pr-group-name">#${PR_Utils.esc(tag)}</span>`, items);
  }
  if (untagged.length > 0) {
    html += _makeGroup('__untagged__',
      `<span class="pr-group-name">${PR_i18n.t('prompts.no_tag')}</span>`, untagged);
  }
  listEl.innerHTML = html;
}

// Group toggle delegation
document.getElementById('promptsList')?.addEventListener('click', e => {
  const btn = e.target.closest('[data-toggle-group]');
  if (!btn) return;
  const tag = btn.dataset.toggleGroup;
  const group = btn.closest('.pr-group');
  if (!group) return;
  const now = group.classList.toggle('collapsed');
  _promptsGroupCollapsed[tag] = now;
});

function _buildPromptCard(p, file) {
  const e = PR_Utils.esc;
  const tags = (p.tags || []).map(t =>
    `<span class="pr-tag-pill">${e(t)}</span>`
  ).join('');
  const fileIndicator = file
    ? `<span class="pr-file-indicator" title="${e(file.name)}">📎 ${e(file.name.length > 16 ? file.name.slice(0, 16) + '…' : file.name)}</span>`
    : '';
  const starClass = p.favorite ? ' pr-card-fav' : '';
  const previewLine = (p.text || '').replace(/\n+/g, ' ').slice(0, 200);

  return `<div class="pr-card${starClass}" data-prompt-id="${p.prompt_id}">
    <div class="pr-card-header">
      <svg class="pr-card-icon" width="11" height="11" viewBox="0 0 11 11" fill="none"><rect x="1" y="0.5" width="9" height="10" rx="1.5" stroke="currentColor" stroke-width="1"/><path d="M3 3.5h5M3 5.5h5M3 7.5h3" stroke="currentColor" stroke-width="1" stroke-linecap="round"/></svg>
      ${p.favorite ? '<span class="pr-card-star">★</span>' : ''}
      <span class="pr-card-title">${e(p.title)}</span>
      <button class="pr-btn-edit pr-btn-edit-hdr" data-edit="${p.prompt_id}" title="${PR_i18n.t('prompts.edit')}">
        <svg width="10" height="10" viewBox="0 0 10 10" fill="none"><path d="M7 1.5l1.5 1.5L3 8.5H1.5V7L7 1.5z" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/></svg>
      </button>
      <button class="pr-btn-del pr-btn-edit-hdr" data-del="${p.prompt_id}" title="${PR_i18n.t('prompts.delete')}">
        <svg width="10" height="10" viewBox="0 0 10 10" fill="none"><rect x="2.5" y="3.5" width="5" height="5.5" rx=".8" stroke="currentColor" stroke-width="1"/><path d="M1.5 3.5h7M3.5 3.5v-1.5h3v1.5" stroke="currentColor" stroke-width="1" stroke-linecap="round"/></svg>
      </button>
    </div>
    <div class="pr-card-desc pr-card-text-preview">${e(previewLine)}</div>
    <div class="pr-card-footer">
      <div class="pr-card-meta">${tags}${fileIndicator}</div>
      <button class="pr-btn-insert" data-insert="${p.prompt_id}">
        <svg width="10" height="10" viewBox="0 0 10 10" fill="none"><path d="M1 5h6M5 2l3 3-3 3" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>
        ${PR_i18n.t('prompts.insert')}
      </button>
    </div>
  </div>`;
}

// ── Click delegation ──

document.getElementById('promptsList')?.addEventListener('click', async e => {
  // Insert
  const insertBtn = e.target.closest('[data-insert]');
  if (insertBtn) {
    const id = insertBtn.dataset.insert;
    await _insertPrompt(id);
    return;
  }
  // Edit
  const editBtn = e.target.closest('[data-edit]');
  if (editBtn) {
    _editPromptId = editBtn.dataset.edit;
    showScreen('promptEdit');
    return;
  }
  // Delete
  const delBtn = e.target.closest('[data-del]');
  if (delBtn) {
    const id = delBtn.dataset.del;
    const ok = await PR_Utils.customConfirm(PR_i18n.t('prompts.delete_confirm'), {
      confirmText: PR_i18n.t('prompts.delete'), cancelText: PR_i18n.t('dlg.cancel'), danger: true
    });
    if (!ok) return;
    await PromptsDB.softDelete(id);
    _renderPromptsList();
    return;
  }
});

// Search
document.getElementById('promptsSearch')?.addEventListener('input', e => {
  _promptsSearchQuery = e.target.value.trim();
  _renderPromptsList();
});

// Create new prompt
document.getElementById('btnPromptCreate')?.addEventListener('click', () => {
  _editPromptId = null;
  showScreen('promptEdit');
});

// Empty state create button
document.getElementById('btnPromptCreateEmpty')?.addEventListener('click', () => {
  _editPromptId = null;
  showScreen('promptEdit');
});

// Trash
document.getElementById('btnPromptTrash')?.addEventListener('click', () => {
  showScreen('promptTrash');
});

let _promptsSyncInProgress = false;

// Google Drive sync
document.getElementById('btnPromptSync')?.addEventListener('click', async () => {
  if (_promptsSyncInProgress) return;
  _promptsSyncInProgress = true;

  const btn = document.getElementById('btnPromptSync');
  if (btn) { btn.disabled = true; btn.style.opacity = '0.5'; }

  try {
    if (!gdrive_isConfigured || !gdrive_isConfigured()) {
      throw new Error('SETUP_REQUIRED');
    }
    const state = await gdrive_getState();
    if (!state.connected) {
      throw new Error('NOT_CONNECTED');
    }

    // Download remote state
    const token    = await _promptsGdToken(false);
    const folderId = await _promptsGetFolder(token);
    const remoteData = await _promptsDownloadFromDrive(token, folderId);

    // Merge remote → local (local wins for conflicts, new remote prompts are imported)
    if (remoteData) {
      const result = await PromptsDB.importAll(remoteData, 'local_wins');
      console.log('[Prompts] Sync import:', result);
    }

    // Upload merged local state back to Drive
    await _promptsUploadToDrive(token, folderId, await PromptsDB.exportAll());

    // Housekeeping: run after successful sync
    await PromptsDB.cleanOrphanedFiles().catch(() => {});
    _cleanExpiredTombstones().catch(() => {});

    setStatus(PR_i18n.t('prompts.sync_ok'), 'success');
    _renderPromptsList();
  } catch (err) {
    if (err.message === 'SETUP_REQUIRED' || err.message === 'NOT_CONNECTED') {
      setStatus(PR_i18n.t('prompts.sync_need_login'), 'error');
    } else {
      console.error('[Prompts] Sync error:', err);
      setStatus(PR_i18n.t('prompts.sync_error'), 'error');
    }
  } finally {
    _promptsSyncInProgress = false;
    if (btn) { btn.disabled = false; btn.style.opacity = ''; }
  }
});

// ── Google Drive helpers for prompts ──

const PROMPTS_DRIVE_FILENAME = 'sessionport-prompts.json';

// Silent background upload — called after permanentDelete so Drive is cleaned immediately.
// Does nothing if already syncing, not connected, or offline.
async function _promptsSyncToDriveQuiet() {
  if (_promptsSyncInProgress) return;
  try {
    if (!gdrive_isConfigured || !gdrive_isConfigured()) return;
    const state = await gdrive_getState();
    if (!state.connected) return;
    const token    = await _promptsGdToken(false);
    const folderId = await _promptsGetFolder(token);
    await _promptsUploadToDrive(token, folderId, await PromptsDB.exportAll());
  } catch {
    // silent — user will clean Drive on next manual sync
  }
}

function _cleanExpiredTombstones(maxAgeDays = 90) {
  return new Promise(r => chrome.storage.local.get('prompts_perm_deleted', data => {
    const cutoff = Date.now() - maxAgeDays * 86400000;
    const kept = (data.prompts_perm_deleted || []).filter(e =>
      typeof e === 'string' || e.deleted_at > cutoff
    );
    chrome.storage.local.set({ prompts_perm_deleted: kept }, r);
  }));
}

function _promptsGdToken(interactive) {
  return new Promise((resolve, reject) => {
    chrome.identity.getAuthToken({ interactive }, token => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else if (!token) reject(new Error('No token'));
      else resolve(token);
    });
  });
}

async function _promptsGdFetch(token, url, opts = {}) {
  return fetch(url, {
    ...opts,
    headers: { Authorization: `Bearer ${token}`, ...(opts.headers || {}) }
  });
}

async function _promptsGetFolder(token) {
  // Reuse existing SessionPort Backups folder (cached from main backup flow)
  const { gd_folder_id } = await new Promise(r => chrome.storage.local.get('gd_folder_id', r));
  if (gd_folder_id) return gd_folder_id;
  // Search Drive for existing folder
  const q = encodeURIComponent("name='SessionPort Backups' and mimeType='application/vnd.google-apps.folder' and trashed=false");
  const r = await _promptsGdFetch(token, `https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id)`);
  if (r.ok) {
    const data = await r.json();
    if (data.files?.[0]) {
      chrome.storage.local.set({ gd_folder_id: data.files[0].id });
      return data.files[0].id;
    }
  }
  // Folder doesn't exist yet — create it
  const createR = await _promptsGdFetch(token, 'https://www.googleapis.com/drive/v3/files', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'SessionPort Backups', mimeType: 'application/vnd.google-apps.folder' })
  });
  if (createR.ok) {
    const folder = await createR.json();
    chrome.storage.local.set({ gd_folder_id: folder.id });
    return folder.id;
  }
  throw new Error('Folder not found');
}

async function _promptsDownloadFromDrive(token, folderId) {
  const q = encodeURIComponent(`'${folderId}' in parents and name='${PROMPTS_DRIVE_FILENAME}' and trashed=false`);
  const r = await _promptsGdFetch(token,
    `https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id,name)&pageSize=1`
  );
  if (!r.ok) return null;
  const { files } = await r.json();
  if (!files?.[0]) return null;
  const dl = await _promptsGdFetch(token,
    `https://www.googleapis.com/drive/v3/files/${files[0].id}?alt=media`
  );
  if (!dl.ok) return null;
  const text = await dl.text();
  try {
    const data = JSON.parse(text);
    if (data.schema === 'sessionport_prompts_v1') return data;
  } catch {}
  return null;
}

async function _promptsUploadToDrive(token, folderId, data) {
  // Check if file exists to update, else create
  const q = encodeURIComponent(`'${folderId}' in parents and name='${PROMPTS_DRIVE_FILENAME}' and trashed=false`);
  const searchR = await _promptsGdFetch(token,
    `https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id)&pageSize=1`
  );
  let existingId = null;
  if (searchR.ok) {
    const { files } = await searchR.json();
    if (files?.[0]) existingId = files[0].id;
  }

  const jsonBlob = new Blob([JSON.stringify(data)], { type: 'application/json' });

  if (existingId) {
    // Update existing file
    await _promptsGdFetch(token,
      `https://www.googleapis.com/upload/drive/v3/files/${existingId}?uploadType=media`,
      { method: 'PATCH', body: jsonBlob, headers: { 'Content-Type': 'application/json' } }
    );
  } else {
    // Create new file
    const form = new FormData();
    form.append('metadata', new Blob([JSON.stringify({
      name: PROMPTS_DRIVE_FILENAME, parents: [folderId], mimeType: 'application/json'
    })], { type: 'application/json' }));
    form.append('file', jsonBlob);
    await _promptsGdFetch(token,
      'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart',
      { method: 'POST', body: form }
    );
  }
}


// ── Insert prompt into LLM ──

async function _insertPrompt(id) {
  const p = await PromptsDB.get(id);
  if (!p?.text) { setStatus(PR_i18n.t('prompts.empty_text'), 'error'); return; }

  let text = p.text;

  // Handle {{variables}}
  const varRegex = /\{\{([^}]+)\}\}/g;
  const vars = [...text.matchAll(varRegex)].map(m => m[1]);
  const uniqueVars = [...new Set(vars)];

  if (uniqueVars.length > 0) {
    const values = {};
    for (const v of uniqueVars) {
      const val = await new Promise(resolve => {
        PR_Utils.customPrompt(
          PR_i18n.t('prompts.var_prompt', { name: v }),
          result => resolve(result),
          { placeholder: v }
        );
      });
      if (val === null) return; // User cancelled
      values[v] = val;
    }
    for (const [name, val] of Object.entries(values)) {
      text = text.replaceAll(`{{${name}}}`, val);
    }
  }

  // Send APPEND inject to content script
  const ok = await sendToContentScript('INJECT_PROMPT_APPEND', { text });
  if (ok) {
    setStatus(PR_i18n.t('prompts.toast_inserted'), 'success');
  }

  // Also inject file if present
  const file = await PromptsDB.getFile(id).catch(() => null);
  if (file && ok) {
    await sendToContentScript('INJECT_PROMPT_FILE', {
      filename: file.name,
      mime: file.mime,
      data_b64: file.data_b64
    });
  }
}


// ═══════════════════════════════════════════════════════════
// SCREEN 2 — PROMPT EDITOR (screenPromptEdit)
// ═══════════════════════════════════════════════════════════

let _editPromptId = null;
let _editDirty    = false;

async function initPromptEditScreen() {
  const titleInput  = document.getElementById('peTitle');
  const textArea    = document.getElementById('peText');
  const tagInput    = document.getElementById('peTagInput');
  const fileInfo    = document.getElementById('peFileInfo');
  const previewEl   = document.getElementById('pePreview');
  const delBtn      = document.getElementById('btnPeDelete');
  const favBtn      = document.getElementById('btnPeFavorite');
  const screenTitle = document.getElementById('peScreenTitle');
  const charCount   = document.getElementById('peCharCount');
  const varHint     = document.getElementById('peVarHint');

  if (!titleInput) return;

  _editDirty = false;
  _peFile    = null;
  _peTags    = [];
  _peFavorite = false;

  if (_editPromptId) {
    // Edit mode
    const p = await PromptsDB.get(_editPromptId);
    if (!p) { showScreen('prompts'); return; }
    titleInput.value = p.title || '';
    textArea.value   = p.text || '';
    _peTags = [...(p.tags || [])];
    _peFavorite = !!p.favorite;
    if (screenTitle) screenTitle.textContent = PR_i18n.t('prompts.edit_title_edit');
    if (delBtn) delBtn.style.display = '';

    // Load file
    const file = await PromptsDB.getFile(_editPromptId).catch(() => null);
    if (file) {
      _peFile = file;
    }
  } else {
    // Create mode
    titleInput.value = '';
    textArea.value   = '';
    _peTags = [];
    _peFavorite = false;
    if (screenTitle) screenTitle.textContent = PR_i18n.t('prompts.edit_title_new');
    if (delBtn) delBtn.style.display = 'none';
  }

  _peRenderTagPool();
  _peRenderFile();
  _peUpdatePreview();
  _peUpdateFavoriteBtn();
  _peUpdateCharCount();
  _peUpdateVarHint();
}

let _peFile = null;
let _peTags = [];
let _peFavorite = false;

// ── Tag management ──

// ── Tag pool: все теги из БД, кликабельны, серые/зелёные ──

async function _peRenderTagPool() {
  const pool = document.getElementById('peTagsPool');
  if (!pool) return;
  const all = await PromptsDB.getAll().catch(() => []);
  const existing = new Set();
  all.forEach(p => (p.tags || []).forEach(t => existing.add(t)));
  _peTags.forEach(t => existing.add(t)); // включаем уже выбранные
  if (existing.size === 0) { pool.innerHTML = ''; return; }
  pool.innerHTML = [...existing].sort().map(t => {
    const sel = _peTags.includes(t);
    return `<button class="pe-pool-tag${sel ? ' selected' : ''}" data-pool-tag="${PR_Utils.esc(t)}">${PR_Utils.esc(t)}</button>`;
  }).join('');
}

document.getElementById('peTagsPool')?.addEventListener('click', e => {
  const btn = e.target.closest('[data-pool-tag]');
  if (!btn) return;
  const tag = btn.dataset.poolTag;
  if (_peTags.includes(tag)) {
    _peTags = _peTags.filter(t => t !== tag);
    btn.classList.remove('selected');
  } else {
    _peTags.push(tag);
    btn.classList.add('selected');
  }
  _editDirty = true;
});

// Input для нового тега которого нет в пуле
document.getElementById('peTagInput')?.addEventListener('keydown', e => {
  if (e.key === 'Enter') { e.preventDefault(); _peAddTag(); }
});
document.getElementById('peTagInput')?.addEventListener('input', () => {
  const inp = document.getElementById('peTagInput');
  const btn = document.getElementById('btnPeConfirmTag');
  if (inp) inp.style.width = Math.max(72, Math.min(inp.value.length * 8 + 24, 150)) + 'px';
  if (btn) btn.style.display = inp?.value.trim() ? 'inline-flex' : 'none';
});

document.getElementById('btnPeConfirmTag')?.addEventListener('click', () => _peAddTag());

function _peAddTag(tagValue) {
  const inp = document.getElementById('peTagInput');
  const btn = document.getElementById('btnPeConfirmTag');
  if (!inp) return;
  const tag = (tagValue || inp.value).trim();
  inp.value = ''; inp.style.width = '72px';
  if (btn) btn.style.display = 'none';
  if (!tag || _peTags.includes(tag)) return;
  _peTags.push(tag);
  _peRenderTagPool(); // добавит новый тег в пул как выбранный
  _editDirty = true;
}

// ── File attachment ──

function _peRenderFile() {
  const el = document.getElementById('peFileInfo');
  if (!el) return;
  if (_peFile) {
    const size = PR_Utils.fmtBytes(_peFile.size || 0);
    el.innerHTML = `<div class="pr-file-row">
      <span>${PR_Utils.iconFor(_peFile.name)} ${PR_Utils.esc(_peFile.name)} <span class="pr-file-size">(${size})</span></span>
      <button class="pr-file-remove" id="btnPeFileRemove">×</button>
    </div>`;
    document.getElementById('btnPeFileRemove')?.addEventListener('click', () => {
      _peFile = null;
      _peRenderFile();
      _editDirty = true;
    });
  } else {
    el.innerHTML = '';
  }
}

document.getElementById('btnPeAttachFile')?.addEventListener('click', () => {
  document.getElementById('peFileInput')?.click();
});

function _peHandleFile(file) {
  if (!file) return;
  const MAX = 5 * 1024 * 1024;
  if (file.size > MAX) { setStatus(PR_i18n.t('prompts.file_too_large'), 'error'); return; }
  const reader = new FileReader();
  reader.onload = () => {
    const b64 = reader.result.split(',')[1];
    _peFile = { name: file.name, mime: file.type, size: file.size, data_b64: b64 };
    _peRenderFile();
    _editDirty = true;
  };
  reader.readAsDataURL(file);
}

document.getElementById('peFileInput')?.addEventListener('change', e => {
  _peHandleFile(e.target.files?.[0]);
  e.target.value = '';
});

// Drag-and-drop on the drop zone
const _dropZone = document.getElementById('peDropZone');
if (_dropZone) {
  _dropZone.addEventListener('click', () => document.getElementById('peFileInput')?.click());
  _dropZone.addEventListener('dragover', e => { e.preventDefault(); _dropZone.classList.add('drag-over'); });
  _dropZone.addEventListener('dragleave', () => _dropZone.classList.remove('drag-over'));
  _dropZone.addEventListener('drop', e => {
    e.preventDefault();
    _dropZone.classList.remove('drag-over');
    _peHandleFile(e.dataTransfer.files?.[0]);
  });
}

// ── Favorite ──

function _peUpdateFavoriteBtn() {
  const btn = document.getElementById('btnPeFavorite');
  if (!btn) return;
  btn.classList.toggle('active', _peFavorite);
  btn.innerHTML = _peFavorite
    ? '<svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M6 1l1.5 3.1L11 4.5 8.5 7l.6 3.5L6 8.8 2.9 10.5l.6-3.5L1 4.5l3.5-.4L6 1z" fill="#f59e0b"/></svg> ' + PR_i18n.t('prompts.in_favorites')
    : '<svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M6 1l1.5 3.1L11 4.5 8.5 7l.6 3.5L6 8.8 2.9 10.5l.6-3.5L1 4.5l3.5-.4L6 1z" stroke="currentColor" stroke-width="1" fill="none"/></svg> ' + PR_i18n.t('prompts.add_favorite');
}

document.getElementById('btnPeFavorite')?.addEventListener('click', () => {
  _peFavorite = !_peFavorite;
  _peUpdateFavoriteBtn();
  _editDirty = true;
});

// ── Preview ──

function _peUpdatePreview() {
  const el = document.getElementById('pePreview');
  const textArea = document.getElementById('peText');
  if (!el || !textArea) return;
  const text = textArea.value || '';
  if (!text.trim()) {
    el.innerHTML = `<span class="pr-preview-empty">${PR_i18n.t('prompts.preview_empty')}</span>`;
    return;
  }
  const highlighted = PR_Utils.esc(text).replace(/\{\{([^}]+)\}\}/g,
    '<span class="pr-var-highlight">{{$1}}</span>'
  );
  el.innerHTML = highlighted;
}

// Toggle preview visibility
document.getElementById('pePreviewToggle')?.addEventListener('click', () => {
  const section = document.getElementById('pePreviewSection');
  const arrow   = document.getElementById('pePreviewArrow');
  if (!section) return;
  const collapsed = section.classList.toggle('pe-collapsed');
  if (arrow) arrow.style.transform = collapsed ? 'rotate(-90deg)' : '';
});

function _peUpdateCharCount() {
  const el = document.getElementById('peCharCount');
  const textArea = document.getElementById('peText');
  if (!el || !textArea) return;
  el.textContent = textArea.value.length + ' / 4000 ' + PR_i18n.t('prompts.chars');
}

function _peUpdateVarHint() {
  const el = document.getElementById('peVarHint');
  const textArea = document.getElementById('peText');
  if (!el || !textArea) return;
  const hasVars = /\{\{[^}]+\}\}/.test(textArea.value);
  el.style.display = hasVars ? '' : 'none';
}

// Textarea live updates
document.getElementById('peText')?.addEventListener('input', () => {
  _peUpdatePreview();
  _peUpdateCharCount();
  _peUpdateVarHint();
  _editDirty = true;
});
document.getElementById('peTitle')?.addEventListener('input', () => { _editDirty = true; });

// ── Save ──

document.getElementById('btnPeSave')?.addEventListener('click', async () => {
  const titleInput = document.getElementById('peTitle');
  const textArea   = document.getElementById('peText');

  const title = (titleInput?.value || '').trim();
  const text  = (textArea?.value || '').trim();

  // Validation: title required
  if (!title) {
    setStatus(PR_i18n.t('prompts.title_required'), 'error');
    titleInput?.focus();
    return;
  }

  // Validation: text must be meaningful (not just whitespace/punctuation)
  const meaningful = text.replace(/[\s\-—–,.\;:!?'"(){}[\]\/\\|`~@#$%^&*+=<>]/g, '');
  if (!meaningful) {
    setStatus(PR_i18n.t('prompts.text_required'), 'error');
    textArea?.focus();
    return;
  }

  // Check for uncommitted tag text
  const tagInp = document.getElementById('peTagInput');
  const pendingTag = (tagInp?.value || '').trim();
  if (pendingTag) {
    const addIt = await PR_Utils.customConfirm(
      `Добавить тег «${pendingTag}»?`,
      { confirmText: '+ Добавить', cancelText: 'Пропустить' }
    );
    if (addIt && !_peTags.includes(pendingTag)) {
      _peTags.push(pendingTag);
    }
    if (tagInp) { tagInp.value = ''; tagInp.style.width = '72px'; }
    const confirmBtn = document.getElementById('btnPeConfirmTag');
    if (confirmBtn) confirmBtn.style.display = 'none';
  }

  const prompt = {
    prompt_id:   _editPromptId || undefined,
    title,
    text,
    tags:        [..._peTags],
    favorite:    _peFavorite,
  };

  await PromptsDB.save(prompt);
  const savedId = prompt.prompt_id;

  // Handle file
  if (_peFile && _peFile.data_b64) {
    await PromptsDB.attachFile(savedId, _peFile.name, _peFile.mime, _peFile.size, _peFile.data_b64);
  } else if (!_peFile && _editPromptId) {
    // File was removed
    await PromptsDB.detachFile(savedId).catch(() => {});
  }

  setStatus(PR_i18n.t('prompts.toast_saved'), 'success');
  _editDirty = false;
  showScreen('prompts');
});

// ── Delete from editor ──

document.getElementById('btnPeDelete')?.addEventListener('click', async () => {
  if (!_editPromptId) return;
  const ok = await PR_Utils.customConfirm(PR_i18n.t('prompts.delete_confirm'), {
    confirmText: PR_i18n.t('prompts.delete'), cancelText: PR_i18n.t('dlg.cancel'), danger: true
  });
  if (!ok) return;
  await PromptsDB.softDelete(_editPromptId);
  setStatus(PR_i18n.t('prompts.toast_deleted'), 'success');
  _editDirty = false;
  showScreen('prompts');
});

// ── Back with dirty check ──

document.getElementById('btnPeBack')?.addEventListener('click', async () => {
  if (_editDirty) {
    const ok = await PR_Utils.customConfirm(PR_i18n.t('prompts.unsaved_confirm'), {
      confirmText: PR_i18n.t('prompts.leave'), cancelText: PR_i18n.t('dlg.cancel')
    });
    if (!ok) return;
  }
  showScreen('prompts');
});


// ═══════════════════════════════════════════════════════════
// SCREEN 3 — PROMPT TRASH (screenPromptTrash)
// ═══════════════════════════════════════════════════════════

async function initPromptTrashScreen() {
  const listEl  = document.getElementById('promptTrashList');
  const emptyEl = document.getElementById('promptTrashEmpty');
  if (!listEl) return;

  const trashed = await PromptsDB.listTrashed().catch(() => []);

  if (trashed.length === 0) {
    listEl.innerHTML = '';
    if (emptyEl) emptyEl.style.display = 'block';
    return;
  }
  if (emptyEl) emptyEl.style.display = 'none';

  listEl.innerHTML = trashed.map(p => {
    const deleted = PR_Utils.fmtDate(p.deleted_at || '');
    return `<div class="pr-trash-card" data-trash-id="${p.prompt_id}">
      <div class="pr-trash-title">${PR_Utils.esc(p.title)}</div>
      <div class="pr-trash-meta">${PR_i18n.t('prompts.deleted_at')} ${deleted}</div>
      <div class="pr-trash-actions">
        <button class="pr-trash-restore" data-trestore="${p.prompt_id}">${PR_i18n.t('prompts.restore')}</button>
        <button class="pr-trash-permadel" data-tperm="${p.prompt_id}">${PR_i18n.t('prompts.delete_forever')}</button>
      </div>
    </div>`;
  }).join('');
}

document.getElementById('promptTrashList')?.addEventListener('click', async e => {
  const restoreBtn = e.target.closest('[data-trestore]');
  if (restoreBtn) {
    await PromptsDB.restore(restoreBtn.dataset.trestore);
    initPromptTrashScreen();
    return;
  }
  const permBtn = e.target.closest('[data-tperm]');
  if (permBtn) {
    const ok = await PR_Utils.customConfirm(PR_i18n.t('prompts.permdelete_confirm'), {
      confirmText: PR_i18n.t('prompts.delete_forever'), cancelText: PR_i18n.t('dlg.cancel'), danger: true
    });
    if (!ok) return;
    await PromptsDB.permanentDelete(permBtn.dataset.tperm);
    setStatus(PR_i18n.t('prompts.toast_permdeleted'), 'success');
    initPromptTrashScreen();
    // Sync Drive in background so deleted prompt is removed immediately, not on next manual sync
    _promptsSyncToDriveQuiet();
  }
});

document.getElementById('btnPtBack')?.addEventListener('click', () => showScreen('prompts'));


/*
═══════════════════════════════════════════════════════════════
  INTEGRATION GUIDE — what to add in other files
═══════════════════════════════════════════════════════════════

──────────────────────────────────────────────────────
1. content-bundle.js — add inside chrome.runtime.onMessage handler:
──────────────────────────────────────────────────────

  if (msg.action === 'INJECT_PROMPT_APPEND') {
    const adapter = getAdapter();
    const input   = adapter?.findInput() || document.querySelector(SELECTORS.INPUTS);
    if (!input) { showToast('Поле ввода не найдено', 'error'); sendResponse({ success: false }); return true; }

    // Get current text
    let current = '';
    if (input instanceof HTMLTextAreaElement) {
      current = input.value || '';
    } else {
      current = input.innerText || '';
    }

    // Append (not replace)
    const separator = current.trim().length > 0 ? '\n\n' : '';
    const fullText  = current + separator + msg.text;

    const injectFn = adapter?.inject ?? injectContentEditable;
    const ok = injectFn(input, fullText);
    showToast('Промпт добавлен', 'success');
    sendResponse({ success: !!ok });
    return true;
  }

  if (msg.action === 'INJECT_PROMPT_FILE') {
    // Reuse existing file inject mechanism
    const adapter = getAdapter();
    const dropTarget = adapter?.findDropTarget?.() || document.querySelector(SELECTORS.INPUTS);
    if (!dropTarget || !msg.data_b64) { sendResponse({ success: false }); return true; }
    try {
      const bytes = Uint8Array.from(atob(msg.data_b64), c => c.charCodeAt(0));
      const file  = new File([bytes], msg.filename, { type: msg.mime || 'application/octet-stream' });
      const dt    = new DataTransfer();
      dt.items.add(file);
      dropTarget.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true }));
      sendResponse({ success: true });
    } catch (err) {
      console.error('[PR] inject prompt file error:', err);
      sendResponse({ success: false });
    }
    return true;
  }


──────────────────────────────────────────────────────
2. popup-shell.js — modify SCREENS array and showScreen:
──────────────────────────────────────────────────────

  const SCREENS = ['screenMain', 'screenHistory', 'screenDonate', 'screenBug',
                   'screenMap', 'screenTrash', 'screenSettings',
                   'screenPrompts', 'screenPromptEdit', 'screenPromptTrash'];

  // Inside showScreen function, add:
  if (name === 'prompts')      initPromptsScreen();
  if (name === 'promptEdit')   initPromptEditScreen();
  if (name === 'promptTrash')  initPromptTrashScreen();

  // Add navigation:
  document.getElementById('btnPrompts')?.addEventListener('click', () => showScreen('prompts'));
  document.getElementById('btnPromptsBack')?.addEventListener('click', () => showScreen('main'));


──────────────────────────────────────────────────────
3. popup.html — add <script src="prompts.js"></script>
   BEFORE popup-shell.js in the script list.
──────────────────────────────────────────────────────


──────────────────────────────────────────────────────
4. i18n.js — add these keys to STRINGS.ru and STRINGS.en:
──────────────────────────────────────────────────────

  // ru:
  'prompts.title': 'Промпт-библиотека',
  'prompts.back': 'Назад',
  'prompts.create': '+ Создать',
  'prompts.search_ph': 'Поиск по названию или тегу…',
  'prompts.insert': 'Вставить',
  'prompts.edit': 'Редакт.',
  'prompts.delete': 'Удалить',
  'prompts.delete_confirm': 'Удалить промпт в корзину?',
  'prompts.no_match': 'Ничего не найдено',
  'prompts.empty_title': 'Библиотека пуста',
  'prompts.empty_sub': 'Создайте первый промпт для быстрой вставки в любую LLM',
  'prompts.empty_btn': '+ Создать промпт',
  'prompts.toast_inserted': 'Промпт добавлен в чат',
  'prompts.toast_saved': 'Промпт сохранён',
  'prompts.toast_deleted': 'Промпт в корзине',
  'prompts.toast_permdeleted': 'Промпт удалён навсегда',
  'prompts.edit_title_new': 'Новый промпт',
  'prompts.edit_title_edit': 'Редактирование',
  'prompts.save': 'Сохранить',
  'prompts.title_required': 'Введите название промпта',
  'prompts.text_required': 'Текст промпта не может быть пустым или содержать только знаки пунктуации',
  'prompts.field_title_ph': 'Название промпта',
  'prompts.field_text_ph': 'Текст промпта…\n\nПоддерживаются переменные: {{имя}}, {{дата}}',
  'prompts.field_tag_ph': 'Добавить тег…',
  'prompts.attach_file': '📎 Файл',
  'prompts.file_too_large': 'Файл слишком большой (макс 5 МБ)',
  'prompts.add_favorite': 'В избранное',
  'prompts.in_favorites': 'В избранном',
  'prompts.preview_label': 'Превью',
  'prompts.preview_empty': 'Начните вводить текст промпта…',
  'prompts.chars': 'симв.',
  'prompts.var_hint': 'Переменные {{…}} будут запрошены перед вставкой',
  'prompts.var_prompt': 'Введите значение для «{{name}}»:',
  'prompts.unsaved_confirm': 'Есть несохранённые изменения. Выйти?',
  'prompts.leave': 'Выйти',
  'prompts.empty_text': 'Промпт пустой',
  'prompts.sync': 'Синхр.',
  'prompts.syncing': 'Синхронизация…',
  'prompts.sync_ok': 'Промпты синхронизированы',
  'prompts.sync_error': 'Ошибка синхронизации',
  'prompts.sync_need_login': 'Войдите в Google аккаунт в Настройках',
  'prompts.deleted_at': 'Удалён',
  'prompts.restore': 'Восстановить',
  'prompts.delete_forever': 'Удалить навсегда',
  'prompts.permdelete_confirm': 'Промпт будет удалён навсегда, включая бэкап на Google Drive при следующей синхронизации.',
  'prompts.trash_title': 'Корзина промптов',
  'prompts.trash_empty': 'Корзина пуста',
  'prompts.nav_label': 'Промпты',

  // en:
  'prompts.title': 'Prompt Library',
  'prompts.back': 'Back',
  'prompts.create': '+ Create',
  'prompts.search_ph': 'Search by title or tag…',
  'prompts.insert': 'Insert',
  'prompts.edit': 'Edit',
  'prompts.delete': 'Delete',
  'prompts.delete_confirm': 'Move prompt to trash?',
  'prompts.no_match': 'Nothing found',
  'prompts.empty_title': 'Library is empty',
  'prompts.empty_sub': 'Create your first prompt for quick insertion into any LLM',
  'prompts.empty_btn': '+ Create Prompt',
  'prompts.toast_inserted': 'Prompt added to chat',
  'prompts.toast_saved': 'Prompt saved',
  'prompts.toast_deleted': 'Prompt moved to trash',
  'prompts.toast_permdeleted': 'Prompt permanently deleted',
  'prompts.edit_title_new': 'New Prompt',
  'prompts.edit_title_edit': 'Edit Prompt',
  'prompts.save': 'Save',
  'prompts.title_required': 'Enter a prompt title',
  'prompts.text_required': 'Prompt text cannot be empty or contain only punctuation',
  'prompts.field_title_ph': 'Prompt title',
  'prompts.field_text_ph': 'Prompt text…\n\nSupports variables: {{name}}, {{date}}',
  'prompts.field_tag_ph': 'Add tag…',
  'prompts.attach_file': '📎 File',
  'prompts.file_too_large': 'File too large (max 5 MB)',
  'prompts.add_favorite': 'Add to favorites',
  'prompts.in_favorites': 'In favorites',
  'prompts.preview_label': 'Preview',
  'prompts.preview_empty': 'Start typing your prompt…',
  'prompts.chars': 'chars',
  'prompts.var_hint': 'Variables {{…}} will be prompted before insertion',
  'prompts.var_prompt': 'Enter value for "{{name}}":',
  'prompts.unsaved_confirm': 'Unsaved changes. Leave?',
  'prompts.leave': 'Leave',
  'prompts.empty_text': 'Prompt is empty',
  'prompts.sync': 'Sync',
  'prompts.syncing': 'Syncing…',
  'prompts.sync_ok': 'Prompts synced',
  'prompts.sync_error': 'Sync error',
  'prompts.sync_need_login': 'Sign into Google account in Settings',
  'prompts.deleted_at': 'Deleted',
  'prompts.restore': 'Restore',
  'prompts.delete_forever': 'Delete forever',
  'prompts.permdelete_confirm': 'Prompt will be permanently deleted, including from Google Drive backup on next sync.',
  'prompts.trash_title': 'Prompt Trash',
  'prompts.trash_empty': 'Trash is empty',
  'prompts.nav_label': 'Prompts',

*/
