/**
 * SessionPort — map-renderer.js
 * Единый SVG-рендерер графа снапшотов.
 * Используется в popup (screenMap) и dashboard.html.
 *
 * Использование:
 *   const renderer = new PR_MapRenderer(containerEl, svgEl, opts);
 *   renderer.draw(snapshots, activeId);
 *   renderer.setFilter(projectName);
 *   renderer.zoom(factor);
 *   renderer.reset();
 *   renderer.onNodeClick = (snap) => { ... };
 */

class PR_MapRenderer {
  constructor(canvasEl, svgEl, opts = {}) {
    this.canvas   = canvasEl;
    this.svg      = svgEl;
    this.emptyEl  = opts.emptyEl || null;
    this.tooltipEl = null;

    // State
    this.snaps      = [];
    this.activeId   = null;
    this.selectedId = null;
    this.filter     = null;
    this.scale      = 1;
    this.offX       = opts.initX ?? 40;
    this.offY       = opts.initY ?? 30;

    // Callbacks
    this.onNodeClick   = null;
    this.onNodeHover   = null;

    // Pan state
    this._dragging = false;
    this._dx = 0; this._dy = 0;
    this._ox = 0; this._oy = 0;

    // Node drag state
    this._storageKey       = opts.storageKey || 'pr_map_pos';
    this._manualPos        = {};   // snapshot_id → {x, y} user overrides
    this._nodeDragging     = null; // snapshot_id being dragged
    this._nodeDragData     = null; // {startClientX, startClientY, startX, startY}
    this._nodeDragMoved    = false;
    this._lastClickWasDrag = false;

    // Group drag state (root rect → move whole project column)
    this._groupDragging  = null; // project name
    this._groupDragData  = null; // {startClientX, startClientY, initPositions}
    this._groupDragMoved = false;

    // Colors
    this.COLORS = ['#22c55e', '#f59e0b', '#3b82f6', '#7c3aed', '#f87171', '#06b6d4'];
    // Darker variants for light theme (better contrast on white/light backgrounds)
    this.COLORS_LIGHT = ['#16a34a', '#d97706', '#2563eb', '#6d28d9', '#dc2626', '#0891b2'];

    this._bindPan();
    this._loadPositions();
  }

  /** Check if host page uses light theme */
  get isLight() {
    return document.body.classList.contains('light');
  }

  /** Get color for current theme */
  _color(index) {
    const palette = this.isLight ? this.COLORS_LIGHT : this.COLORS;
    return palette[index % palette.length];
  }

  /** Fill opacity suffix — more opaque on light backgrounds */
  _fillAlpha(isHead) {
    if (this.isLight) return isHead ? '55' : '22';
    return isHead ? '33' : '11';
  }

  /** Root rect fill */
  _rootFillAlpha() { return this.isLight ? '18' : '22'; }

  /** Muted text color */
  _mutedColor() { return this.isLight ? '#4b5563' : '#6b7280'; }
  _dimColor()   { return this.isLight ? '#6b7280' : '#4b5563'; }

  // ── Public API ───────────────────────────────────────────────

  draw(snapshots, activeId, manualLinks = []) {
    this.snaps       = snapshots   || [];
    this.activeId    = activeId    || null;
    this.manualLinks = manualLinks || [];
    // _manualPos not reset — positions persist across redraws and tab switches
    this._render();
  }

  setFilter(projectName) {
    this.filter = projectName || null;
    this.offX = 40;
    this.offY = 30;
    this.scale = 1;
    this._render();
  }

  zoom(factor) {
    this.scale = Math.min(4, Math.max(0.2, this.scale * factor));
    this._render();
  }

  reset(initX = 40, initY = 30) {
    this.scale = 1;
    this.offX  = initX;
    this.offY  = initY;
    this._render();
  }

  selectNode(id) {
    this.selectedId = id || null;
    this._render();
  }

  _loadPositions() {
    if (!chrome?.storage?.local) return;
    chrome.storage.local.get([this._storageKey], r => {
      const saved = r[this._storageKey];
      if (saved && typeof saved === 'object' && Object.keys(saved).length > 0) {
        Object.assign(this._manualPos, saved);
        if (this.snaps.length > 0) this._render();
      }
    });
  }

