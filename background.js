/**
 * SessionPort v1.0 — Background Service Worker
 * db.js is inlined below (no importScripts — avoids MV3 SW restart issues).
 */

// ═══════════════════════════════════════════════════════════
// INLINED: db.js
// ═══════════════════════════════════════════════════════════


const DB_NAME    = 'sessionport_v1';
const DB_VERSION = 4;
const DEDUP_WINDOW_MS = 10 * 1000;

let _db = null;

// ─── Open / Init ──────────────────────────────────────────

function openDB() {
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
        const tx3 = e.target.transaction;
        const sn3 = tx3.objectStore('snapshots');
        if (!sn3.indexNames.contains('by_transfer_id'))
          sn3.createIndex('by_transfer_id', 'transfer_id', { unique: false });
        if (!sn3.indexNames.contains('by_parent_transfer_id'))
          sn3.createIndex('by_parent_transfer_id', 'parent_transfer_id', { unique: false });
      }

      // FIX #3: upgrade by_transfer_id to unique index for atomic dedup.
      // IDB skips null/undefined keys in unique indexes, so old snapshots
      // with transfer_id: null won't conflict. If duplicate non-null values
      // exist from a prior bug, the recreate will fail — we catch and keep non-unique.
      if (oldVersion < 4) {
        const tx4 = e.target.transaction;
        const sn4 = tx4.objectStore('snapshots');
        if (sn4.indexNames.contains('by_transfer_id')) {
          try {
            sn4.deleteIndex('by_transfer_id');
            sn4.createIndex('by_transfer_id', 'transfer_id', { unique: true });
          } catch (err) {
            console.warn('[PR-DB] v4 migration: could not make by_transfer_id unique:', err.message);
            // Fallback: recreate as non-unique (same as before)
            if (!sn4.indexNames.contains('by_transfer_id')) {
              sn4.createIndex('by_transfer_id', 'transfer_id', { unique: false });
            }
          }
        }
      }
    };

    // FIX: onblocked — another tab holds old version open
    // Timeout after 10s to prevent forever-pending promise
    let _blockedTimer = setTimeout(() => {
      reject(new Error('DB upgrade blocked >10s — close other extension tabs and retry'));
    }, 10_000);
    req.onblocked = () => {
      console.warn('[PR-DB] upgrade blocked — waiting for other connections to close');
    };

    req.onsuccess = (e) => {
      clearTimeout(_blockedTimer);
      _db = e.target.result;
      // FIX: versionchange — newer version opened elsewhere, close gracefully
      _db.onversionchange = () => {
        _db.close();
        _db = null;
        console.warn('[PR-DB] versionchange — closed old connection');
      };
      resolve(_db);
    };

    req.onerror = (e) => {
      const err = e.target.error;
      if (err?.name === 'VersionError') {
        if (_db) { _db.close(); _db = null; }
        setTimeout(() => openDB().then(resolve).catch(reject), 300);
      } else { reject(err); }
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
  const payloadStr         = JSON.stringify(payload);
  // FIX: reject oversized payloads before wasting CPU on sha256 / DB write
  const MAX_PAYLOAD_BYTES  = 1_000_000; // 1MB — generous but prevents runaway
  if (payloadStr.length > MAX_PAYLOAD_BYTES) {
    throw new Error(`Payload too large: ${payloadStr.length} bytes (max ${MAX_PAYLOAD_BYTES})`);
  }
  const content_hash       = await sha256(payloadStr);
  const size_bytes         = payloadStr.length;
  const now                = new Date().toISOString();

  // Dedup: проверяем последние 20 снапшотов проекта
  const recentCutoff  = new Date(Date.now() - DEDUP_WINDOW_MS).toISOString();
  const allForProject = await listByProject(project, { limit: 20 });
  // Dedup 1: exact transfer_id match — fast path (pre-check before write)
  if (transfer_id && allForProject.find(s => s.transfer_id === transfer_id)) return null;
  // Dedup 2: same content_hash within window
  if (allForProject.some(s => s.content_hash === content_hash && s.created_at > recentCutoff))
    return null;

  const active_id   = await getMeta('active_snapshot_id');
  const snapshot_id = makeId();

  const snapshot = {
    snapshot_id,
    created_at:        now,
    source_host,
    target_host:       null,
    project,
    version:           payload?.meta?.version || '',
    parent_id:         active_id || null,
    transfer_id,
    parent_transfer_id,
    content_hash,
    payload,
    size_bytes,
  };

  // FIX #1+#3: atomic multi-store transaction with ConstraintError handling.
  // If unique index on by_transfer_id catches a duplicate that slipped past
  // the read-based check (race condition), we return null instead of throwing.
  return new Promise((resolve, reject) => {
    const transaction = _db.transaction(['snapshots', 'refs', 'meta'], 'readwrite');
    const addReq = transaction.objectStore('snapshots').add(snapshot);
    addReq.onerror = (e) => {
      if (e.target.error?.name === 'ConstraintError') {
        // Duplicate transfer_id caught by unique index — not an error, just dedup
        e.preventDefault(); // prevent transaction abort
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
    transaction.onabort    = e => {
      const err = e.target.error;
      if (err?.name === 'ConstraintError') return; // already resolved via addReq.onerror
      reject(err || new Error('saveSnapshot: transaction aborted'));
    };
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
// FIX #2: `fields` param for projection — when provided, only those fields
// are copied from each record. This avoids loading multi-KB payloads into
// memory when callers only need metadata (counters, storage bar, mind map).
// Usage: listAll({ limit: 0, fields: ['snapshot_id','project','size_bytes'] })
async function listAll({ limit = 0, fields = null } = {}) {
  await openDB();
  return new Promise((resolve, reject) => {
    const req     = tx('snapshots').index('by_project_time').openCursor(null, 'prev');
    const results = [];
    req.onsuccess = (e) => {
      const cursor = e.target.result;
      if (!cursor || (limit > 0 && results.length >= limit)) { resolve(results); return; }
      if (fields) {
        const projected = {};
        for (const f of fields) projected[f] = cursor.value[f];
        results.push(projected);
      } else {
        results.push(cursor.value);
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

// FIX 2.2: functions synced from db.js — were missing in background.js
async function getByTransferId(transfer_id) {
  await openDB();
  return new Promise((resolve, reject) => {
    const req = _db.transaction('snapshots').objectStore('snapshots')
      .index('by_transfer_id').get(transfer_id);
    req.onsuccess = e => resolve(e.target.result || null);
    req.onerror   = e => reject(e.target.error);
  });
}

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

async function exportAll() {
  await openDB();
  const [snapshots, refs, metaRaw] = await Promise.all([
    new Promise((res, rej) => { const r = tx('snapshots').getAll(); r.onsuccess = e => res(e.target.result); r.onerror = e => rej(e.target.error); }),
    new Promise((res, rej) => { const r = tx('refs').getAll();      r.onsuccess = e => res(e.target.result); r.onerror = e => rej(e.target.error); }),
    new Promise((res, rej) => { const r = tx('meta').getAll();      r.onsuccess = e => res(e.target.result); r.onerror = e => rej(e.target.error); }),
  ]);
  return JSON.stringify({ schema_version: 1, exported_at: new Date().toISOString(),
                          snapshots, refs, meta: metaRaw }, null, 2);
}

// FIX #8: importAll — batch writes in single transaction instead of per-record.
// Step 1: collect existing snapshot_ids (read tx).
// Step 2: filter new records, write all in one readwrite tx.
// If import is interrupted mid-tx, all records in that batch roll back.
async function importAll(jsonStr) {
  await openDB();
  const data = JSON.parse(jsonStr);
  if (data.schema_version !== 1) throw new Error('Unsupported schema_version: ' + data.schema_version);

  // Step 1: read existing snapshot_ids AND meta keys (single readonly tx)
  const existingIds  = new Set();
  const existingMeta = new Set();
  await new Promise((resolve, reject) => {
    const readTx = _db.transaction(['snapshots', 'meta'], 'readonly');
    let pending = 2;
    const done = () => { if (--pending === 0) resolve(); };

    const snapReq = readTx.objectStore('snapshots').openKeyCursor();
    snapReq.onsuccess = (e) => {
      const cursor = e.target.result;
      if (!cursor) { done(); return; }
      existingIds.add(cursor.key);
      cursor.continue();
    };
    snapReq.onerror = e => reject(e.target.error);

    const metaReq = readTx.objectStore('meta').openKeyCursor();
    metaReq.onsuccess = (e) => {
      const cursor = e.target.result;
      if (!cursor) { done(); return; }
      existingMeta.add(cursor.key);
      cursor.continue();
    };
    metaReq.onerror = e => reject(e.target.error);
  });

  const newSnapshots = (data.snapshots || []).filter(s => s?.snapshot_id && !existingIds.has(s.snapshot_id));
  // A08 fix: never overwrite existing meta keys (e.g. active_snapshot_id) on import
  const newMeta = (data.meta || []).filter(m => m?.key && !existingMeta.has(m.key));

  // Step 2: batch write all new records in one atomic transaction
  if (newSnapshots.length || (data.refs || []).length || newMeta.length) {
    await new Promise((resolve, reject) => {
      const transaction = _db.transaction(['snapshots', 'refs', 'meta'], 'readwrite');
      const snapStore = transaction.objectStore('snapshots');
      const refsStore = transaction.objectStore('refs');
      const metaStore = transaction.objectStore('meta');
      for (const s of newSnapshots) snapStore.add(s);
      // A08 fix: validate required fields on refs before writing
      for (const r of data.refs || []) { if (r?.name && r?.head_id) refsStore.put(r); }
      for (const m of newMeta)          metaStore.add(m);
      transaction.oncomplete = () => resolve();
      transaction.onerror    = e => reject(e.target.error);
      transaction.onabort    = e => reject(new Error('Import transaction aborted'));
    });
  }
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

// ─── Unified Export ──────────────────────────────────────
// FIX: single export block — no more patching after init

const SessionPortDB_obj = {
  saveSnapshot, getSnapshot, listByProject, listAll, getChain,
  getByTransferId, getChainByTransferId,
  diff, setActive, getActive, fork, markInjected,
  exportAll, importAll, migrateFromFlowState, renameProject,
  attachFile, getSnapshotFiles, getFileByJunction, detachFile, gcBlobs,
  bufferToBase64, base64ToBytes,
  openDB,
};

if (typeof globalThis !== 'undefined') globalThis.SessionPortDB = SessionPortDB_obj;
if (typeof window    !== 'undefined') window.SessionPortDB    = SessionPortDB_obj;

// ═══════════════════════════════════════════════════════════
// BACKGROUND LOGIC
// ═══════════════════════════════════════════════════════════

const DB = globalThis.SessionPortDB;


// ── Функция для MAIN world. Не использует внешних замыканий. ──
function dispatchFileDropInMainWorld(fileDescriptors, targetSelector) {
  // IMPORTANT: runs in MAIN world via executeScript
  // Content script variables (getAdapter, ADAPTERS, etc.) NOT available here
  // Must be fully self-contained

  try {
    const host  = location.hostname;
    const files = fileDescriptors.map(fd => {
      const binary = atob(fd.content_b64);
      const bytes  = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      return new File([bytes], fd.filename, { type: fd.mime || 'application/octet-stream' });
    });

    const visFirst = sel => {
      for (const el of document.querySelectorAll(sel)) {
        const r = el.getBoundingClientRect();
        if (r.width > 0 && r.height > 0 && el.offsetParent !== null) return el;
      }
      return null;
    };

    const tryFileInput = files => {
      const inp = document.querySelector('input[type="file"]');
      if (!inp) return false;
      const dt = new DataTransfer();
      files.forEach(f => dt.items.add(f));
      const nativeDesc = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'files');
      if (nativeDesc?.set) {
        nativeDesc.set.call(inp, dt.files);
      } else {
        Object.defineProperty(inp, 'files', { value: dt.files, configurable: true });
      }
      inp.dispatchEvent(new Event('change', { bubbles: true }));
      inp.dispatchEvent(new Event('input',  { bubbles: true }));
      return true;
    };

    const dragSeq = (el, files) => {
      const dt   = new DataTransfer();
      files.forEach(f => dt.items.add(f));
      const rect = el.getBoundingClientRect();
      const cx = rect.left + rect.width / 2, cy = rect.top + rect.height / 2;
      const init = { bubbles: true, cancelable: true, composed: true,
                     dataTransfer: dt, clientX: cx, clientY: cy };
      el.dispatchEvent(new DragEvent('dragenter', init));
      el.dispatchEvent(new DragEvent('dragover',  init));
      el.dispatchEvent(new DragEvent('drop',      init));
      el.dispatchEvent(new DragEvent('dragleave', { bubbles: true, dataTransfer: dt }));
      document.dispatchEvent(new DragEvent('dragend', { bubbles: true }));
    };

    const dropOnly = (el, files) => {
      const dt = new DataTransfer();
      files.forEach(f => dt.items.add(f));
      const rect = el.getBoundingClientRect();
      el.dispatchEvent(new DragEvent('drop', {
        bubbles: true, cancelable: true, composed: true, dataTransfer: dt,
        clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2
      }));
      document.dispatchEvent(new DragEvent('dragend', { bubbles: true }));
    };

    // ── Claude ──────────────────────────────────────────────
    if (host.includes('claude.ai')) {
      if (tryFileInput(files)) return { success: true, injected: files.length };
      const pm = visFirst('div.ProseMirror[contenteditable="true"]');
      const el = pm?.closest('fieldset, form, [class*="composer"]') || pm?.parentElement || pm;
      if (!el) return { success: false, error: 'claude: no drop target' };
      dragSeq(el, files);
      return { success: true, injected: files.length };
    }

    // ── ChatGPT ─────────────────────────────────────────────
    if (host.includes('chatgpt.com')) {
      // dragenter/dragover открывают Popover API ChatGPT — не закрывается
      // Решение: только drop без dragenter/dragover
      const form = document.querySelector('form[data-type="unified-composer"]')
                || document.querySelector('form');
      if (!form) return { success: false, error: 'chatgpt: form not found' };
      dropOnly(form, files);
      return { success: true, injected: files.length };
    }

    // ── Grok ────────────────────────────────────────────────
    if (host.includes('grok.com')) {
      // react-dnd бросает "Cannot call hover while not dragging" на любой DragEvent.
      // React file input требует нативный setter через Object.getOwnPropertyDescriptor.
      const inp = document.querySelector('input[type="file"]');
      if (inp) {
        const dt = new DataTransfer();
        files.forEach(f => dt.items.add(f));
        // Используем нативный property descriptor из HTMLInputElement.prototype
        const nativeInputFilesDesc = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'files');
        if (nativeInputFilesDesc && nativeInputFilesDesc.set) {
          nativeInputFilesDesc.set.call(inp, dt.files);
        } else {
          Object.defineProperty(inp, 'files', { value: dt.files, configurable: true });
        }
        inp.dispatchEvent(new Event('change', { bubbles: true }));
        return { success: true, injected: files.length };
      }
      return { success: false, error: 'grok: no file input found' };
    }

    // ── Gemini ──────────────────────────────────────────────
    if (host.includes('gemini.google.com')) {
      // Synthetic paste event с File на .ql-editor — Quill paste handler
      // принимает mutable DataTransfer и пайплайн Gemini обрабатывает как обычный upload.
      // Подтверждено эмпирически в v1.2.28: появляется file-preview-chip.
      const ql = document.querySelector('.ql-editor[contenteditable="true"]');
      if (!ql) return { success: false, error: 'gemini: .ql-editor not found' };
      try { ql.focus(); } catch(_) {}
      const pasteData = new DataTransfer();
      files.forEach(f => pasteData.items.add(f));
      const ev = new ClipboardEvent('paste', {
        clipboardData: pasteData,
        bubbles: true, cancelable: true, composed: true,
      });
      ql.dispatchEvent(ev);
      if (ev.defaultPrevented) return { success: true, injected: files.length };
      return { success: false, error: 'gemini: paste event not accepted' };
    }

    // ── Deepseek ────────────────────────────────────────────
    if (host.includes('chat.deepseek.com')) {
      if (tryFileInput(files)) return { success: true, injected: files.length };
      return { success: false, error: 'deepseek: file input not found' };
    }

    // ── Mistral ─────────────────────────────────────────────
    // Synthetic paste event с File на .ProseMirror — то же решение что для Gemini.
    // ProseMirror paste handler принимает mutable DataTransfer и Mistral pipeline
    // обрабатывает как обычный upload. Подтверждено эмпирически в v1.2.30.
    if (host.includes('chat.mistral.ai')) {
      const pm = visFirst('div.ProseMirror[contenteditable="true"]');
      if (!pm) return { success: false, error: 'mistral: .ProseMirror not found' };
      try { pm.focus(); } catch(_) {}
      const pasteData = new DataTransfer();
      files.forEach(f => pasteData.items.add(f));
      const ev = new ClipboardEvent('paste', {
        clipboardData: pasteData,
        bubbles: true, cancelable: true, composed: true,
      });
      pm.dispatchEvent(ev);
      if (ev.defaultPrevented) return { success: true, injected: files.length };
      return { success: false, error: 'mistral: paste event not accepted' };
    }

    // ── Perplexity ──────────────────────────────────────────
    if (host.includes('perplexity.ai')) {
      // Free tier теперь поддерживает файлы (май 2026).
      // Пробуем input[type=file] — наиболее надёжный путь без React-DnD конфликтов.
      if (tryFileInput(files)) return { success: true, injected: files.length };
      // Fallback: dragSeq на form
      const ed = visFirst('[contenteditable="true"][class*="overflow-auto"], [contenteditable="true"][class*="caret-"]');
      const form = ed?.closest('form') || document.querySelector('form');
      if (!form) return { success: false, error: 'perplexity: form not found' };
      dragSeq(form, files);
      return { success: true, injected: files.length };
    }

    // ── Generic fallback ────────────────────────────────────
    const target = document.querySelector(targetSelector);
    if (!target) return { success: false, error: 'no target: ' + targetSelector };
    dropOnly(target, files);
    return { success: true, injected: files.length };

  } catch (err) {
    return { success: false, error: err.message };
  }
}


const BADGE_STATES = {
  IDLE:      { text: '',  color: '#888888' },
  CAPTURING: { text: '…', color: '#FFC107' },
  READY:     { text: '1', color: '#28a745' },
  ERROR:     { text: '!', color: '#dc3545' }
};

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // Reject messages from other extensions or external origins
  if (sender.id !== chrome.runtime.id) return false;

  if (msg.action === 'SET_BADGE') {
    const state  = BADGE_STATES[msg.state] || BADGE_STATES.IDLE;
    const tabId  = sender.tab?.id;
    const target = tabId ? { tabId } : {};
    chrome.action.setBadgeText({ text: state.text, ...target });
    chrome.action.setBadgeBackgroundColor({ color: state.color, ...target });
    sendResponse({ success: true });
    return false;
  }

  if (msg.action === 'SAVE_SNAPSHOT') {
    const { payload, source_host } = msg;
    DB.saveSnapshot(payload, source_host)
      .then(snapshot_id => {
        if (snapshot_id) {
          sendResponse({ success: true, snapshot_id });
          chrome.storage.local.set({ snapshot_added_at: Date.now() });
          // Тихое уведомление — только badge, без системного попапа
          Promise.all([
            chrome.action.setBadgeText({ text: '✓' }),
            chrome.action.setBadgeBackgroundColor({ color: '#22c55e' })
          ]);
          chrome.alarms.create('pr_badge_clear', { delayInMinutes: 0.5 });
        } else {
          sendResponse({ success: true, snapshot_id: null, reason: 'dedup' });
        }
      })
      .catch(err => {
        console.error('[SessionPort] SAVE_SNAPSHOT error:', err);
        // FIX: surface QuotaExceededError so content script can show meaningful toast
        const isQuota = err?.name === 'QuotaExceededError' ||
                        (err?.message || '').toLowerCase().includes('quota');
        sendResponse({
          success: false,
          error: isQuota
            ? 'Хранилище заполнено — удалите старые слепки или экспортируйте данные'
            : err.message,
          code: isQuota ? 'QUOTA_EXCEEDED' : 'UNKNOWN'
        });
      });
    return true;
  }

  if (msg.action === 'MARK_INJECTED') {
    DB.markInjected(msg.snapshot_id, msg.target_host)
      .then(() => sendResponse({ success: true }))
      .catch(err => sendResponse({ success: false, error: err.message }));
    return true;
  }

  if (msg.action === 'GET_ACTIVE') {
    DB.getActive()
      .then(id => sendResponse({ success: true, snapshot_id: id }))
      .catch(err => sendResponse({ success: false, error: err.message }));
    return true;
  }

  if (msg.action === 'SET_ACTIVE') {
    DB.setActive(msg.snapshot_id || null)
      .then(() => sendResponse({ success: true }))
      .catch(err => sendResponse({ success: false, error: err.message }));
    return true;
  }

  // ─── INJECT_CONTENT_SCRIPTS — inject all 4 scripts into a specific tab ───
  // Replaces old INJECT_CONTENT_SCRIPT. Accepts tabId in msg.
  // Injects inject.js → adapters.js → capture.js → content.js (order matters).
  if (msg.action === 'INJECT_CONTENT_SCRIPTS' || msg.action === 'INJECT_CONTENT_SCRIPT') {
    const targetTabId = msg.tabId || null;

    // FIX: if tabId not provided, find LLM tab across all windows (side panel fix)
    const getTabId = targetTabId
      ? Promise.resolve(targetTabId)
      : (async () => {
          const LLM_DOMAINS_INJ = ['chatgpt.com','claude.ai','grok.com',
                                    'gemini.google.com','perplexity.ai','chat.mistral.ai', 'chat.deepseek.com'];
          const isLLM = url => { try { return LLM_DOMAINS_INJ.some(d => new URL(url).hostname.includes(d)); } catch { return false; } };
          const active = await new Promise(r => chrome.tabs.query({ active: true }, r));
          const found = active.find(t => isLLM(t.url));
          if (found) return found.id;
          const all = await new Promise(r => chrome.tabs.query({}, r));
          const any = all.filter(t => isLLM(t.url)).sort((a,b)=>(b.lastAccessed||0)-(a.lastAccessed||0))[0];
          return any?.id || null;
        })();

    getTabId.then(tabId => {
      if (!tabId) { sendResponse({ success: false, error: 'no LLM tab found' }); return; }
      chrome.scripting.executeScript({
        target: { tabId },
        files: ['content-bundle.js']
      }).then(() => sendResponse({ success: true }))
        .catch(err => {
          console.error('[SessionPort] inject failed:', err);
          sendResponse({ success: false, error: err.message });
        });
    });
    return true;
  }

  if (msg.action === 'ATTACH_FILE') {
    const { snapshot_id, filename, mime, size_bytes, content_b64, label } = msg;
    DB.attachFile(snapshot_id, filename, mime, size_bytes, content_b64, label || '')
      .then(r => sendResponse({ success: true, ...r }))
      .catch(err => sendResponse({ success: false, error: err.message }));
    return true;
  }

  if (msg.action === 'LIST_FILES') {
    DB.getSnapshotFiles(msg.snapshot_id)
      .then(files => {
        const meta = files.map(f => ({
          junction_id: f.junction_id, hash: f.hash, filename: f.filename,
          mime: f.mime, size_bytes: f.size_bytes, attached_at: f.attached_at
        }));
        sendResponse({ success: true, files: meta });
      })
      .catch(err => sendResponse({ success: false, error: err.message }));
    return true;
  }

  if (msg.action === 'DETACH_FILE') {
    DB.detachFile(msg.junction_id)
      .then(r => sendResponse({ success: true, ...r }))
      .catch(err => sendResponse({ success: false, error: err.message }));
    return true;
  }

  // ─── Cross-window drag protocol (side panel → page) ──────
  // Side panel calls STAGE_DRAG_FILE on dragstart with junction_id
  // Content script calls GET_DRAG_FILE on drop with the dragId from dataTransfer
  if (msg.action === 'STAGE_DRAG_FILE') {
    DB.getFileByJunction(msg.junction_id)
      .then(file => {
        if (!file) { sendResponse({ success: false, error: 'file not found' }); return; }
        const fileData = {
          filename: file.filename,
          mime: file.mime || 'application/octet-stream',
          content_b64: file.content_b64,
          staged_at: Date.now()
        };
        // Пишем в storage.local — content scripts читают его при старте страницы
        // и слушают storage.onChanged, поэтому данные синхронизируются мгновенно
        const key = 'pr_drag_file_' + msg.drag_id;
        chrome.storage.local.set({ [key]: fileData }, () => {
          if (chrome.runtime.lastError) {
            sendResponse({ success: false, error: chrome.runtime.lastError.message });
            return;
          }
          sendResponse({ success: true });

          // Дополнительный push для уже открытых вкладок (резервный канал)
          const LLM_HOSTS = ['claude.ai','chatgpt.com','grok.com','gemini.google.com',
                             'chat.mistral.ai','chat.deepseek.com','perplexity.ai'];
          chrome.tabs.query({}, tabs => {
            tabs.forEach(tab => {
              if (!tab.url || !LLM_HOSTS.some(h => tab.url.includes(h))) return;
              chrome.tabs.sendMessage(tab.id, {
                action: 'PUSH_DRAG_FILE', drag_id: msg.drag_id, file: fileData
              }).catch(() => {});
            });
          });
        });
        // Cleanup staged files older than 5 min (was 1 hour — too long for 10MB storage limit)
        chrome.storage.local.get(null, all => {
          const now = Date.now();
          const stale = Object.keys(all)
            .filter(k => k.startsWith('pr_drag_file_') && (now - (all[k]?.staged_at || 0)) > 300_000);
          if (stale.length) chrome.storage.local.remove(stale);
        });
      })
      .catch(err => sendResponse({ success: false, error: err.message }));
    return true;
  }

  if (msg.action === 'GET_DRAG_FILE') {
    const key = 'pr_drag_file_' + msg.drag_id;
    chrome.storage.local.get(key, res => {
      if (chrome.runtime.lastError) {
        sendResponse({ success: false, error: chrome.runtime.lastError.message }); return;
      }
      const file = res[key];
      if (!file) { sendResponse({ success: false, error: 'drag not staged' }); return; }
      sendResponse({ success: true, file });
    });
    return true;
  }

  if (msg.action === 'INJECT_FILES') {
    (async () => {
      try {
        const files = await DB.getSnapshotFiles(msg.snapshot_id);
        if (files.length === 0) {
          sendResponse({ success: true, injected: 0 }); return;
        }

        // FIX: side panel runs in its own window — must search ALL windows for LLM tab
        const LLM_DOMAINS_BG = ['chatgpt.com','claude.ai','grok.com',
                                 'gemini.google.com','perplexity.ai','chat.mistral.ai', 'chat.deepseek.com'];
        function isLLMUrl(url) {
          try { return LLM_DOMAINS_BG.some(d => new URL(url).hostname.includes(d)); }
          catch { return false; }
        }

        let targetTabId = msg.tabId;
        if (!targetTabId) {
          // Step 1: active LLM tab across all windows
          const activeTabs = await new Promise(r => chrome.tabs.query({ active: true }, r));
          const llmActive = activeTabs.find(t => isLLMUrl(t.url));
          if (llmActive) {
            targetTabId = llmActive.id;
          } else {
            // Step 2: any LLM tab, most recently accessed
            const allTabs = await new Promise(r => chrome.tabs.query({}, r));
            const llmTab = allTabs
              .filter(t => isLLMUrl(t.url))
              .sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0))[0];
            targetTabId = llmTab?.id;
          }
        }
        if (!targetTabId) {
          sendResponse({ success: false, error: 'no LLM tab found' }); return;
        }

        // Step 1: Ask content script for drop target selector (small message, no file data)
        const targetResp = await new Promise(r =>
          chrome.tabs.sendMessage(targetTabId, { action: 'GET_DROP_TARGET' }, resp => {
            if (chrome.runtime.lastError) r({ success: false, error: chrome.runtime.lastError.message });
            else r(resp || { success: false });
          }));

        if (!targetResp?.success || !targetResp?.selector) {
          sendResponse({ success: false, error: targetResp?.error || 'no drop target' }); return;
        }

        // Step 2: Execute file drop directly in MAIN world (file data goes straight from bg → page)
        const fileDescriptors = files.map(f => ({
          filename: f.filename, mime: f.mime,
          size_bytes: f.size_bytes, content_b64: f.content_b64
        }));

        const results = await chrome.scripting.executeScript({
          target: { tabId: targetTabId },
          world: 'MAIN',
          func: dispatchFileDropInMainWorld,
          args: [fileDescriptors, targetResp.selector]
        });

        const r = results?.[0]?.result;
        sendResponse({ success: !!r?.success, injected: r?.injected || 0 });
      } catch (err) {
        console.error('[SessionPort] INJECT_FILES error:', err);
        sendResponse({ success: false, error: err.message });
      }
    })();
    return true;
  }

  if (msg.action === 'EXECUTE_FILE_DROP_IN_MAIN_WORLD') {
    const { files, targetSelector, tabId } = msg;
    const senderTabId = tabId || sender.tab?.id;
    if (!senderTabId) {
      sendResponse({ success: false, error: 'no tab' });
      return false;
    }
    chrome.scripting.executeScript({
      target: { tabId: senderTabId },
      world: 'MAIN',
      func: dispatchFileDropInMainWorld,
      args: [files, targetSelector]
    }).then(results => {
      const r = results?.[0]?.result;
      sendResponse({ success: !!r?.success, ...(r || {}) });
    }).catch(err => {
      sendResponse({ success: false, error: err.message });
    });
    return true;
  }
});

// ─── Install ─────────────────────────────────────────────────────────────

// FIX: reset flow_state if the LLM tab navigates or closes during capture.
// Without this, flow_state stays in CAPTURING forever and the watcher polls for 2 min.
const _LLM_HOSTS_TAB = ['chatgpt.com','claude.ai','grok.com','gemini.google.com',
                         'perplexity.ai','chat.mistral.ai','chat.deepseek.com'];
function _isLLMUrl(url) {
  try { return _LLM_HOSTS_TAB.some(d => new URL(url).hostname.includes(d)); }
  catch { return false; }
}
function _resetFlowIfCapturing() {
  chrome.storage.local.get('flow_state', r => {
    const st = r.flow_state;
    if (st && st.status === 'CAPTURING') {
      chrome.storage.local.set({
        flow_state: { ...st, status: 'IDLE', payload: null }
      });
      chrome.action.setBadgeText({ text: '' });
      console.warn('[PR-bg] flow_state reset: LLM tab navigated/closed during capture');
    }
  });
}
chrome.tabs.onRemoved.addListener((tabId) => {
  // Tab closed — if it was the LLM tab we were capturing from, reset
  _resetFlowIfCapturing();
});
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  // Full reload triggers status='loading'; SPA nav (Claude, ChatGPT) changes URL without reload
  const urlChanged  = changeInfo.url  && _isLLMUrl(changeInfo.url);
  const pageLoading = changeInfo.status === 'loading' && tab.url && _isLLMUrl(tab.url);
  if (urlChanged || pageLoading) {
    _resetFlowIfCapturing();
  }
});


// FIX: proactive GC for stale drag files — runs on install and browser startup,
// not only when next STAGE_DRAG_FILE happens.
function _gcStaleDragFiles() {
  chrome.storage.local.get(null, all => {
    if (chrome.runtime.lastError) return;
    const now = Date.now();
    const stale = Object.keys(all)
      .filter(k => k.startsWith('pr_drag_file_') && (now - (all[k]?.staged_at || 0)) > 300_000); // 5 min
    if (stale.length) {
      chrome.storage.local.remove(stale);
    }
  });
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'pr_badge_clear') {
    chrome.action.setBadgeText({ text: '' });
  }
  if (alarm.name === 'pr_gc') {
    _gcStaleDragFiles();
  }
  if (alarm.name === 'gdrive_backup') {
    chrome.storage.local.get(['gd_connected'], r => {
      if (r.gd_connected) _gdBackupFromSW().catch(e => console.warn('[SP] GDrive backup failed:', e.message));
    });
  }
});

// ── Google Drive backup from service worker ───────────────

async function _gdBackupFromSW() {
  const token = await new Promise((resolve, reject) => {
    chrome.identity.getAuthToken({ interactive: false }, t => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else if (!t)                  reject(new Error('No token'));
      else                          resolve(t);
    });
  });

  const json     = await exportAll();
  const folderId = await _gdSWGetFolder(token);
  const ts       = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const name     = `sessionport-backup-${ts}.json`;

  const form = new FormData();
  form.append('metadata', new Blob([JSON.stringify({
    name, parents: [folderId], mimeType: 'application/json'
  })], { type: 'application/json' }));
  form.append('file', new Blob([json], { type: 'application/json' }));

  const r = await fetch(
    'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id',
    { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: form }
  );
  if (r.status === 401) {
    chrome.identity.removeCachedAuthToken({ token }, () => {});
    return;
  }
  if (!r.ok) throw new Error(`upload ${r.status}`);

  chrome.storage.local.set({ gd_last_backup: Date.now() });
  _gdSWPrune(token, folderId).catch(() => {});
}

