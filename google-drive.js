/**
 * SessionPort — google-drive.js
 * Google Drive backup / cross-browser sync via chrome.identity.
 * Runs in popup context only (has access to SessionPortDB).
 *
 * Security notes:
 *  — Tokens never stored or logged; chrome.identity caches them.
 *  — Scope: drive.file (only files created by this extension).
 *  — Token revoked server-side on sign-out.
 *  — All Drive API calls use Authorization header, never URL params.
 *  — Restored JSON validated before DB import.
 *  — File IDs validated against safe-char regex before use in URLs.
 */

const GDRIVE_FOLDER          = 'SessionPort Backups';
const GDRIVE_MAX_BACKUPS     = 5;
const GDRIVE_MAX_RESTORE_MB  = 50;
const _GDRIVE_SETUP_TOKEN    = ''; // set your OAuth client_id in manifest.json → oauth2.client_id

// ── Token helpers ─────────────────────────────────────────

function _gdToken(interactive) {
  return new Promise((resolve, reject) => {
    chrome.identity.getAuthToken({ interactive }, token => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else if (!token)              reject(new Error('No token'));
      else                          resolve(token);
    });
  });
}

function _gdDropToken(token) {
  return new Promise(r => chrome.identity.removeCachedAuthToken({ token }, r));
}

async function _gdFetch(token, url, opts = {}) {
  const r = await fetch(url, {
    ...opts,
    headers: { Authorization: `Bearer ${token}`, ...(opts.headers || {}) }
  });
  if (r.status === 401) {
    await _gdDropToken(token);
    throw new Error('AUTH_EXPIRED');
  }
  return r;
}

// ── Setup check ───────────────────────────────────────────

function gdrive_isConfigured() {
  const m = chrome.runtime.getManifest();
  const cid = m.oauth2?.client_id || '';
  return cid.length > 10 && !cid.includes('YOUR_GOOGLE');
}

// ── Connect / disconnect ──────────────────────────────────

async function gdrive_connect() {
  if (!gdrive_isConfigured()) throw new Error('SETUP_REQUIRED');

  const token = await _gdToken(true);
  const r = await _gdFetch(token, 'https://www.googleapis.com/oauth2/v2/userinfo');
  if (!r.ok) throw new Error(`userinfo ${r.status}`);
  const profile = await r.json();
  if (!profile.id || !profile.email) throw new Error('Invalid profile');

  const userId = 'pr_' + profile.id.slice(0, 12);
  await chrome.storage.local.set({
    gd_connected: true,
    gd_email:    profile.email,
    gd_user_id:  userId,
    pr_user_id:  userId
  });
  return profile;
}