  _savePositions() {
    if (!chrome?.storage?.local) return;
    chrome.storage.local.set({ [this._storageKey]: this._manualPos });
  }

  // ── Core render ─────────────────────────────────────────────

  _render() {
    // Очищаем mousemove tooltip listener перед перерисовкой
    this._hideTooltip();
    this.svg.innerHTML = '';

    const snaps = this.filter
      ? this.snaps.filter(s => s.project === this.filter)
      : this.snaps;

    if (!snaps.length) {
      if (this.emptyEl) this.emptyEl.style.display = 'block';
      return;
    }
    if (this.emptyEl) this.emptyEl.style.display = 'none';

    // Group by project
    const byProj = {};
    snaps.forEach(s => {
      const p = s.project || 'unknown';
      if (!byProj[p]) byProj[p] = [];
      byProj[p].push(s);
    });
    // Sort projects so connected ones are adjacent (reduces long crossing edges)
    const projects = this._sortProjects(Object.keys(byProj).sort(), snaps);

    const W    = this.canvas.offsetWidth || this.canvas.clientWidth || 600;
    const colW = Math.max(160, Math.floor(W / Math.max(1, projects.length)));

    // Root <g> with transform
    const root = this._el('g');
    root.setAttribute('transform',
      `translate(${this.offX},${this.offY}) scale(${this.scale})`);
    this.svg.appendChild(root);

    // Positions map for edge drawing
    const pos = {};

    projects.forEach((proj, pi) => {
      const color  = this._color(pi);
      const list   = byProj[proj].slice().sort((a, b) =>
        a.created_at.localeCompare(b.created_at));

      // --- Main chain vs forks ---
      const mainChain = list.filter(s => !this._isFork(s, list));
      const forks     = list.filter(s =>  this._isFork(s, list));

      const rootId = 'root_' + pi;
      const calcRootX = colW * pi + colW / 2;
      const calcRootY = 32;
      const { x: rootX, y: rootY } = this._manualPos[rootId] || { x: calcRootX, y: calcRootY };
      pos[rootId] = { x: rootX, y: rootY };

      // Root rect (project label) — returns rect element for group drag
      const rootRectEl = this._drawRootRect(root, proj, rootX, rootY, color, colW);

      // Main chain nodes
      mainChain.forEach((s, si) => {
        const calcX = rootX;
        const calcY = rootY + 58 + si * 68;
        const { x: nx, y: ny } = this._manualPos[s.snapshot_id] || { x: calcX, y: calcY };
        pos[s.snapshot_id] = { x: nx, y: ny };
        const isHead = s.snapshot_id === this.activeId;
        const prevId = si === 0 ? rootId : mainChain[si - 1].snapshot_id;
        this._drawEdge(root, pos[prevId], { x: nx, y: ny }, color, false);
        this._drawNode(root, s, nx, ny, color, isHead, false);
      });

      // Fork nodes (offset right from their parent, index per-parent to avoid x-drift)
      const _forkIndexByParent = {};
      forks.forEach(s => {
        const pid = s.parent_id || rootId;
        _forkIndexByParent[pid] = (_forkIndexByParent[pid] || 0);
      });
      forks.forEach(s => {
        const pid = s.parent_id || rootId;
        const fi  = _forkIndexByParent[pid]++;
        const parentPos = (s.parent_id && pos[s.parent_id]) ? pos[s.parent_id] : pos[rootId];
        const calcX = parentPos.x + 80 + fi * 72;
        const calcY = parentPos.y + 36;
        const { x: nx, y: ny } = this._manualPos[s.snapshot_id] || { x: calcX, y: calcY };
        pos[s.snapshot_id] = { x: nx, y: ny };
        const isHead  = s.snapshot_id === this.activeId;
        this._drawEdge(root, parentPos, { x: nx, y: ny }, color, true);
        this._drawNode(root, s, nx, ny, color, isHead, true);
      });

      // Group drag: mousedown on root rect moves entire project column (rect + all nodes)
      const projSnapIds = [rootId, ...mainChain.map(s => s.snapshot_id), ...forks.map(s => s.snapshot_id)];
      rootRectEl.style.cursor = 'move';
      rootRectEl.addEventListener('mousedown', e => {
        e.stopPropagation();
        this._groupDragging = proj;
        this._groupDragData = {
          startClientX:  e.clientX,
          startClientY:  e.clientY,
          initPositions: Object.fromEntries(
            projSnapIds.map(id => [id, { ...(pos[id] || { x: 0, y: 0 }) }])
          ),
        };
        this._groupDragMoved = false;
      });
    });

    // Cross-project edges — arrowhead markers + source-colored stroke
    const byTid = new Map(this.snaps.filter(s => s.transfer_id).map(s => [s.transfer_id, s.snapshot_id]));

    // Project → color index for edge coloring by source
    const projColorIdx = {};
    projects.forEach((p, i) => { projColorIdx[p] = i; });

    const _ensureArrowMarker = (color) => {
      const id = 'arr-' + color.slice(1);
      if (this.svg.querySelector('#' + id)) return 'url(#' + id + ')';
      let defs = this.svg.querySelector('defs');
      if (!defs) { defs = this._el('defs'); this.svg.insertBefore(defs, this.svg.firstChild); }
      const marker = this._el('marker');
      marker.setAttribute('id', id);
      marker.setAttribute('markerWidth', '7'); marker.setAttribute('markerHeight', '7');
      marker.setAttribute('refX', '6');        marker.setAttribute('refY', '3');
      marker.setAttribute('orient', 'auto');
      const poly = this._el('polygon');
      poly.setAttribute('points', '0 0, 6 3, 0 6');
      poly.setAttribute('fill', color);
      poly.setAttribute('fill-opacity', '0.8');
      marker.appendChild(poly);
      defs.appendChild(marker);
      return 'url(#' + id + ')';
    };

    // Adds an invisible wide stroke path for easier hover/tooltip triggering
    const _addHitArea = (d, tooltipText) => {
      const hit = this._el('path');
      hit.setAttribute('d', d);
      hit.setAttribute('fill', 'none');
      hit.setAttribute('stroke', 'transparent');
      hit.setAttribute('stroke-width', '14');
      hit.setAttribute('pointer-events', 'stroke');
      if (tooltipText) {
        const t = this._el('title');
        t.textContent = tooltipText;
        hit.appendChild(t);
      }
      return hit;
    };

    const _drawCrossEdge = (posA, posB, srcColor, label) => {
      if (!posA || !posB) return;
      const arrowRef = _ensureArrowMarker(srcColor);
      const path = this._el('path');
      const dx = posB.x - posA.x;
      const dy = posB.y - posA.y;
      const dist = Math.sqrt(dx * dx + dy * dy) || 1;
      const ux = dx / dist;
      const uy = dy / dist;
      const r = 18;
      const sx = posA.x + ux * r;
      const sy = posA.y + uy * r;
      const ex = posB.x - ux * r;
      const ey = posB.y - uy * r;
      const mx = sx + (ex - sx) * 0.5;
      const my = sy + (ey - sy) * 0.5 - Math.min(60, Math.abs(dx) * 0.35 + 20);
      const d = `M ${sx} ${sy} Q ${mx} ${my} ${ex} ${ey}`;
      path.setAttribute('d', d);
      path.setAttribute('fill', 'none');
      path.setAttribute('stroke', srcColor);
      path.setAttribute('stroke-width', '1.5');
      path.setAttribute('stroke-dasharray', '5,3');
      path.setAttribute('stroke-opacity', '0.65');
      path.setAttribute('pointer-events', 'none');
      path.setAttribute('marker-end', arrowRef);
      root.insertBefore(path, root.firstChild);
      const hit = _addHitArea(d, label || '');
      root.insertBefore(hit, path.nextSibling);
    };

    // Manual links (user-created via "Связать" button) — purple solid arc, bows downward
    const _drawManualLink = (posA, posB, comment) => {
      if (!posA || !posB) return;
      const arrowRef = _ensureArrowMarker('#a855f7');
      const path = this._el('path');
      const dx = posB.x - posA.x;
      const dy = posB.y - posA.y;
      const dist = Math.sqrt(dx * dx + dy * dy) || 1;
      const ux = dx / dist, uy = dy / dist;
      const r = 18;
      const sx = posA.x + ux * r, sy = posA.y + uy * r;
      const ex = posB.x - ux * r, ey = posB.y - uy * r;
      const mx = sx + (ex - sx) * 0.5;
      const my = sy + (ey - sy) * 0.5 + Math.min(50, Math.abs(dx) * 0.25 + 15);
      const d = `M ${sx} ${sy} Q ${mx} ${my} ${ex} ${ey}`;
      path.setAttribute('d', d);
      path.setAttribute('fill', 'none');
      path.setAttribute('stroke', '#a855f7');
      path.setAttribute('stroke-width', '2');
      path.setAttribute('stroke-opacity', '0.85');
      path.setAttribute('pointer-events', 'none');
      path.setAttribute('marker-end', arrowRef);
      root.insertBefore(path, root.firstChild);
      const hit = _addHitArea(d, comment ? '💬 ' + comment : '');
      root.insertBefore(hit, path.nextSibling);
    };

    (this.manualLinks || []).forEach(link => {
      _drawManualLink(pos[link.from_id], pos[link.to_id], link.comment);
    });

    snaps.forEach(s => {
      // Legacy cross-project link via parent_id
      if (s.parent_id) {
        const parent = this.snaps.find(p => p.snapshot_id === s.parent_id);
        if (parent && parent.project !== s.project) {
          const srcColor = this._color(projColorIdx[parent.project] ?? 0);
          const label = `${parent.project || '?'} → ${s.project || '?'}`;
          _drawCrossEdge(pos[s.parent_id], pos[s.snapshot_id], srcColor, label);
        }
      }
      // v1.2.38: cross-device/cross-platform link via parent_transfer_id
      if (s.parent_transfer_id) {
        const parentSnapId = byTid.get(s.parent_transfer_id);
        if (parentSnapId && parentSnapId !== s.parent_id) {
          const parentSnap = this.snaps.find(p => p.snapshot_id === parentSnapId);
          const srcColor = parentSnap ? this._color(projColorIdx[parentSnap.project] ?? 0) : '#a855f7';
          const label = parentSnap
            ? `${parentSnap.project || '?'} → ${s.project || '?'} (cross-device)`
            : `cross-device → ${s.project || '?'}`;
          _drawCrossEdge(pos[parentSnapId], pos[s.snapshot_id], srcColor, label);
        }
      }
    });
  }