async function _gdSWGetFolder(token) {
  const { gd_folder_id } = await chrome.storage.local.get('gd_folder_id');
  if (gd_folder_id) {
    const c = await fetch(
      `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(gd_folder_id)}?fields=id,trashed`,
      { headers: { Authorization: `Bearer ${token}` } }
    ).catch(() => null);
    if (c?.ok) { const f = await c.json(); if (!f.trashed) return gd_folder_id; }
    await chrome.storage.local.remove('gd_folder_id');
  }

  const q  = encodeURIComponent("name='SessionPort Backups' and mimeType='application/vnd.google-apps.folder' and trashed=false");
  const sr = await fetch(`https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id)&pageSize=1`,
    { headers: { Authorization: `Bearer ${token}` } });
  const { files } = await sr.json();
  if (files?.length) { await chrome.storage.local.set({ gd_folder_id: files[0].id }); return files[0].id; }

  const cr = await fetch('https://www.googleapis.com/drive/v3/files?fields=id', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'SessionPort Backups', mimeType: 'application/vnd.google-apps.folder' })
  });
  const folder = await cr.json();
  await chrome.storage.local.set({ gd_folder_id: folder.id });
  return folder.id;
}

async function _gdSWPrune(token, folderId) {
  const q = encodeURIComponent(`'${folderId}' in parents and trashed=false`);
  const r = await fetch(
    `https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id,createdTime)&orderBy=createdTime+desc&pageSize=20`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  if (!r.ok) return;
  const { files } = await r.json();
  if (!files || files.length <= 5) return;
  for (const f of files.slice(5)) {
    fetch(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(f.id)}`,
      { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } }
    ).catch(() => {});
  }
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.action.setBadgeText({ text: '' });
  chrome.storage.local.set({
    flow_state: { status: 'IDLE', payload: null, mode: null, step: 0 }
  });
  if (chrome.sidePanel && chrome.sidePanel.setPanelBehavior) {
    chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(console.error);
  }
  _gcStaleDragFiles();
  chrome.alarms.create('pr_gc', { periodInMinutes: 30 });
});

chrome.runtime.onStartup.addListener(() => {
  _gcStaleDragFiles();
});

if (chrome.sidePanel && chrome.sidePanel.setPanelBehavior) {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(console.error);
}
