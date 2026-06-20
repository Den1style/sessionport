/**
 * SessionPort — db.js  v1.2.9
 * IndexedDB module. Extension origin only (background.js, popup).
 * DO NOT import from content.js.
 *
 * FIXED (audit pass 1+2):
 *  - Removed duplicate getSnapshot declaration
 *  - importAll: new tx per record (TransactionInactiveError fix)
 *  - gcBlobs: use tx on objectStore not on store (naming fix + onerror)
 *  - attachFile: tx.oncomplete as resolve trigger + onerror on addReq
 *  - getSnapshotFiles: single tx for all blob gets (TransactionInactiveError fix)
 *  - openDB: onblocked + onversionchange handlers
 *  - web_accessible_resources: db.js removed (handled in manifest)
 *  - listAll/getSnapshot/renameProject unified into single export block
 */

const DB_NAME    = 'sessionport_v1';
const DB_VERSION = 4;
const DEDUP_WINDOW_MS = 10 * 1000;

let _db = null;

// ─── Open / Init ──────────────────────────────────────────

function openDB() {
  // Если _db открыта но версия устарела — закрываем и переоткрываем
  if (_db) {
    if (_db.version === DB_VERSION) return Promise.resolve(_db);
    _db.close(); _db = null;
  }

  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);

    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      const oldVersion = e.oldVersion;

      if (oldVersion < 1) {
        const snapshots = db.createObjectStore('snapshots', { keyPath: 'snapshot_id' });
        snapshots.createIndex('by_project_time', ['project', 'created_at'], { unique: false });
        snapshots.createIndex('by_parent',       'parent_id',               { unique: false });
        snapshots.createIndex('by_hash',         'content_hash',            { unique: false });
        db.createObjectStore('refs', { keyPath: 'name' });
        db.createObjectStore('meta', { keyPath: 'key' });
      }

      if (oldVersion < 2) {
        const blobs = db.createObjectStore('blobs', { keyPath: 'hash' });
        blobs.createIndex('by_ref_count', 'ref_count', { unique: false });
        const sf = db.createObjectStore('snapshot_files', {
          keyPath: 'id', autoIncrement: true
        });
        sf.createIndex('by_snapshot', 'snapshot_id', { unique: false });
        sf.createIndex('by_hash',     'hash',        { unique: false });
      }

      if (oldVersion < 3) {
        // Add transfer_id indexes for distributed identity (cross-device chain reconstruction)
        const tx = e.target.transaction;
        const snapshots = tx.objectStore('snapshots');
        if (!snapshots.indexNames.contains('by_transfer_id')) {
          snapshots.createIndex('by_transfer_id',        'transfer_id',        { unique: false });
        }
        if (!snapshots.indexNames.contains('by_parent_transfer_id')) {
          snapshots.createIndex('by_parent_transfer_id', 'parent_transfer_id', { unique: false });
        }
      }

      // FIX #3: upgrade by_transfer_id to unique index for atomic dedup
      if (oldVersion < 4) {
        const tx4 = e.target.transaction;
        const sn4 = tx4.objectStore('snapshots');
        if (sn4.indexNames.contains('by_transfer_id')) {
          try {
            sn4.deleteIndex('by_transfer_id');
            sn4.createIndex('by_transfer_id', 'transfer_id', { unique: true });
          } catch (err) {
            console.warn('[PR-DB] v4 migration: could not make by_transfer_id unique:', err.message);
            if (!sn4.indexNames.contains('by_transfer_id')) {
              sn4.createIndex('by_transfer_id', 'transfer_id', { unique: false });
            }
          }
        }
      }
    };

    // onblocked — другая вкладка держит старую версию.
    // Timeout after 10s to prevent forever-pending promise.
    let _blockedTimer = setTimeout(() => {
      reject(new Error('DB upgrade blocked >10s — close other extension tabs and retry'));
    }, 10_000);
    req.onblocked = () => {
      console.warn('[PR-DB] upgrade blocked — waiting for other connections to close');
    };

    req.onsuccess = (e) => {
      clearTimeout(_blockedTimer);
      _db = e.target.result;
      // versionchange — более новая версия открыта в другом месте, закрываем gracefully
      _db.onversionchange = () => {
        _db.close();
        _db = null;
        console.warn('[PR-DB] versionchange — closed old connection');
      };
      resolve(_db);
    };

    req.onerror = (e) => {
      const err = e.target.error;
      // VersionError: открыта более старая версия — сбрасываем _db и ретраим
      if (err?.name === 'VersionError') {
        console.warn('[PR-DB] VersionError — closing stale connection and retrying');
        if (_db) { _db.close(); _db = null; }
        // Небольшая пауза и повторная попытка
        setTimeout(() => openDB().then(resolve).catch(reject), 300);
      } else {
        reject(err);
      }
    };
  });
}