  // ── Drawing helpers ─────────────────────────────────────────

  _drawRootRect(g, proj, x, y, color, colW) {
    const rw = Math.min(110, colW - 16);
    const rect = this._el('rect');
    rect.setAttribute('x', x - rw / 2);   rect.setAttribute('y', y - 14);
    rect.setAttribute('width', rw);        rect.setAttribute('height', 28);
    rect.setAttribute('rx', '7');
    rect.setAttribute('fill', color + this._rootFillAlpha());
    rect.setAttribute('stroke', color);    rect.setAttribute('stroke-width', '1.5');
    g.appendChild(rect);

    const dot = this._el('circle');
    dot.setAttribute('cx', x - rw / 2 + 9); dot.setAttribute('cy', y);
    dot.setAttribute('r', '3'); dot.setAttribute('fill', color);
    dot.setAttribute('pointer-events', 'none');
    g.appendChild(dot);

    const txt = this._el('text');
    txt.setAttribute('x', x - rw / 2 + 17); txt.setAttribute('y', y + 4);
    txt.setAttribute('text-anchor', 'start');
    txt.setAttribute('fill', color);
    txt.setAttribute('font-size', '9');   txt.setAttribute('font-weight', '600');
    txt.setAttribute('pointer-events', 'none');
    txt.textContent = proj.length > 14 ? proj.slice(0, 14) + '…' : proj;
    g.appendChild(txt);

    return rect;
  }