async function gdrive_disconnect() {
  const token = await _gdToken(false).catch(() => null);
  if (token) {
    // Revoke server-side first
    await fetch(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(token)}`).catch(() => {});
    await _gdDropToken(token);
  }
  await new Promise(r => chrome.identity.clearAllCachedAuthTokens(r));
  await chrome.storage.local.remove([
    'gd_connected', 'gd_email', 'gd_user_id', 'gd_folder_id',
    'gd_last_backup', 'gd_interval', 'gd_last_sync'
  ]);
  chrome.alarms.clear('gdrive_backup', () => {});
}

async function gdrive_getState() {
  return new Promise(resolve => {
    chrome.storage.local.get(
      ['gd_connected', 'gd_email', 'gd_user_id', 'gd_last_backup', 'gd_interval'],
      r => resolve({
        connected:  !!r.gd_connected,
        email:      r.gd_email    || null,
        userId:     r.gd_user_id  || null,
        lastBackup: r.gd_last_backup || null,
        interval:   r.gd_interval || 'off'
      })
    );
  });
}

// ── Drive folder ──────────────────────────────────────────

async function _gdFolder(token) {
  const { gd_folder_id } = await new Promise(r =>
    chrome.storage.local.get('gd_folder_id', r)
  );
  if (gd_folder_id) {
    const check = await _gdFetch(
      token,
      `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(gd_folder_id)}?fields=id,trashed`
    ).catch(() => null);
    if (check?.ok) {
      const f = await check.json();
      if (!f.trashed) return gd_folder_id;
    }
    await chrome.storage.local.remove('gd_folder_id');
  }

  const q = encodeURIComponent(
    `name='${GDRIVE_FOLDER}' and mimeType='application/vnd.google-apps.folder' and trashed=false`
  );
  const sr = await _gdFetch(token,
    `https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id)&pageSize=1`
  );
  if (!sr.ok) throw new Error(`Drive list ${sr.status}`);
  const { files } = await sr.json();
  if (files?.length) {
    await chrome.storage.local.set({ gd_folder_id: files[0].id });
    return files[0].id;
  }

  const cr = await _gdFetch(token, 'https://www.googleapis.com/drive/v3/files?fields=id', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: GDRIVE_FOLDER, mimeType: 'application/vnd.google-apps.folder' })
  });
  if (!cr.ok) throw new Error(`Drive mkdir ${cr.status}`);
  const folder = await cr.json();
  await chrome.storage.local.set({ gd_folder_id: folder.id });
  return folder.id;
}

// ── Backup ────────────────────────────────────────────────

async function gdrive_runBackup() {
  const token    = await _gdToken(false);
  const folderId = await _gdFolder(token);
  const json     = await SessionPortDB.exportAll();

  const ts   = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const name = `sessionport-backup-${ts}.json`;

  const form = new FormData();
  form.append('metadata', new Blob([JSON.stringify({
    name, parents: [folderId], mimeType: 'application/json'
  })], { type: 'application/json' }));
  form.append('file', new Blob([json], { type: 'application/json' }));

  const r = await _gdFetch(token,
    'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,size',
    { method: 'POST', body: form }
  );
  if (!r.ok) throw new Error(`Upload ${r.status}`);
  const file = await r.json();

  await chrome.storage.local.set({ gd_last_backup: Date.now() });
  _gdPrune(token, folderId).catch(() => {});
  return { name: file.name, size: parseInt(file.size || 0) };
}

// ── Prune old backups ─────────────────────────────────────

async function _gdPrune(token, folderId) {
  const q = encodeURIComponent(`'${folderId}' in parents and trashed=false`);
  const r = await _gdFetch(token,
    `https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id,createdTime)&orderBy=createdTime+desc&pageSize=50`
  );
  if (!r.ok) return;
  const { files } = await r.json();
  if (!files || files.length <= GDRIVE_MAX_BACKUPS) return;
  for (const f of files.slice(GDRIVE_MAX_BACKUPS)) {
    _gdFetch(token, `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(f.id)}`,
      { method: 'DELETE' }
    ).catch(() => {});
  }
}

// ── List backups ──────────────────────────────────────────

async function gdrive_listBackups() {
  const token    = await _gdToken(false);
  const folderId = await _gdFolder(token);
  const q = encodeURIComponent(`'${folderId}' in parents and trashed=false and mimeType='application/json'`);
  const r = await _gdFetch(token,
    `https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id,name,size,createdTime)&orderBy=createdTime+desc&pageSize=20`
  );
  if (!r.ok) throw new Error(`List ${r.status}`);
  const { files } = await r.json();
  return files || [];
}

// ── Restore ───────────────────────────────────────────────

async function gdrive_restoreBackup(fileId) {
  if (!/^[a-zA-Z0-9_\-]+$/.test(fileId)) throw new Error('Invalid file ID');

  const token = await _gdToken(false);
  const r = await _gdFetch(token,
    `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`
  );
  if (!r.ok) throw new Error(`Download ${r.status}`);

  const cl = parseInt(r.headers.get('content-length') || '0');
  if (cl > GDRIVE_MAX_RESTORE_MB * 1_000_000) throw new Error('File too large');

  const text = await r.text();
  if (text.length > GDRIVE_MAX_RESTORE_MB * 1_000_000) throw new Error('File too large');

  // Validate structure before touching DB
  let parsed;
  try { parsed = JSON.parse(text); } catch { throw new Error('Invalid JSON'); }
  if (parsed.schema_version !== 1 || !Array.isArray(parsed.snapshots)) {
    throw new Error('Not a valid SessionPort backup');
  }

  await SessionPortDB.importAll(text);
  return parsed.snapshots.length;
}

// ── Auto-backup interval ──────────────────────────────────

async function gdrive_setInterval(val) {
  await chrome.storage.local.set({ gd_interval: val });
  chrome.alarms.clear('gdrive_backup', () => {});
  const mins = { '6h': 360, '24h': 1440, '7d': 10080 }[val];
  if (mins) chrome.alarms.create('gdrive_backup', { periodInMinutes: mins });
}

// ── Two-way sync (canonical file: pull → merge → push) ────
// Cross-device merge medium. One file per account in the user's own Drive; both
// this browser and (later) the iOS app read/write it. Conflict resolution is
// per-snapshot last-write-wins via state_at inside SessionPortDB.applySyncMerge.
const GDRIVE_SYNC_FILE = 'sessionport-sync.json';

async function _gdSyncFileId(token, folderId) {
  const q = encodeURIComponent(
    `name='${GDRIVE_SYNC_FILE}' and '${folderId}' in parents and trashed=false`
  );
  const r = await _gdFetch(token,
    `https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id)&pageSize=1`);
  if (!r.ok) throw new Error(`Sync list ${r.status}`);
  const { files } = await r.json();
  return files?.[0]?.id || null;
}

async function gdrive_syncNow() {
  const token    = await _gdToken(false);
  const folderId = await _gdFolder(token);
  let fileId     = await _gdSyncFileId(token, folderId);
  let pulled     = { added: 0, updated: 0 };

  // 1) Pull remote canonical file (if any) and merge into the local DB.
  if (fileId) {
    const dl = await _gdFetch(token,
      `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`);
    if (!dl.ok) throw new Error(`Sync download ${dl.status}`);
    const text = await dl.text();
    if (text.length > GDRIVE_MAX_RESTORE_MB * 1_000_000) throw new Error('Sync file too large');
    let parsed;
    try { parsed = JSON.parse(text); } catch { throw new Error('Invalid sync file'); }
    if (parsed.schema_version !== 1 || !Array.isArray(parsed.snapshots)) {
      throw new Error('Not a valid SessionPort sync file');
    }
    pulled = await SessionPortDB.applySyncMerge(text);
  }

  // 2) Push the merged whole-DB export back to the same canonical file.
  const merged = await SessionPortDB.exportAll();
  if (fileId) {
    const up = await _gdFetch(token,
      `https://www.googleapis.com/upload/drive/v3/files/${fileId}?uploadType=media&fields=id`,
      { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: merged });
    if (!up.ok) throw new Error(`Sync upload ${up.status}`);
  } else {
    const form = new FormData();
    form.append('metadata', new Blob([JSON.stringify({
      name: GDRIVE_SYNC_FILE, parents: [folderId], mimeType: 'application/json'
    })], { type: 'application/json' }));
    form.append('file', new Blob([merged], { type: 'application/json' }));
    const cr = await _gdFetch(token,
      'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id',
      { method: 'POST', body: form });
    if (!cr.ok) throw new Error(`Sync create ${cr.status}`);
    fileId = (await cr.json()).id;
  }

  await chrome.storage.local.set({ gd_last_sync: Date.now() });
  return { pulled, syncedAt: Date.now() };
}
