/**
 * SessionPort — projects.js
 * Project bar: выбор/создание проекта, dropdown, HEAD-привязка.
 * Зависимости: popup-utils.js (PR_Utils, $, customPrompt через PR_Utils), db.js
 */

let projectDropdownOpen = false;
let allProjects         = [];
let currentProject      = null;

// ── Init ──────────────────────────────────────────────────
async function initProjectBar() {
  const activeId   = await SessionPortDB.getActive();
  const activeSnap = activeId ? await SessionPortDB.getSnapshot(activeId) : null;

  const snaps      = await SessionPortDB.listAll({ limit: 0, fields: ['project'] });
  const dbProjects = [...new Set(snaps.map(s => s.project).filter(Boolean))];

  await new Promise(res => chrome.storage.local.get(['pr_projects', 'pr_active_project'], r => {
    const saved = r.pr_projects || [];
    // Only show projects that still have snapshots in DB
    allProjects    = dbProjects;
    currentProject = activeSnap?.project || r.pr_active_project || allProjects[0] || null;
    // If the previously active project was deleted, fall back to first available
    if (currentProject && !allProjects.includes(currentProject)) {
      currentProject = allProjects[0] || null;
    }
    // Prune stale project names from storage
    if (saved.some(p => !dbProjects.includes(p))) {
      chrome.storage.local.set({ pr_projects: dbProjects });
    }
    res();
  }));

  const nameEl = document.getElementById('projName');
  if (nameEl) nameEl.textContent = currentProject
    ? (currentProject.length > 28 ? currentProject.slice(0, 28) + '…' : currentProject)
    : PR_i18n.t('proj.no_project');

  renderProjectDropdown();
}

// ── Render dropdown ───────────────────────────────────────
function renderProjectDropdown() {
  const dd = document.getElementById('projDD');
  if (!dd) return;

  dd.innerHTML = allProjects.map((p, i) => {
    const short    = PR_Utils.esc(p.length > 32 ? p.slice(0, 32) + '…' : p);
    const isActive = p === currentProject;
    return `<div class="proj-dd-item${isActive ? ' cur' : ''}" data-proj="${i}">` +
      `<div class="proj-dot${isActive ? '' : ' dim'}"></div>` +
      `<span>${short}</span></div>`;
  }).join('') +
    `<div class="proj-dd-item proj-dd-new" data-proj="__new__">` +
    `<div class="proj-dot"></div><span>${PR_i18n.t('proj.new_item')}</span></div>`;

  dd.onclick = (e) => {
    const item = e.target.closest('[data-proj]');
    if (!item) return;
    e.stopPropagation();
    const key = item.dataset.proj;
    if (key === '__new__') createProject();
    else selectProject(allProjects[parseInt(key)]);
  };
}

// ── Select ────────────────────────────────────────────────
async function selectProject(name) {
  currentProject = name;
  const nameEl = document.getElementById('projName');
  if (nameEl) nameEl.textContent = name.length > 28 ? name.slice(0, 28) + '…' : name;
  toggleProjectDropdown(false);
  const snaps = await SessionPortDB.listByProject(name, { limit: 1 });
  if (snaps[0]) await SessionPortDB.setActive(snaps[0].snapshot_id);
  // Обновить историю/map если экран открыт
  if (typeof renderHistoryScreen === 'function') renderHistoryScreen();
  if (typeof _hmapRenderer !== 'undefined' && _hmapRenderer && typeof _syncFilterToMap === 'function') _syncFilterToMap();
}

// ── Toggle ────────────────────────────────────────────────
function toggleProjectDropdown(force) {
  const dd = document.getElementById('projDD');
  if (!dd) return;
  projectDropdownOpen = force !== undefined ? force : !projectDropdownOpen;
  dd.classList.toggle('open', projectDropdownOpen);
  document.getElementById('projBar')?.classList.toggle('dd-open', projectDropdownOpen);
  // Close snap card when dropdown opens
  if (projectDropdownOpen) {
    const snapCard = document.getElementById('snapCard');
    if (snapCard?.classList.contains('open')) {
      snapCard.classList.remove('open');
      document.getElementById('projInfoBtn')?.classList.remove('active');
      document.getElementById('projBar')?.classList.remove('snap-open');
    }
  }
}

// ── Create ────────────────────────────────────────────────
function createProject() {
  toggleProjectDropdown(false);
  PR_Utils.customPrompt(PR_i18n.t('proj.prompt_create'), name => {
    if (!name || !name.trim()) return;
    const n = name.trim();
    if (!allProjects.includes(n)) allProjects.push(n);
    currentProject = n;
    chrome.storage.local.get('pr_projects', r => {
      const existing = r.pr_projects || [];
      if (!existing.includes(n)) existing.push(n);
      chrome.storage.local.set({ pr_projects: existing, pr_active_project: n });
    });
    const nameEl = document.getElementById('projName');
    if (nameEl) nameEl.textContent = n.length > 28 ? n.slice(0, 28) + '…' : n;
    renderProjectDropdown();
  });
}

// ── Event bindings ────────────────────────────────────────

// Project bar — click opens dropdown
document.getElementById('projBar')?.addEventListener('click', e => {
  if (!e.target.closest('#projDD')) toggleProjectDropdown();
});
// Close dropdown on outside click
document.addEventListener('click', e => {
  if (!e.target.closest('#projBar')) toggleProjectDropdown(false);
});

// + Новый проект
document.getElementById('projAddBtn')?.addEventListener('click', e => {
  e.stopPropagation();
  createProject();
});

// Переименовать проект (карандаш)
document.getElementById('projRenameBtn')?.addEventListener('click', async e => {
  e.stopPropagation();
  if (!currentProject) { setStatus(PR_i18n.t('status.no_project'), 'error'); return; }
  PR_Utils.customPrompt(PR_i18n.t('proj.prompt_rename'), async name => {
    if (!name || !name.trim() || name.trim() === currentProject) return;
    const n = name.trim();
    try {
      if (window.SessionPortDB?.renameProject) {
        await window.SessionPortDB.renameProject(currentProject, n);
      }
    } catch (err) { console.error('renameProject:', err); }
    const idx = allProjects.indexOf(currentProject);
    if (idx !== -1) allProjects[idx] = n;
    chrome.storage.local.get('pr_projects', r => {
      const saved = r.pr_projects || [];
      const si = saved.indexOf(currentProject);
      if (si !== -1) saved[si] = n; else saved.push(n);
      chrome.storage.local.set({ pr_projects: saved, pr_active_project: n });
    });
    currentProject = n;
    renderProjectDropdown();
    const nameEl = document.getElementById('projName');
    if (nameEl) nameEl.textContent = n.length > 28 ? n.slice(0, 28) + '…' : n;
  }, { placeholder: currentProject });
});

// btnDonate/Back/BugBack are handled in popup-shell.js