  _drawNode(g, snap, x, y, color, isHead, isFork) {
    const r = isHead ? 22 : 16;

    // Glow filter for HEAD
    if (isHead) this._ensureGlowFilter(x, color);

    const circle = this._el('circle');
    circle.setAttribute('cx', x);  circle.setAttribute('cy', y);
    circle.setAttribute('r', r);
    circle.setAttribute('fill', color + this._fillAlpha(isHead));
    circle.setAttribute('stroke', color);
    circle.setAttribute('stroke-width', isHead ? '2.5' : '1.5');
    if (isFork) circle.setAttribute('stroke-dasharray', '4,2');
    if (isHead) circle.setAttribute('filter', `url(#pr-glow-${color.slice(1)})`);
    circle.style.cursor = 'pointer';

    circle.addEventListener('mousedown', e => {
      e.stopPropagation();
      this._nodeDragging = snap.snapshot_id;
      this._nodeDragData = { startClientX: e.clientX, startClientY: e.clientY, startX: x, startY: y };
      this._nodeDragMoved = false;
    });
    circle.addEventListener('click', () => {
      if (this._lastClickWasDrag) { this._lastClickWasDrag = false; return; }
      this.selectedId = snap.snapshot_id;
      this._render();
      if (this.onNodeClick) this.onNodeClick(snap);
    });
    circle.addEventListener('mouseenter', e => this._showTooltip(e, snap, isHead));
    circle.addEventListener('mouseleave', () => this._hideTooltip());
    g.appendChild(circle);

    // Selection ring
    if (this.selectedId === snap.snapshot_id) {
      const ring = this._el('circle');
      ring.setAttribute('cx', x);
      ring.setAttribute('cy', y);
      ring.setAttribute('r', String(r + 6));
      ring.setAttribute('fill', 'none');
      ring.setAttribute('stroke', color);
      ring.setAttribute('stroke-width', '1.5');
      ring.setAttribute('stroke-opacity', '0.6');
      ring.setAttribute('stroke-dasharray', '3,2');
      ring.setAttribute('pointer-events', 'none');
      g.appendChild(ring);
    }

    // Label inside: HEAD or host short
    const hostLabel = (snap.source_host || '').replace('www.', '').split('.')[0].slice(0, 6);
    const t1 = this._el('text');
    t1.setAttribute('x', x); t1.setAttribute('y', y + (isHead ? -2 : 1));
    t1.setAttribute('text-anchor', 'middle');
    t1.setAttribute('fill', color);
    t1.setAttribute('font-size', isHead ? '8' : '7');
    t1.setAttribute('font-weight', isHead ? '700' : '500');
    t1.setAttribute('pointer-events', 'none');
    t1.textContent = isHead ? 'HEAD' : hostLabel;
    g.appendChild(t1);

    // Date below host label — only for HEAD (large circle r=22, fits inside)
    if (isHead) {
      const t2 = this._el('text');
      t2.setAttribute('x', x); t2.setAttribute('y', y + 12);
      t2.setAttribute('text-anchor', 'middle');
      t2.setAttribute('fill', this._mutedColor());
      t2.setAttribute('font-size', '6');
      t2.setAttribute('pointer-events', 'none');
      t2.textContent = new Date(snap.created_at).toLocaleDateString('ru-RU',
        { day: '2-digit', month: '2-digit' });
      g.appendChild(t2);
    }
  }

