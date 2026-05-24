/**
 * SessionPort — trash.js
 * Корзина: просмотр удалённых снапшотов, восстановление, безвозвратное удаление.
 */

// ─── Render ──────────────────────────────────────────────

async function renderTrashScreen() {
  const listEl  = document.getElementById('trashList');
  const emptyEl = document.getElementById('trashEmpty');
  const emptyBtn = document.getElementById('btnEmptyTrash');
  if (!listEl) return;

  const snaps = await SessionPortDB.listTrashed().catch(() => []);

  _updateTrashBadge(snaps.length);

  if (snaps.length === 0) {
    listEl.innerHTML = '';
    if (emptyEl)  emptyEl.style.display  = '';
    if (emptyBtn) emptyBtn.disabled = true;
    const badge = document.getElementById('trashBadge');
    if (badge) badge.textContent = '0 ' + PR_i18n.pluralSnap(0);
    return;
  }

  if (emptyEl) emptyEl.style.display = 'none';
  if (emptyBtn) emptyBtn.disabled = false;

  const badge = document.getElementById('trashBadge');
  if (badge) badge.textContent = snaps.length + ' ' + PR_i18n.pluralSnap(snaps.length);

  // Sort newest-deleted first
  snaps.sort((a, b) => (b.deleted_at || '').localeCompare(a.deleted_at || ''));

  listEl.innerHTML = snaps.map(s => _buildTrashCard(s)).join('');
}

function _plural(n) {
  if (n % 10 === 1 && n % 100 !== 11) return '';
  if (n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 10 || n % 100 >= 20)) return 'а';
  return 'ов';
}

function _buildTrashCard(s) {
  const fmtDate = iso => {
    if (!iso) return '—';
    const locale = PR_i18n.fmtDateLocale();
    const d = new Date(iso);
    return d.toLocaleDateString(locale, { day: '2-digit', month: 'short' }) +
           ' ' + d.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' });
  };
  const project  = PR_Utils.esc(s.project || 'unknown');
  const created  = fmtDate(s.created_at);
  const deleted  = fmtDate(s.deleted_at);
  const kb       = s.size_bytes ? (s.size_bytes / 1024).toFixed(1) : '—';

  return `<div class="trash-card" data-id="${s.snapshot_id}">
    <div class="trash-card-project">${project}</div>
    <div class="trash-card-meta">${PR_i18n.t('trash.created')} ${created} · ${kb} KB · ${PR_i18n.t('trash.deleted')} ${deleted}</div>
    <div class="trash-card-actions">
      <button class="trash-restore-btn" data-restore="${s.snapshot_id}">${PR_i18n.t('trash.restore')}</button>
      <button class="trash-delete-btn" data-perm-delete="${s.snapshot_id}">${PR_i18n.t('trash.delete')}</button>
    </div>
  </div>`;
}

// ─── Trash badge on main screen ──────────────────────────

function _updateTrashBadge(count) {
  const badge = document.getElementById('trashCount');
  if (!badge) return;
  if (count === undefined) {
    SessionPortDB.listTrashed({ fields: ['snapshot_id'] })
      .then(snaps => _updateTrashBadge(snaps.length))
      .catch(() => {});
    return;
  }
  if (count > 0) {
    badge.textContent  = count;
    badge.style.display = '';
  } else {
    badge.style.display = 'none';
  }
}

// ─── Click delegation ────────────────────────────────────

document.getElementById('trashList')?.addEventListener('click', async e => {
  const restoreBtn = e.target.closest('[data-restore]');
  if (restoreBtn) {
    const id = restoreBtn.dataset.restore;
    await SessionPortDB.restoreSnapshot(id).catch(() => {});
    renderTrashScreen();
    if (typeof refreshHistoryCounters === 'function') refreshHistoryCounters();
    return;
  }

  const deleteBtn = e.target.closest('[data-perm-delete]');
  if (deleteBtn) {
    const id = deleteBtn.dataset.permDelete;
    const ok = await PR_Utils.customConfirm(PR_i18n.t('trash.confirm_delete'), {
      confirmText: PR_i18n.t('trash.delete'), cancelText: PR_i18n.t('dlg.cancel'), danger: true
    });
    if (!ok) return;
    await SessionPortDB.permanentDelete(id).catch(() => {});
    renderTrashScreen();
    return;
  }
});

document.getElementById('btnEmptyTrash')?.addEventListener('click', async () => {
  const badge = document.getElementById('trashBadge');
  const label = badge ? badge.textContent : PR_i18n.t('trash.snap_count', { n: '?' });
  const ok = await PR_Utils.customConfirm(PR_i18n.t('trash.confirm_empty', { label }), {
    confirmText: PR_i18n.t('trash.clear'), cancelText: PR_i18n.t('dlg.cancel'), danger: true
  });
  if (!ok) return;

  const snaps = await SessionPortDB.listTrashed({ fields: ['snapshot_id'] }).catch(() => []);
  for (const s of snaps) {
    await SessionPortDB.permanentDelete(s.snapshot_id).catch(() => {});
  }
  renderTrashScreen();
});

// ─── Init badge on load ──────────────────────────────────
_updateTrashBadge();