// ─── Helpers ─────────────────────────────────────────────

function tx(storeName, mode = 'readonly') {
  return _db.transaction(storeName, mode).objectStore(storeName);
}

function wrap(req) {
  return new Promise((res, rej) => {
    req.onsuccess = (e) => res(e.target.result);
    req.onerror   = (e) => rej(e.target.error);
  });
}

async function sha256(str) {
  const buf  = new TextEncoder().encode(str);
  const hash = await crypto.subtle.digest('SHA-256', buf);
  return Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, '0')).join('');
}

async function sha256Bytes(bytes) {
  const hash = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, '0')).join('');
}

function makeId() {
  return `ps_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`;
}

function bufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK)
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  return btoa(binary);
}

function base64ToBytes(b64) {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

// ─── Meta ────────────────────────────────────────────────

async function getMeta(key) {
  await openDB();
  const rec = await wrap(tx('meta').get(key));
  return rec ? rec.value : null;
}

async function setMeta(key, value) {
  await openDB();
  return wrap(tx('meta', 'readwrite').put({ key, value }));
}

// ─── Core API ────────────────────────────────────────────

async function saveSnapshot(payload, source_host) {
  await openDB();

  const project            = payload?.meta?.project || 'unknown';
  const transfer_id        = payload?.meta?.transfer_id || null;
  const parent_transfer_id = payload?.meta?.parent_transfer_id || null;
  const now                = new Date().toISOString();

  // Одна сериализация для hash и size
  const payloadStr   = JSON.stringify(payload);
  // FIX (synced from background.js): reject oversized payloads
  const MAX_PAYLOAD_BYTES = 1_000_000;
  if (payloadStr.length > MAX_PAYLOAD_BYTES) {
    throw new Error(`Payload too large: ${payloadStr.length} bytes (max ${MAX_PAYLOAD_BYTES})`);
  }
  const content_hash = await sha256(payloadStr);
  const size_bytes   = payloadStr.length;

  // Dedup priority 1 (canonical): same transfer_id — O(log n) через by_transfer_id индекс
  // Выполняем ДО основной транзакции — async gaps внутри readwrite транзакции
  // вызывают TransactionInactiveError (IndexedDB autocommit между requests).
  if (transfer_id) {
    const dup = await getByTransferId(transfer_id);
    if (dup) return null;
  }

  // Dedup priority 2: same content_hash в том же проекте за DEDUP_WINDOW_MS
  const recentCutoff  = new Date(Date.now() - DEDUP_WINDOW_MS).toISOString();
  const allForProject = await listByProject(project, { limit: 20 });
  const isDup = allForProject.some(s =>
    s.content_hash === content_hash && s.created_at > recentCutoff
  );
  if (isDup) return null;

  const active_id   = await getMeta('active_snapshot_id');
  const snapshot_id = makeId();

  const snapshot = {
    snapshot_id,
    created_at:   now,
    state_at:     now,   // bumped on soft-delete/restore; drives sync last-write-wins
    source_host,
    target_host:  null,
    project,
    version:            payload?.meta?.version || '',
    parent_id:          active_id || null,
    transfer_id,
    parent_transfer_id,
    content_hash,
    payload,
    size_bytes,
  };

  // FIX (synced from background.js): atomic multi-store transaction + ConstraintError dedup
  return new Promise((resolve, reject) => {
    const transaction = _db.transaction(['snapshots', 'refs', 'meta'], 'readwrite');
    const addReq = transaction.objectStore('snapshots').add(snapshot);
    addReq.onerror = (e) => {
      if (e.target.error?.name === 'ConstraintError') {
        e.preventDefault();
        transaction.abort();
        resolve(null);
        return;
      }
    };
    transaction.objectStore('refs').put({ name: `main:${project}`, head_id: snapshot_id, project });
    transaction.objectStore('meta').put({ key: 'active_snapshot_id', value: snapshot_id });
    transaction.oncomplete = () => resolve(snapshot_id);
    transaction.onerror    = e => {
      if (e.target.error?.name === 'ConstraintError') { resolve(null); return; }
      reject(e.target.error);
    };
    transaction.onabort    = () => {};
  });
}

// FIX: single canonical getSnapshot — duplicate removed
async function getSnapshot(id) {
  await openDB();
  return new Promise((res, rej) => {
    const req = _db.transaction('snapshots').objectStore('snapshots').get(id);
    req.onsuccess = e => res(e.target.result || null);
    req.onerror   = e => rej(e.target.error);
  });
}

async function listByProject(project, { limit = 50, offset = 0 } = {}) {
  await openDB();
  return new Promise((resolve, reject) => {
    const index   = tx('snapshots').index('by_project_time');
    const range   = IDBKeyRange.bound([project, ''], [project, '\uffff']);
    const req     = index.openCursor(range, 'prev');
    const results = [];
    let   skipped = 0;
    req.onsuccess = (e) => {
      const cursor = e.target.result;
      if (!cursor) { resolve(results); return; }
      if (skipped < offset) { skipped++; cursor.continue(); return; }
      if (results.length < limit) { results.push(cursor.value); cursor.continue(); }
      else resolve(results);
    };
    req.onerror = (e) => reject(e.target.error);
  });
}

// FIX: single transaction cursor for all items
// FIX #2: `fields` param for projection — skip payload when not needed
async function listAll({ limit = 0, fields = null, includeTrashed = false } = {}) {
  await openDB();
  return new Promise((resolve, reject) => {
    const req     = tx('snapshots').index('by_project_time').openCursor(null, 'prev');
    const results = [];
    req.onsuccess = (e) => {
      const cursor = e.target.result;
      if (!cursor || (limit > 0 && results.length >= limit)) { resolve(results); return; }
      const val = cursor.value;
      if (!includeTrashed && val.deleted_at) { cursor.continue(); return; }
      if (fields) {
        const projected = {};
        for (const f of fields) projected[f] = val[f];
        results.push(projected);
      } else {
        results.push(val);
      }
      cursor.continue();
    };
    req.onerror = e => reject(e.target.error);
  });
}

async function getChain(snapshot_id, maxDepth = 100) {
  await openDB();
  const chain = [];
  let current_id = snapshot_id;
  for (let i = 0; i < maxDepth; i++) {
    if (!current_id) break;
    const s = await getSnapshot(current_id);
    if (!s) break;
    chain.push({ snapshot_id: s.snapshot_id, created_at: s.created_at,
                 source_host: s.source_host,  project: s.project,
                 parent_id:   s.parent_id,    content_hash: s.content_hash,
                 transfer_id: s.transfer_id,  parent_transfer_id: s.parent_transfer_id });
    current_id = s.parent_id;
  }
  return chain;
}

// Lookup snapshot by distributed transfer_id (cross-device).
async function getByTransferId(transfer_id) {
  await openDB();
  return new Promise((resolve, reject) => {
    const req = _db.transaction('snapshots').objectStore('snapshots')
      .index('by_transfer_id').get(transfer_id);
    req.onsuccess = e => resolve(e.target.result || null);
    req.onerror   = e => reject(e.target.error);
  });
}

// Walk the distributed chain via parent_transfer_id pointers (works across devices/projects).
async function getChainByTransferId(transfer_id, maxDepth = 100) {
  await openDB();
  const chain = [];
  let cur = transfer_id;
  for (let i = 0; i < maxDepth; i++) {
    if (!cur) break;
    const s = await getByTransferId(cur);
    if (!s) break;
    chain.push({ snapshot_id: s.snapshot_id, transfer_id: s.transfer_id,
                 parent_transfer_id: s.parent_transfer_id, created_at: s.created_at,
                 source_host: s.source_host, project: s.project });
    cur = s.parent_transfer_id;
  }
  return chain;
}

async function diff(id_a, id_b) {
  const [a, b] = await Promise.all([getSnapshot(id_a), getSnapshot(id_b)]);
  if (!a || !b) return null;
  const pa = a.payload, pb = b.payload;
  const added = [], removed = [], changed = [];

  const arrayKeys = [
    ['ledger', 'critical_decisions'],
    ['ledger', 'veto_list'],
    ['ledger', 'must_preserve'],
    ['ledger', 'working_rules'],
  ];
  for (const [section, key] of arrayKeys) {
    const arrA = pa?.[section]?.[key] || [];
    const arrB = pb?.[section]?.[key] || [];
    const setA = new Set(arrA), setB = new Set(arrB);
    arrB.forEach(v => { if (!setA.has(v)) added.push(`${key}: ${v}`); });
    arrA.forEach(v => { if (!setB.has(v)) removed.push(`${key}: ${v}`); });
  }

  const stringKeys = [['runtime','current_status'],['runtime','immediate_next_step']];
  for (const [section, key] of stringKeys) {
    const vA = pa?.[section]?.[key], vB = pb?.[section]?.[key];
    if (vA !== vB) changed.push({ key: `${section}.${key}`, from: vA, to: vB });
  }
  const l3A = JSON.stringify(pa?.runtime?.last_3_decisions || []);
  const l3B = JSON.stringify(pb?.runtime?.last_3_decisions || []);
  if (l3A !== l3B) changed.push({ key: 'runtime.last_3_decisions', from: l3A, to: l3B });

  const parts = [];
  if (added.length)   parts.push(`+${added.length} added`);
  if (removed.length) parts.push(`-${removed.length} removed`);
  if (changed.length) parts.push(`~${changed.length} changed`);
  return { added, removed, changed, summary: parts.join(', ') || 'no changes' };
}

async function setActive(id) { return setMeta('active_snapshot_id', id); }
async function getActive()   { return getMeta('active_snapshot_id'); }

async function fork(from_id, branch_name) {
  await openDB();
  const s = await getSnapshot(from_id);
  if (!s) throw new Error(`Snapshot ${from_id} not found`);
  await wrap(tx('refs', 'readwrite').put({
    name: `${branch_name}:${s.project}`, head_id: from_id, project: s.project
  }));
  await setActive(from_id);
}

async function markInjected(snapshot_id, target_host) {
  await openDB();
  const s = await getSnapshot(snapshot_id);
  if (!s) return;
  s.target_host = target_host;
  return wrap(tx('snapshots', 'readwrite').put(s));
}

// FIX: renameProject — cursor.continue() always called
async function renameProject(oldName, newName) {
  await openDB();
  return new Promise((resolve, reject) => {
    const transaction = _db.transaction(['snapshots', 'refs'], 'readwrite');

    // 1. Update snapshots
    const snapIdx = transaction.objectStore('snapshots').index('by_project_time');
    const range   = IDBKeyRange.bound([oldName, ''], [oldName, '\uffff']);
    snapIdx.openCursor(range).onsuccess = (e) => {
      const cursor = e.target.result;
      if (!cursor) return;
      const snap = cursor.value;
      snap.project = newName;
      if (snap.payload?.meta) snap.payload.meta.project = newName;
      cursor.update(snap);
      cursor.continue(); // FIX: always continue
    };

    // 2. Update refs
    transaction.objectStore('refs').openCursor().onsuccess = (e) => {
      const cursor = e.target.result;
      if (!cursor) return;
      const ref = cursor.value;
      if (ref.project === oldName) {
        ref.project = newName;
        const oldRefName = ref.name;
        ref.name = ref.name.replace(`:${oldName}`, `:${newName}`);
        if (oldRefName !== ref.name) {
          transaction.objectStore('refs').delete(oldRefName);
          transaction.objectStore('refs').put(ref);
        } else {
          cursor.update(ref);
        }
      }
      cursor.continue(); // FIX: always continue
    };

    transaction.oncomplete = () => resolve(true);
    transaction.onerror    = e => reject(e.target.error);
  });
}

// ─── Export / Import ──────────────────────────────────────

async function exportSelected(snapshotIds) {
  await openDB();
  const idSet = new Set(snapshotIds);
  const getAll = store => new Promise((res, rej) => {
    const r = tx(store).getAll(); r.onsuccess = e => res(e.target.result); r.onerror = e => rej(e.target.error);
  });

  // Filter snapshots
  const allSnaps = await getAll('snapshots');
  const selectedSnaps = allSnaps.filter(s => idSet.has(s.snapshot_id));

  // All refs + meta are global (small), export them as-is
  const [refs, metaRaw] = await Promise.all([getAll('refs'), getAll('meta')]);

  // snapshot_files for selected snapshots + collect blob hashes
  const selectedFiles = [];
  const hashSet = new Set();
  for (const snapId of snapshotIds) {
    const files = await new Promise((res, rej) => {
      const r = tx('snapshot_files').index('by_snapshot').getAll(snapId);
      r.onsuccess = e => res(e.target.result); r.onerror = e => rej(e.target.error);
    });
    for (const f of files) { selectedFiles.push(f); hashSet.add(f.hash); }
  }

  // Blobs for collected hashes
  const selectedBlobs = [];
  for (const hash of hashSet) {
    const blob = await new Promise((res, rej) => {
      const r = tx('blobs').get(hash);
      r.onsuccess = e => res(e.target.result); r.onerror = e => rej(e.target.error);
    });
    if (blob) selectedBlobs.push(blob);
  }

  return JSON.stringify({ schema_version: 1, exported_at: new Date().toISOString(),
    snapshots: selectedSnaps, refs, meta: metaRaw,
    snapshot_files: selectedFiles, blobs: selectedBlobs }, null, 2);
}

async function exportAll() {
  await openDB();
  const getAll = store => new Promise((res, rej) => {
    const r = tx(store).getAll(); r.onsuccess = e => res(e.target.result); r.onerror = e => rej(e.target.error);
  });
  const [snapshots, refs, metaRaw, snapshot_files, blobs] = await Promise.all([
    getAll('snapshots'), getAll('refs'), getAll('meta'), getAll('snapshot_files'), getAll('blobs')
  ]);
  return JSON.stringify({ schema_version: 1, exported_at: new Date().toISOString(),
                          snapshots, refs, meta: metaRaw, snapshot_files, blobs }, null, 2);
}

// FIX: importAll — new tx per record prevents TransactionInactiveError
// FIX #8: atomic batch import
async function importAll(jsonStr) {
  await openDB();
  const data = JSON.parse(jsonStr);
  if (data.schema_version !== 1) throw new Error('Unsupported schema_version: ' + data.schema_version);

  // Scan all existing snapshots, tracking which are soft-deleted (in trash)
  const existingIds   = new Set();
  const trashedIds    = new Set();
  await new Promise((resolve, reject) => {
    const req = tx('snapshots').openCursor();
    req.onsuccess = (e) => {
      const cursor = e.target.result;
      if (!cursor) { resolve(); return; }
      existingIds.add(cursor.key);
      if (cursor.value?.deleted_at) trashedIds.add(cursor.key);
      cursor.continue();
    };
    req.onerror = e => reject(e.target.error);
  });

  const incomingSnaps  = (data.snapshots || []).filter(s => s?.snapshot_id);
  const newSnapshots   = incomingSnaps.filter(s => !existingIds.has(s.snapshot_id));
  // Snapshots that are in the import AND currently in trash → restore them
  const toRestore      = incomingSnaps.filter(s => trashedIds.has(s.snapshot_id));

  // Collect existing snapshot_file keys (snapshot_id:hash) to avoid duplicates
  const existingFileKeys = new Set();
  const allImportSnapIds = new Set((data.snapshots || []).map(s => s.snapshot_id));
  for (const snapId of allImportSnapIds) {
    const existing = await new Promise((res, rej) => {
      const r = tx('snapshot_files').index('by_snapshot').getAll(snapId);
      r.onsuccess = e => res(e.target.result); r.onerror = e => rej(e.target.error);
    });
    for (const f of existing) existingFileKeys.add(snapId + ':' + f.hash);
  }

  // Import files for ALL snapshots in JSON (new + existing), skip true duplicates
  // Strip auto-increment id to avoid ConstraintError
  const filesToImport = (data.snapshot_files || []).filter(f =>
    allImportSnapIds.has(f.snapshot_id) &&
    !existingFileKeys.has(f.snapshot_id + ':' + f.hash)
  );
  const hashesToImport = new Set(filesToImport.map(f => f.hash));
  const blobsToImport  = (data.blobs || []).filter(b => hashesToImport.has(b.hash));

  const stores = ['snapshots', 'refs', 'meta'];
  const hasFiles = filesToImport.length > 0;
  if (hasFiles) { stores.push('snapshot_files', 'blobs'); }

  if (newSnapshots.length || toRestore.length || (data.refs || []).length || (data.meta || []).length || hasFiles) {
    await new Promise((resolve, reject) => {
      const transaction = _db.transaction(stores, 'readwrite');
      const snapStore = transaction.objectStore('snapshots');
      for (const s of newSnapshots) snapStore.add(s);
      // Restore trashed snapshots: clear deleted_at so they reappear in history
      for (const s of toRestore) snapStore.put({ ...s, deleted_at: null });
      for (const r of data.refs || []) transaction.objectStore('refs').put(r);
      for (const m of data.meta || []) transaction.objectStore('meta').put(m);
      if (hasFiles) {
        for (const b of blobsToImport) transaction.objectStore('blobs').put(b);
        for (const f of filesToImport) {
          const { id: _id, ...rest } = f; // strip old auto-increment id
          transaction.objectStore('snapshot_files').add(rest);
        }
      }
      transaction.oncomplete = () => resolve();
      transaction.onerror    = e => reject(e.target.error);
      transaction.onabort    = e => reject(new Error('Import transaction aborted'));
    });
  }

  return { imported: newSnapshots.length, restored: toRestore.length };
}

async function migrateFromFlowState() {
  const migrated = await getMeta('migrated_v1');
  if (migrated) return false;
  return new Promise((resolve) => {
    chrome.storage.local.get('flow_state', async (data) => {
      if (data?.flow_state?.payload) await saveSnapshot(data.flow_state.payload, 'migrated');
      await setMeta('migrated_v1', true);
      resolve(true);
    });
  });
}

// ─── Files API ────────────────────────────────────────────

// FIX: attachFile — tx.oncomplete as single resolve point, onerror on addReq
async function attachFile(snapshot_id, filename, mime, size_bytes, content_b64, label = '') {
  await openDB();
  const bytes = base64ToBytes(content_b64);
  const hash  = 'sha256:' + await sha256Bytes(bytes);

  return new Promise((resolve, reject) => {
    const transaction = _db.transaction(['blobs', 'snapshot_files'], 'readwrite');
    const blobsStore  = transaction.objectStore('blobs');
    const sfStore     = transaction.objectStore('snapshot_files');

    let junction_id  = null;
    let deduplicated = false;

    const getReq = blobsStore.get(hash);
    getReq.onsuccess = () => {
      const existing = getReq.result;
      if (existing) {
        existing.ref_count++;
        blobsStore.put(existing);
        deduplicated = true;
      } else {
        blobsStore.add({ hash, content_b64, mime: mime || 'application/octet-stream',
                         size_bytes, ref_count: 1, created_at: new Date().toISOString() });
      }

      const addReq = sfStore.add({
        snapshot_id, hash, filename, label, attached_at: new Date().toISOString()
      });
      addReq.onsuccess = () => { junction_id = addReq.result; };
      addReq.onerror   = e => reject(e.target.error); // FIX: was missing
    };

    getReq.onerror    = e => reject(e.target.error);
    transaction.oncomplete = () => resolve({ hash, junction_id, deduplicated }); // FIX: single source of truth
    transaction.onerror    = e => reject(e.target.error);
    transaction.onabort    = e => reject(new Error('Transaction aborted'));
  });
}

// FIX: getSnapshotFiles — single transaction for all blob gets
async function getSnapshotFiles(snapshot_id) {
  await openDB();

  const junctions = await new Promise((res, rej) => {
    const r = _db.transaction('snapshot_files')
      .objectStore('snapshot_files')
      .index('by_snapshot')
      .getAll(snapshot_id);
    r.onsuccess = e => res(e.target.result);
    r.onerror   = e => rej(e.target.error);
  });

  if (junctions.length === 0) return [];

  // FIX: single transaction for all gets — not one per promise
  return new Promise((resolve, reject) => {
    const transaction = _db.transaction('blobs', 'readonly');
    const store       = transaction.objectStore('blobs');
    const results     = new Array(junctions.length).fill(null);
    let   pending     = junctions.length;

    junctions.forEach((j, idx) => {
      const r = store.get(j.hash);
      r.onsuccess = () => {
        const b = r.result;
        if (b) {
          results[idx] = {
            junction_id: j.id, snapshot_id: j.snapshot_id, hash: j.hash,
            filename: j.filename, label: j.label, attached_at: j.attached_at,
            mime: b.mime, size_bytes: b.size_bytes, content_b64: b.content_b64
          };
        }
        pending--;
        if (pending === 0) resolve(results.filter(Boolean));
      };
      r.onerror = e => reject(e.target.error);
    });

    transaction.onerror = e => reject(e.target.error);
  });
}

async function detachFile(junction_id) {
  await openDB();
  return new Promise((resolve, reject) => {
    const transaction = _db.transaction(['blobs', 'snapshot_files'], 'readwrite');
    const sfStore     = transaction.objectStore('snapshot_files');
    const blobsStore  = transaction.objectStore('blobs');

    const getJ = sfStore.get(junction_id);
    getJ.onsuccess = () => {
      const j = getJ.result;
      if (!j) { resolve({ removed: false, blob_deleted: false }); return; }
      sfStore.delete(junction_id);

      const getBlob = blobsStore.get(j.hash);
      getBlob.onsuccess = () => {
        const b = getBlob.result;
        if (!b) return;
        if (b.ref_count <= 1) blobsStore.delete(j.hash);
        else { b.ref_count--; blobsStore.put(b); }
      };
    };

    transaction.oncomplete = () => resolve({ removed: true });
    transaction.onerror    = e => reject(e.target.error);
    getJ.onerror           = e => reject(e.target.error);
  });
}

// FIX: gcBlobs — use objectStore reference correctly, add onerror
async function gcBlobs() {
  await openDB();

  const allJunctions = await new Promise((res, rej) => {
    const r = tx('snapshot_files').getAll();
    r.onsuccess = e => res(e.target.result);
    r.onerror   = e => rej(e.target.error);
  });
  const usedHashes = new Set(allJunctions.map(j => j.hash));

  const allHashes = await new Promise((res, rej) => {
    const r = tx('blobs').getAllKeys();
    r.onsuccess = e => res(e.target.result);
    r.onerror   = e => rej(e.target.error);
  });

  const toDelete = allHashes.filter(h => !usedHashes.has(h));
  if (toDelete.length === 0) return { deleted: 0 };

  return new Promise((res, rej) => {
    const transaction = _db.transaction('blobs', 'readwrite');
    const store       = transaction.objectStore('blobs');
    toDelete.forEach(h => store.delete(h));            // FIX: store not store.transaction
    transaction.oncomplete = () => res({ deleted: toDelete.length });
    transaction.onerror    = e => rej(e.target.error); // FIX: was missing
  });
}

async function getFileByJunction(junction_id) {
  await openDB();
  return new Promise((resolve, reject) => {
    const transaction = _db.transaction(['snapshot_files', 'blobs'], 'readonly');
    const sfStore     = transaction.objectStore('snapshot_files');
    const blobsStore  = transaction.objectStore('blobs');
    const getJ = sfStore.get(junction_id);
    getJ.onsuccess = () => {
      const j = getJ.result;
      if (!j) { resolve(null); return; }
      const getB = blobsStore.get(j.hash);
      getB.onsuccess = () => {
        const b = getB.result;
        if (!b) { resolve(null); return; }
        resolve({
          junction_id: j.id, snapshot_id: j.snapshot_id, hash: j.hash,
          filename: j.filename, label: j.label, attached_at: j.attached_at,
          mime: b.mime, size_bytes: b.size_bytes, content_b64: b.content_b64
        });
      };
      getB.onerror = e => reject(e.target.error);
    };
    getJ.onerror = e => reject(e.target.error);
    transaction.onerror = e => reject(e.target.error);
  });
}

// ─── Soft-Delete / Trash ─────────────────────────────────

async function softDelete(id) {
  await openDB();
  const s = await getSnapshot(id);
  if (!s) return false;
  s.deleted_at = new Date().toISOString();
  s.state_at   = s.deleted_at;            // sync: deletion timestamp wins over older active state
  return wrap(tx('snapshots', 'readwrite').put(s));
}

async function restoreSnapshot(id) {
  await openDB();
  const s = await getSnapshot(id);
  if (!s) return false;
  s.deleted_at = null;
  s.state_at   = new Date().toISOString(); // sync: restore timestamp wins over older deletion
  return wrap(tx('snapshots', 'readwrite').put(s));
}

async function permanentDelete(id) {
  await openDB();
  const files = await getSnapshotFiles(id);
  for (const f of files) await detachFile(f.junction_id);
  return wrap(tx('snapshots', 'readwrite').delete(id));
}

async function listTrashed({ fields = null } = {}) {
  await openDB();
  return new Promise((resolve, reject) => {
    const req     = tx('snapshots').openCursor();
    const results = [];
    req.onsuccess = (e) => {
      const cursor = e.target.result;
      if (!cursor) { resolve(results); return; }
      const val = cursor.value;
      if (val.deleted_at) {
        if (fields) {
          const projected = {};
          for (const f of fields) projected[f] = val[f];
          results.push(projected);
        } else {
          results.push(val);
        }
      }
      cursor.continue();
    };
    req.onerror = e => reject(e.target.error);
  });
}

// ─── Sync merge (Drive two-way sync) ─────────────────────
// Pull a remote canonical export into the local DB. Unlike importAll (which
// restores anything re-imported), this respects deletions bidirectionally via
// state_at last-write-wins, so a delete on one device propagates to the other.
// Caller pushes the merged exportAll() back to the canonical Drive file.
async function applySyncMerge(jsonStr) {
  await openDB();
  const data = JSON.parse(jsonStr);
  if (data.schema_version !== 1) throw new Error('Unsupported schema_version: ' + data.schema_version);

  const stamp = (s) => s?.state_at || s?.deleted_at || s?.created_at || '';

  // Snapshot lifecycle state of everything we already have locally.
  const local = new Map(); // snapshot_id -> state_at string
  await new Promise((resolve, reject) => {
    const req = tx('snapshots').openCursor();
    req.onsuccess = (e) => {
      const c = e.target.result;
      if (!c) { resolve(); return; }
      local.set(c.key, stamp(c.value));
      c.continue();
    };
    req.onerror = (e) => reject(e.target.error);
  });

  const incoming = (data.snapshots || []).filter(s => s?.snapshot_id);
  const toAdd    = [];   // absent locally
  const toUpdate = [];   // present, but remote lifecycle state is newer (delete/restore propagation)
  for (const r of incoming) {
    if (!local.has(r.snapshot_id)) { toAdd.push(r); continue; }
    if (stamp(r) > local.get(r.snapshot_id)) toUpdate.push(r);
  }

  // Add any file blobs/junctions we don't already have (same dedup as importAll).
  const allIds = new Set(incoming.map(s => s.snapshot_id));
  const existingFileKeys = new Set();
  for (const snapId of allIds) {
    const existing = await new Promise((res, rej) => {
      const rq = tx('snapshot_files').index('by_snapshot').getAll(snapId);
      rq.onsuccess = e => res(e.target.result); rq.onerror = e => rej(e.target.error);
    });
    for (const f of existing) existingFileKeys.add(snapId + ':' + f.hash);
  }
  const filesToImport = (data.snapshot_files || []).filter(f =>
    allIds.has(f.snapshot_id) && !existingFileKeys.has(f.snapshot_id + ':' + f.hash));
  const hashes = new Set(filesToImport.map(f => f.hash));
  const blobsToImport = (data.blobs || []).filter(b => hashes.has(b.hash));

  if (!toAdd.length && !toUpdate.length && !filesToImport.length && !(data.refs || []).length) {
    return { added: 0, updated: 0 };
  }

  const stores = ['snapshots', 'refs'];
  if (filesToImport.length) stores.push('snapshot_files', 'blobs');
  await new Promise((resolve, reject) => {
    const t = _db.transaction(stores, 'readwrite');
    const snap = t.objectStore('snapshots');
    for (const s of toAdd)    snap.put(s);
    for (const s of toUpdate) snap.put(s);   // adopt remote lifecycle state (payload is immutable)
    for (const r of (data.refs || [])) t.objectStore('refs').put(r);
    if (filesToImport.length) {
      for (const b of blobsToImport) t.objectStore('blobs').put(b);
      for (const f of filesToImport) { const { id: _id, ...rest } = f; t.objectStore('snapshot_files').add(rest); }
    }
    t.oncomplete = () => resolve();
    t.onerror    = e => reject(e.target.error);
    t.onabort    = () => reject(new Error('Sync merge aborted'));
  });

  return { added: toAdd.length, updated: toUpdate.length };
}

// ─── Unified Export ──────────────────────────────────────
// FIX: single export block — no more patching after init

const SessionPortDB_obj = {
  saveSnapshot, getSnapshot, listByProject, listAll, getChain,
  getByTransferId, getChainByTransferId,
  diff, setActive, getActive, fork, markInjected,
  softDelete, restoreSnapshot, permanentDelete, listTrashed,
  exportAll, exportSelected, importAll, applySyncMerge, migrateFromFlowState, renameProject,
  attachFile, getSnapshotFiles, getFileByJunction, detachFile, gcBlobs,
  bufferToBase64, base64ToBytes,
  openDB,
};

if (typeof globalThis !== 'undefined') globalThis.SessionPortDB = SessionPortDB_obj;
if (typeof window    !== 'undefined') window.SessionPortDB    = SessionPortDB_obj;