  _drawEdge(g, from, to, color, isDashed) {
    const r = 16;
    const fromY = from.y + (from.y < to.y ? 14 : r);
    const ln = this._el('line');
    ln.setAttribute('x1', from.x); ln.setAttribute('y1', fromY);
    ln.setAttribute('x2', to.x);   ln.setAttribute('y2', to.y - r);
    ln.setAttribute('stroke', color);
    ln.setAttribute('stroke-width', '1.5');
    ln.setAttribute('stroke-opacity', '0.45');
    if (isDashed) ln.setAttribute('stroke-dasharray', '4,3');
    g.insertBefore(ln, g.firstChild);
  }

  _sortProjects(projects, snaps) {
    if (projects.length <= 1) return projects;
    // Count cross-project connections between each pair
    const adj = {};
    snaps.forEach(s => {
      if (!s.parent_id) return;
      const parent = this.snaps.find(p => p.snapshot_id === s.parent_id);
      if (!parent || parent.project === s.project) return;
      const a = parent.project || 'unknown';
      const b = s.project  || 'unknown';
      if (!adj[a]) adj[a] = {};
      if (!adj[b]) adj[b] = {};
      adj[a][b] = (adj[a][b] || 0) + 1;
      adj[b][a] = (adj[b][a] || 0) + 1;
    });
    // Greedy nearest-neighbor: pick next column with most connections to already-placed columns
    const placed = new Set();
    const result = [];
    result.push(projects[0]);
    placed.add(projects[0]);
    while (result.length < projects.length) {
      const last = result[result.length - 1];
      let best = null, bestScore = -1;
      projects.forEach(p => {
        if (placed.has(p)) return;
        const score = (adj[last] && adj[last][p]) || 0;
        if (score > bestScore) { bestScore = score; best = p; }
      });
      if (!best) best = projects.find(p => !placed.has(p));
      result.push(best);
      placed.add(best);
    }
    return result;
  }

  _isFork(snap, list) {
    if (!snap.parent_id) return false;
    return list.filter(s => s.parent_id === snap.parent_id).length > 1;
  }

  _ensureGlowFilter(x, color) {
    const id = `pr-glow-${color.slice(1)}`;
    if (this.svg.querySelector('#' + id)) return;
    const defs   = this._el('defs');
    const filter = this._el('filter');
    filter.setAttribute('id', id);
    filter.setAttribute('x', '-50%'); filter.setAttribute('y', '-50%');
    filter.setAttribute('width', '200%'); filter.setAttribute('height', '200%');
    const blur = this._el('feGaussianBlur');
    blur.setAttribute('stdDeviation', '3'); blur.setAttribute('result', 'blur');
    const merge = this._el('feMerge');
    const m1 = this._el('feMergeNode'); m1.setAttribute('in', 'blur');
    const m2 = this._el('feMergeNode'); m2.setAttribute('in', 'SourceGraphic');
    merge.appendChild(m1); merge.appendChild(m2);
    filter.appendChild(blur); filter.appendChild(merge);
    defs.appendChild(filter);
    this.svg.insertBefore(defs, this.svg.firstChild);
  }

  // ── Tooltip ─────────────────────────────────────────────────

  _showTooltip(e, snap, isHead) {
    if (!this.tooltipEl) {
      this.tooltipEl = document.createElement('div');
      this.tooltipEl.className = 'map-tooltip';
      this.canvas.style.position = this.canvas.style.position || 'relative';
      this.canvas.appendChild(this.tooltipEl);
    }
    const date = new Date(snap.created_at).toLocaleString('ru-RU',
      { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
    const kb = (snap.size_bytes / 1024).toFixed(1);
    const esc = PR_Utils.esc.bind(PR_Utils);
    this.tooltipEl.innerHTML =
      `<div class="map-tooltip-title">${esc(snap.project || 'unknown')}</div>` +
      `<div class="map-tooltip-meta">${esc(snap.source_host || '')}${snap.target_host ? ' → ' + esc(snap.target_host) : ''}</div>` +
      `<div class="map-tooltip-meta" style="margin-top:2px;">${date} · ${kb} KB</div>` +
      (isHead ? '<div class="map-tooltip-head">● HEAD</div>' : '');
    this._moveTooltip(e);
    this.tooltipEl.style.opacity = '1';
    let _rafId = null;
    this.canvas.addEventListener('mousemove', this._onMouseMove = e2 => {
      if (_rafId) cancelAnimationFrame(_rafId);
      _rafId = requestAnimationFrame(() => { this._moveTooltip(e2); _rafId = null; });
    });
  }

  _moveTooltip(e) {
    if (!this.tooltipEl) return;
    const rect = this.canvas.getBoundingClientRect();
    let lx = e.clientX - rect.left + 14;
    let ly = e.clientY - rect.top  + 14;
    const tw = this.tooltipEl.offsetWidth || 200;
    if (lx + tw > rect.width - 8) lx = e.clientX - rect.left - tw - 10;
    this.tooltipEl.style.left = lx + 'px';
    this.tooltipEl.style.top  = ly + 'px';
  }

  _hideTooltip() {
    if (this.tooltipEl) this.tooltipEl.style.opacity = '0';
    if (this._onMouseMove) {
      this.canvas.removeEventListener('mousemove', this._onMouseMove);
      this._onMouseMove = null;
    }
  }

  // ── Pan ─────────────────────────────────────────────────────

  _bindPan() {
    const c = this.canvas;
    let _panRaf = null;
    const _scheduleRender = () => {
      if (_panRaf) return;
      _panRaf = requestAnimationFrame(() => { this._render(); _panRaf = null; });
    };

    c.addEventListener('mousedown', e => {
      if (e.target.tagName === 'circle' || e.target.closest?.('circle')) return;
      e.preventDefault();
      this._dragging = true;
      c.style.cursor = 'grabbing';
      c.style.userSelect = 'none';
      this._dx = e.clientX; this._dy = e.clientY;
      this._ox = this.offX;  this._oy = this.offY;
    });

    this._panMoveHandler = e => {
      if (this._groupDragging) {
        const dd = this._groupDragData;
        const dxc = (e.clientX - dd.startClientX) / this.scale;
        const dyc = (e.clientY - dd.startClientY) / this.scale;
        if (Math.abs(dxc) > 3 || Math.abs(dyc) > 3) this._groupDragMoved = true;
        if (this._groupDragMoved) {
          Object.entries(dd.initPositions).forEach(([id, init]) => {
            this._manualPos[id] = { x: init.x + dxc, y: init.y + dyc };
          });
          _scheduleRender();
        }
        return;
      }
      if (this._nodeDragging) {
        const dd = this._nodeDragData;
        const dxc = (e.clientX - dd.startClientX) / this.scale;
        const dyc = (e.clientY - dd.startClientY) / this.scale;
        if (Math.abs(dxc) > 3 || Math.abs(dyc) > 3) this._nodeDragMoved = true;
        if (this._nodeDragMoved) {
          this._manualPos[this._nodeDragging] = { x: dd.startX + dxc, y: dd.startY + dyc };
          _scheduleRender();
        }
        return;
      }
      if (!this._dragging) return;
      this.offX = this._ox + (e.clientX - this._dx);
      this.offY = this._oy + (e.clientY - this._dy);
      _scheduleRender();
    };
    window.addEventListener('mousemove', this._panMoveHandler);

    this._panUpHandler = () => {
      if (this._groupDragging) {
        if (this._groupDragMoved) this._savePositions();
        this._groupDragging  = null;
        this._groupDragData  = null;
        this._groupDragMoved = false;
        return;
      }
      if (this._nodeDragging) {
        if (this._nodeDragMoved) { this._lastClickWasDrag = true; this._savePositions(); }
        this._nodeDragging = null;
        this._nodeDragData = null;
        this._nodeDragMoved = false;
        return;
      }
      this._dragging = false;
      c.style.cursor = 'grab';
      c.style.userSelect = '';
    };
    window.addEventListener('mouseup', this._panUpHandler);

    c.addEventListener('wheel', e => {
      e.preventDefault();
      this.zoom(e.deltaY > 0 ? 0.9 : 1.1);
    }, { passive: false });
  }

  destroy() {
    this._hideTooltip();
    if (this.tooltipEl) { this.tooltipEl.remove(); this.tooltipEl = null; }
    if (this._panMoveHandler) { window.removeEventListener('mousemove', this._panMoveHandler); this._panMoveHandler = null; }
    if (this._panUpHandler)   { window.removeEventListener('mouseup',   this._panUpHandler);   this._panUpHandler   = null; }
  }

  // ── SVG helper ──────────────────────────────────────────────

  _el(tag) {
    return document.createElementNS('http://www.w3.org/2000/svg', tag);
  }
}
