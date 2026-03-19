(function () {
  const ipc = window.ipc ?? window.electron;
  let cloneStatsCache = { count: 0, total: 0, fileCount: 0, folderCount: 0 };
  const treeMeta = new Map();

  const folderStateMap = new Map(); // path -> 'none' | 'folders-only' | 'full'
  const pathToRow = new Map();
  const pathToNode = new Map();

  const BLUE = 'blue';
  const RED = 'red';
  const OFF = 'off';

  function formatFallback(template, vars) {
    if (!template || !vars) return template;
    return template.replace(/{{\s*(\w+)\s*}}/g, (_match, key) => {
      if (Object.prototype.hasOwnProperty.call(vars, key)) {
        return String(vars[key]);
      }
      return '';
    });
  }

  function t(key, fallback, vars) {
    if (window.i18n?.t) {
      return window.i18n.t(key, vars);
    }
    if (fallback) return formatFallback(fallback, vars);
    return key;
  }



  function formatI18nPayloadMessage(payload, fallback = '') {
    if (typeof window.formatI18nMessage === 'function') {
      return window.formatI18nMessage(payload, fallback);
    }
    if (!payload || typeof payload !== 'object') {
      return typeof payload === 'string' ? payload : String(fallback || '');
    }
    const key = typeof payload.key === 'string' ? payload.key : '';
    const params = payload.params && typeof payload.params === 'object' ? payload.params : {};
    if (!key) return formatFallback(fallback || '', params);
    return t(key, fallback || key, params);
  }

  function resolveI18nText(message, fallback = '') {
    if (message && typeof message === 'object') return formatI18nPayloadMessage(message, fallback);
    if (typeof message === 'string') return message;
    if (message == null) return String(fallback || '');
    return String(message);
  }

  const selection = {
    blue: new Set(),
    red: new Set(),
    off: new Set()
  };

  function syncSelectionGlobals() {
    if (typeof window === 'undefined') return;
    window.cloneSelectedFolders = Array.from(selection.blue);
    window.cloneFoldersOnly = Array.from(selection.red);
    window.cloneExcluded = Array.from(selection.off);
    if (typeof window.cloneIncludeSourceRoot !== 'boolean') {
      window.cloneIncludeSourceRoot = false;
    }
  }

  syncSelectionGlobals();

  function applyCheckboxVisual(path, state, checkboxEl) {
    const selector = `.folder-tree input[type="checkbox"][data-path="${CSS.escape(path)}"]`;
    const el = checkboxEl || document.querySelector(selector);
    if (!el) return;
    if (state === BLUE) {
      setRowUIFromState(el, 'full');
    } else if (state === RED) {
      setRowUIFromState(el, 'folders-only');
    } else {
      setRowUIFromState(el, 'none');
    }
  }

  function getState(path) {
    if (selection.blue.has(path)) return BLUE;
    if (selection.red.has(path)) return RED;
    if (selection.off.has(path)) return OFF;
    return OFF;
  }

  function updateMapsForState(path, state) {
    if (!path) return;
    if (state === BLUE) {
      folderStateMap.set(path, 'full');
    } else if (state === RED) {
      folderStateMap.set(path, 'folders-only');
    } else if (selection.off.has(path)) {
      folderStateMap.set(path, 'none');
    } else {
      folderStateMap.delete(path);
    }
  }

  function setState(path, state) {
    selection.blue.delete(path);
    selection.red.delete(path);
    selection.off.delete(path);
    if (state === BLUE) {
      selection.blue.add(path);
    } else if (state === RED) {
      selection.red.add(path);
    } else {
      selection.off.add(path);
    }
    updateMapsForState(path, state);
    applyCheckboxVisual(path, state);
  }

  function listAncestors(path) {
    if (!path) return [];

    // Prevent "haunted" selection state: never walk above the rendered tree root.
    // (e.g. if the tree root is /Volumes/BINNS/Project, don't ever emit /Volumes/BINNS.)
    const treeRoot = lastRenderedTree?.path;

    // Local normalizer that preserves POSIX root "/" (normalizePathForCompare("/") -> "" currently).
    const norm = p => {
      const s = String(p || '');
      if (!s) return '';
      const n = s.replace(/[\\/]+/g, '/').replace(/\/+$/, '');
      if (!n && s.startsWith('/')) return '/';
      return n;
    };

    const rootNorm = treeRoot ? norm(treeRoot) : '';
    const pathNorm = norm(path);

    const constrainToRoot =
      !!rootNorm && (pathNorm === rootNorm || pathNorm.startsWith(`${rootNorm}/`));

    // If the clicked path IS the tree root, it has no ancestors within the tree.
    if (constrainToRoot && pathNorm === rootNorm) return [];

    const parts = path.split(/[\\/]+/);
    const useBackslash = path.includes('\\') && !path.includes('/');
    const sep = useBackslash ? '\\' : '/';
    const ancestors = [];
    for (let i = parts.length - 1; i > 0; i--) {
      const slice = parts.slice(0, i);
      if (!slice.length) continue;
      let candidate = slice.join(sep);
      if (!candidate && !useBackslash && path.startsWith('/')) candidate = '/';
      if (!candidate) continue;

      if (constrainToRoot) {
        const candNorm = norm(candidate);

        // Stop at (and include) the tree root, but never go above it.
        if (candNorm === rootNorm) {
          ancestors.push(candidate);
          break;
        }

        // If we somehow jumped outside the root, stop immediately.
        if (!(candNorm === rootNorm || candNorm.startsWith(`${rootNorm}/`))) {
          break;
        }
      }

      ancestors.push(candidate);
    }
    return ancestors;
  }

  function listDescendants(path) {
    if (!path) return [];
    const useBackslash = path.includes('\\') && !path.includes('/');
    const sep = useBackslash ? '\\' : '/';
    const prefix = path.endsWith(sep) ? path : `${path}${sep}`;
    const selector = `.folder-tree input[type="checkbox"][data-path^="${CSS.escape(prefix)}"]`;
    return Array.from(document.querySelectorAll(selector))
      .map(el => el.dataset.path)
      .filter(Boolean);
  }

  function hasSelectedDescendant(path) {
    if (!path) return false;
    const useBackslash = path.includes('\\') && !path.includes('/');
    const sep = useBackslash ? '\\' : '/';
    const prefix = path.endsWith(sep) ? path : `${path}${sep}`;
    const check = candidate => candidate && candidate !== path && candidate.startsWith(prefix);
    for (const p of selection.blue) {
      if (check(p)) return true;
    }
    for (const p of selection.red) {
      if (check(p)) return true;
    }
    return false;
  }

  function handleFolderClick(path) {
    const current = getState(path);
    if (current === OFF) {
      // BLUE here (include this folder), make ancestors RED to keep the path,
      // but DO NOT force descendants OFF. We want BLUE to propagate down by default.
      setState(path, BLUE);
      for (const anc of listAncestors(path)) {
        if (getState(anc) === OFF) setState(anc, RED);
      }
      return;
    }
    if (current === RED) {
      // Promote RED→BLUE to include THIS folder’s files (still no descendants).
      const row = document.querySelector(`.tree-row[data-path="${CSS.escape(path)}"]`);
      if (hasDirectFiles(row)) setState(path, BLUE);
      return;
    }
    if (current === BLUE) {
      // Third click → OFF; also turn off descendants and prune ancestors with no selected descendants.
      setState(path, OFF);
      for (const kid of listDescendants(path)) setState(kid, OFF);
      for (const anc of listAncestors(path)) {
        if (!hasSelectedDescendant(anc)) setState(anc, OFF);
      }
    }
  }

  function restoreSelectionFromGlobals() {
    selection.blue.clear();
    selection.red.clear();
    selection.off.clear();
    const blue = Array.isArray(window.cloneSelectedFolders) ? window.cloneSelectedFolders : [];
    const red = Array.isArray(window.cloneFoldersOnly) ? window.cloneFoldersOnly : [];
    const off = Array.isArray(window.cloneExcluded) ? window.cloneExcluded : [];
    blue.forEach(p => selection.blue.add(p));
    red.forEach(p => selection.red.add(p));
    off.forEach(p => selection.off.add(p));
  }

  document.addEventListener('change', event => {
    const el = event.target;
    if (!(el instanceof HTMLInputElement)) return;
    if (!el.matches('.folder-tree input[type="checkbox"][data-path]')) return;
    const path = el.dataset.path;
    if (!path) return;
    event.preventDefault();
    event.stopPropagation();

    if (el.dataset.bulk === '1') {
      delete el.dataset.bulk;
      const targetState = el.checked ? BLUE : OFF;
      setState(path, targetState);
    } else {
      handleFolderClick(path);
    }

    syncSelectionGlobals();
    notifySelectionChanged();
    updateCountsUI();
  });

  function normalizePathForCompare(p) {
    return String(p || '').replace(/[\\/]+/g, '/').replace(/\/+$/, '');
  }

  function setRowUIFromState(cb, state) {
    if (!cb) return;
    if (state === 'folders-only') setTriState(cb, 'partial'); // 🔴 red
    else if (state === 'full') setTriState(cb, 'checked'); // 🔵 blue
    else setTriState(cb, 'unchecked'); // ☐ off
  }

  // 🔍 Helper: does this folder contain direct files (not subfolders)?
  // Uses cached counts when available; falls back to "true" when unknown.
  function hasDirectFiles(row) {
    if (!row) return true;
    const info = folderCountCache.get(row.dataset?.path);
    if (info) return (info.direct ?? 0) > 0;
    return true;
  }
  // Folder file-count cache (path -> { direct, total })
  // NOTE: This is populated via the main-process scan so totals remain accurate
  // even when the folder tree is only partially expanded.
  const folderCountCache = new Map();
  let lastRenderedTree = null;
  let folderCountsKey = '';
  let folderCountsRequestSeq = 0;
  let folderCountsQueued = new Set();
  let folderCountsFlushTimer = null;
  let folderCountsInFlight = false;
  let folderCountsOptions = null;

  function normalizeExtensions(extString = '') {
    return String(extString || '')
      .split(',')
      .map(str => str.trim().toLowerCase().replace(/^\*/, ''))
      .filter(Boolean)
      .map(ext => (ext.startsWith('.') ? ext : `.${ext}`));
  }

  function normalizeExcludePatterns(input) {
    const arr = Array.isArray(input)
      ? input
      : String(input || '')
          .split(',')
          .map(x => x.trim())
          .filter(Boolean);
    return arr.map(x => String(x || '').toLowerCase()).filter(Boolean);
  }

  function buildCountsKey(rootPath, cfg) {
    const includeHiddenFiles = !!cfg.includeHiddenFiles;
    const includeCache = typeof cfg.includeCache === 'boolean' ? cfg.includeCache : undefined;
    const useDefaultIgnorePatterns = typeof includeCache === 'boolean'
      ? !includeCache
      : (cfg.useDefaultIgnorePatterns !== undefined ? !!cfg.useDefaultIgnorePatterns : true);

    const includeExts = Array.from(new Set(normalizeExtensions(cfg.includeExtensions || cfg.filters?.include || ''))).sort();
    const excludeExts = Array.from(new Set(normalizeExtensions(cfg.excludeExtensions || cfg.filters?.exclude || ''))).sort();
    const excludePatterns = normalizeExcludePatterns(cfg.excludePatterns || cfg.filters?.excludePatterns || []).sort();

    return JSON.stringify({
      rootPath: String(rootPath || ''),
      includeHiddenFiles,
      useDefaultIgnorePatterns,
      includeExts,
      excludeExts,
      excludePatterns
    });
  }

  function ensureBadge(row) {
    if (!row) return null;
    let badge = row.querySelector('.tree-count');
    if (!badge) {
      badge = document.createElement('span');
      badge.className = 'tree-count';
      row.appendChild(badge);
    }
    return badge;
  }

  function setRowCountBadge(row, isOpen) {
    if (!row) return;
    const badge = ensureBadge(row);
    if (!badge) return;

    const showBadge = !!document.getElementById('clone-show-file-count')?.checked;
    badge.style.display = showBadge ? '' : 'none';
    if (!showBadge) {
      badge.textContent = '';
      return;
    }

    const rowPath = row.dataset?.path;
    if (!rowPath) {
      badge.textContent = '';
      badge.style.display = 'none';
      return;
    }

    const counts = folderCountCache.get(rowPath);
    if (!counts) {
      // Scan pending (or path not indexed yet)
      badge.textContent = '(…)';
      return;
    }

    const value = isOpen ? counts.direct : counts.total;
    badge.textContent = `(${value ?? 0})`;
  }

  function updateAllCountBadges(treeEl) {
    if (!treeEl) return;
    treeEl.querySelectorAll('.tree-row').forEach(row => {
      const isOpen = !!getChildrenContainer(row)?.classList?.contains('open');
      setRowCountBadge(row, isOpen);
    });
  }

  function scheduleCountsFlush(delayMs) {
    if (folderCountsFlushTimer) {
      clearTimeout(folderCountsFlushTimer);
      folderCountsFlushTimer = null;
    }
    folderCountsFlushTimer = setTimeout(() => {
      folderCountsFlushTimer = null;
      void flushCountsQueue();
    }, Math.max(0, delayMs || 0));
  }

  async function flushCountsQueue() {
    if (folderCountsInFlight) return;
    if (!folderCountsOptions) return;

    const paths = Array.from(folderCountsQueued);
    folderCountsQueued.clear();
    if (!paths.length) return;

    folderCountsInFlight = true;
    const seq = folderCountsRequestSeq;

    try {
      const res = await ipc.invoke('get-folder-file-counts', {
        ...folderCountsOptions,
        paths
      });

      // Ignore stale responses
      if (seq !== folderCountsRequestSeq) return;

      if (res?.success && res?.counts && typeof res.counts === 'object') {
        for (const [p, c] of Object.entries(res.counts)) {
          if (!p) continue;
          folderCountCache.set(p, {
            direct: Number(c?.direct || 0),
            total: Number(c?.total || 0)
          });
        }
      }
    } catch {
      // ignore errors (counts are a UI-only enhancement)
    } finally {
      folderCountsInFlight = false;
    }

    // Refresh badges with whatever counts we have now.
    updateAllCountBadges(document.getElementById('clone-folder-tree'));

    // If anything queued up during the request, flush again.
    if (folderCountsQueued.size) {
      scheduleCountsFlush(0);
    }
  }

  async function updateCountsUI() {
    const treeEl = document.getElementById('clone-folder-tree');
    if (!treeEl) return;

    const showBadge = !!document.getElementById('clone-show-file-count')?.checked;
    if (!showBadge) {
      treeEl.querySelectorAll('.tree-row').forEach(row => {
        const badge = row.querySelector('.tree-count');
        if (badge) {
          badge.style.display = 'none';
          badge.textContent = '';
        }
      });
      return;
    }

    const rootPath = lastRenderedTree?.path;
    if (!rootPath) {
      updateAllCountBadges(treeEl);
      return;
    }

    const cfg = (globalThis.gatherIngestConfig && globalThis.gatherIngestConfig()) || {};
    const key = buildCountsKey(rootPath, cfg);

    const keyChanged = key !== folderCountsKey;
    if (keyChanged) {
      folderCountsKey = key;
      folderCountCache.clear();
      folderCountsQueued.clear();
      folderCountsRequestSeq += 1;
    }

    const includeCache = typeof cfg.includeCache === 'boolean' ? cfg.includeCache : undefined;
    const useDefaultIgnorePatterns = typeof includeCache === 'boolean'
      ? !includeCache
      : (cfg.useDefaultIgnorePatterns !== undefined ? !!cfg.useDefaultIgnorePatterns : true);

    folderCountsOptions = {
      rootPath,
      includeHiddenFiles: !!cfg.includeHiddenFiles,
      includeCache,
      useDefaultIgnorePatterns,
      includeExtensions: cfg.includeExtensions || cfg.filters?.include || '',
      excludeExtensions: cfg.excludeExtensions || cfg.filters?.exclude || '',
      excludePatterns: cfg.excludePatterns || cfg.filters?.excludePatterns || []
    };

    const visibleRows = Array.from(treeEl.querySelectorAll('.tree-row'));
    for (const row of visibleRows) {
      const p = row?.dataset?.path;
      if (!p) continue;
      if (!folderCountCache.has(p)) {
        folderCountsQueued.add(p);
      }
    }

    updateAllCountBadges(treeEl);

    if (folderCountsQueued.size) {
      // Debounce steady-state updates, but fetch immediately when the filter key changes.
      scheduleCountsFlush(keyChanged ? 0 : 150);
    }
  }

  function setTriState(cb, state) {
    if (!cb) return;
    // No indeterminate UI: "partial" = checked + .partial (red styling in CSS)
    cb.indeterminate = false;
    cb.classList.remove('partial');
    if (state === 'checked') {
      cb.checked = true;
    } else if (state === 'partial') {
      cb.checked = true;
      cb.classList.add('partial');
    } else {
      cb.checked = false;
    }
  }

  function renderFolderTree(node, container, depth = 0) {
    if (depth === 0) {
      folderStateMap.clear();
      lastRenderedTree = node;
      pathToRow.clear();
      treeMeta.clear();
      pathToNode.clear();
      restoreSelectionFromGlobals();
    }

    const nodeType = node?.type || 'directory';
    if (nodeType !== 'directory') return;

    const children = Array.isArray(node.children) ? node.children : [];
    const folderChildren = children.filter(ch => {
      const t = ch.type || (Array.isArray(ch.children) && ch.children.length ? 'directory' : 'file');
      return t === 'directory';
    });

    const row = document.createElement('div');
    row.className = 'tree-row';
    row.dataset.path = node?.path || '';
    if (node?.path) {
      pathToRow.set(node.path, row);
      pathToNode.set(node.path, node);
    }
    row.dataset.type = nodeType;

    const hasPotentialChildren = !!node?.hasChildren || folderChildren.length > 0;
    const toggle = document.createElement('span');
    toggle.className = 'tree-toggle';
    toggle.textContent = hasPotentialChildren ? '▶' : ' ';
    row.appendChild(toggle);

    const icon = document.createElement('span');
    icon.className = 'tree-icon';
    icon.textContent = '📁';
    row.appendChild(icon);

    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.dataset.path = node?.path || '';
    row.appendChild(checkbox);

    const currentState = node?.path ? getState(node.path) : OFF;
    if (node?.path) {
      updateMapsForState(node.path, currentState);
    }
    applyCheckboxVisual(node?.path || '', currentState, checkbox);

    const label = document.createElement('span');
    label.className = 'tree-label';
    label.textContent = node.name;
    row.appendChild(label);

    ensureBadge(row);

    container.appendChild(row);

    let childContainerEl;
    if (hasPotentialChildren) {
      childContainerEl = document.createElement('div');
      childContainerEl.className = 'tree-children';

      if (node?.path) {
        treeMeta.set(node.path, {
          hasMore: !!node?.hasMore,
          nextOffset: node?.nextOffset ?? null,
          loaded: folderChildren.length > 0
        });
      }

      toggle.addEventListener('click', async () => {
        const isOpen = childContainerEl.classList.toggle('open');
        toggle.textContent = isOpen ? '▼' : '▶';
        icon.textContent = isOpen ? '📂' : '📁';
        setRowCountBadge(row, isOpen);
        if (isOpen && node?.path && !treeMeta.get(node.path)?.loaded) {
          await loadChildrenForRow(node.path, childContainerEl, row);
        }
      });

      folderChildren.forEach(child =>
        renderFolderTree(child, childContainerEl, depth + 1)
      );
      if (node?.path) {
        updateLoadMoreRow(node.path, childContainerEl);
      }
      container.appendChild(childContainerEl);
    }

    row.dataset.hasChildren = hasPotentialChildren;

    const isOpen = !!getChildrenContainer(row)?.classList?.contains('open');
    setRowCountBadge(row, isOpen);
  }

  // Helper: find the actual children container for a row (or null)
  function getChildrenContainer(row) {
    const sib = row?.nextElementSibling;
    return sib && sib.classList && sib.classList.contains('tree-children') ? sib : null;
  }

  async function loadChildrenForRow(path, container, row) {
    if (!path || !container) return;
    const currentMeta = treeMeta.get(path) || {};
    if (row) {
      row.dataset.loading = 'true';
    }

    const loadMoreRow = container.querySelector('.tree-load-more');
    if (loadMoreRow) loadMoreRow.remove();

    const timeoutMs = 15000;
    const requestPayload = {
      rootPath: lastRenderedTree?.path || path,
      parentPath: path,
      depth: 1,
      limit: 200,
      offset: currentMeta.nextOffset || 0,
      includeHiddenFiles: !!document.getElementById('include-hidden-files')?.checked
    };

    try {
      const result = await Promise.race([
        ipc.invoke('get-folder-tree', requestPayload),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('Folder tree request timed out')), timeoutMs)
        )
      ]);

      if (!result?.success) {
        throw new Error(resolveI18nText(result?.error, 'Unable to fetch folder tree'));
      }

      const children = Array.isArray(result.tree?.children) ? result.tree.children : [];
      const dirChildren = children.filter(child => {
        const t = child?.type || (Array.isArray(child?.children) && child.children.length ? 'directory' : 'file');
        return t === 'directory';
      });

      dirChildren.forEach(child => renderFolderTree(child, container, 1));
      const targetNode = pathToNode.get(path);
      if (targetNode) {
        targetNode.children = (targetNode.children || []).concat(dirChildren);
      }

      const hasMore = !!result.tree?.hasMore;
      const nextOffset = result.tree?.nextOffset ?? null;
      treeMeta.set(path, {
        hasMore,
        nextOffset,
        loaded: true
      });

      updateLoadMoreRow(path, container);
      updateCountsUI();
    } catch (err) {
      const errorRow = document.createElement('div');
      errorRow.className = 'tree-row tree-error';
      errorRow.textContent = t(
        'cloneTreeLoadError',
        '❌ {{message}}',
        { message: err?.message || err }
      );
      container.appendChild(errorRow);
    } finally {
      if (row) {
        delete row.dataset.loading;
      }
    }
  }

  function updateLoadMoreRow(path, container) {
    if (!container) return;
    const meta = treeMeta.get(path);
    const existing = container.querySelector('.tree-load-more');
    if (meta?.hasMore) {
      if (existing) return;
      const loadMore = document.createElement('div');
      loadMore.className = 'tree-row tree-load-more';
      loadMore.textContent = t('cloneTreeLoadMore', 'Load more…');
      loadMore.addEventListener('click', async () => {
        await loadChildrenForRow(path, container, pathToRow.get(path));
      });
      container.appendChild(loadMore);
    } else if (existing) {
      existing.remove();
    }
  }

  function notifySelectionChanged() {
    document.getElementById('clone-folder-tree')
      ?.dispatchEvent(new CustomEvent('clone-selection-changed', { bubbles: true }));
  }

  function getSelectedFolders(sourceRoot) {
    const unique = arr => Array.from(new Set(arr));
    const denest = arr =>
      arr.filter((p, i) => !arr.some((q, j) =>
        j !== i && normalizePathForCompare(p).startsWith(normalizePathForCompare(q) + '/')
      ));

    const root = normalizePathForCompare(sourceRoot || '');
    const withinRoot = (p) => {
      const np = normalizePathForCompare(p);
      if (!np) return false;
      if (!root) return true; // no root provided: don't filter
      return np === root || np.startsWith(root + '/');
    };

    const selectedFolders = unique(Array.from(selection.blue).filter(withinRoot));
    const foldersOnly = unique(Array.from(selection.red).filter(withinRoot));
    const excludedFolders = denest(Array.from(selection.off).filter(withinRoot));

    return {
      selectedFolders,
      foldersOnly,
      excludedFolders,
      selectedFiles: [],
      includeSourceRoot: !!window.cloneIncludeSourceRoot
    };
  }

  const presetDir = window.electron?.resolvePath?.('config', 'presets', 'clone');

  async function refreshPresetDropdown() {
    const hidden = document.getElementById('clone-preset');
    if (!hidden) return;
    let opts = [];
    try {
      const electronApi = window.electron;
      const mkdir = (typeof electronApi?.mkdirAsync === 'function')
        ? electronApi.mkdirAsync.bind(electronApi)
        : (typeof electronApi?.mkdir === 'function')
          ? async (p) => { electronApi.mkdir(p); return true; }
          : null;
      const readdir = (typeof electronApi?.readdirAsync === 'function')
        ? electronApi.readdirAsync.bind(electronApi)
        : (typeof electronApi?.readdir === 'function')
          ? async (p) => (electronApi.readdir(p) || [])
          : null;

      if (mkdir && readdir && presetDir) {
        await mkdir(presetDir);
        const files = await readdir(presetDir);
        opts = files
          .filter(f => f.endsWith('.json'))
          .map(f => ({ value: f, label: f.replace(/\.json$/, '') }));
      }
    } catch (err) {
      console.error('Failed to read presets:', err);
    }
    setupStyledDropdown('clone-preset', opts);
    setDropdownValue('clone-preset', hidden.value || '');
    window.translatePage?.();

    if (!hidden.dataset.listenerBound) {
      hidden.addEventListener('change', () => {
        const file = hidden.value;
        if (!file) return;
        (async () => {
          try {
            const electronApi = window.electron;
            if (!presetDir || !electronApi?.joinPath) {
              throw new Error('Preset loading requires Electron file APIs.');
            }
            const fullPath = electronApi.joinPath(presetDir, file);
            const raw = (typeof electronApi?.readTextFileAsync === 'function')
              ? await electronApi.readTextFileAsync(fullPath)
              : (typeof electronApi?.readTextFile === 'function')
                ? electronApi.readTextFile(fullPath)
                : '';
            const data = JSON.parse(raw || '{}');
            applyClonePreset(data);
          } catch (err) {
            console.error('Failed to load preset', err);
          }
        })();
      });
      hidden.dataset.listenerBound = 'true';
    }
  }

  function ensureCloneDestinationStatus(destEl = document.getElementById('clone-dest-path')) {
    let statusEl = document.getElementById('clone-destination-status');
    if (statusEl) return statusEl;
    if (!destEl) return null;
    statusEl = document.createElement('div');
    statusEl.id = 'clone-destination-status';
    statusEl.className = 'input-error';
    statusEl.setAttribute('role', 'alert');
    statusEl.setAttribute('aria-live', 'polite');
    statusEl.hidden = true;
    const host = destEl.closest('.field-group') || destEl.parentElement;
    if (host) {
      host.insertAdjacentElement('afterend', statusEl);
    } else {
      destEl.insertAdjacentElement('afterend', statusEl);
    }
    return statusEl;
  }

  function setCloneDestinationValidation(message, destEl = document.getElementById('clone-dest-path')) {
    const statusEl = ensureCloneDestinationStatus(destEl);
    const msg = String(message ?? '').trim();
    if (destEl) {
      if (msg) {
        destEl.setAttribute('aria-invalid', 'true');
      } else {
        destEl.removeAttribute('aria-invalid');
      }
    }
    if (!statusEl) return;
    statusEl.textContent = msg;
    statusEl.hidden = !msg;
  }

  function applyClonePreset(data) {
    const srcEl = document.getElementById('clone-source-path');
    if (srcEl) srcEl.value = data.source || data.sourcePath || '';
    const destEl = document.getElementById('clone-dest-path');
    if (destEl) {
      destEl.value = data.destination || data.destPath || '';
      setCloneDestinationValidation('', destEl);
    }
    const skip = document.getElementById('clone-skip-existing');
    if (skip) skip.checked = !!data.skipExisting;
    const flat = document.getElementById('clone-flatten');
    if (flat) flat.checked = !!data.flatten;
    const rem = document.getElementById('clone-remove-empty');
    if (rem) rem.checked = !!data.removeEmptyFolders;
    const chk = document.getElementById('clone-checksum');
    if (chk) chk.checked = !!data.checksum;
    const method = document.getElementById('clone-checksum-method');
    if (method) method.value = data.checksumMethod || 'blake3';
    const save = document.getElementById('clone-save-log');
    if (save) save.checked = !!data.saveLog;
    const byteCompare = document.getElementById('clone-byte-compare');
    if (byteCompare) byteCompare.checked = !!data.byteCompare;
    const retry = document.getElementById('clone-retry-failures');
    if (retry) retry.checked = !!data.retryFailures;
    const exclExt = document.getElementById('clone-exclude-ext');
    if (exclExt) exclExt.value = data.excludeExtensions || '';
    const exclPat = document.getElementById('clone-exclude-pattern');
    if (exclPat) exclPat.value = data.excludePatterns || '';
    const par = document.getElementById('clone-parallel');
    const auto = document.getElementById('clone-auto-threads');
    if (par) par.checked = data.maxThreads !== 1;
    if (auto) auto.checked = data.maxThreads == null;
    const threadSlider = document.getElementById('clone-max-threads');
    if (threadSlider) threadSlider.value = data.maxThreads || '3';
    const threadCount = document.getElementById('clone-thread-count');
    if (threadSlider && threadCount) {
      if (!par?.checked) threadCount.textContent = '1';
      else if (auto?.checked) threadCount.textContent = 'Auto';
      else threadCount.textContent = threadSlider.value;
    }
    const notesEl = document.getElementById('clone-notes');
    if (notesEl) notesEl.value = data.notes || '';
  }

  async function buildCloneConfig(opts = {}) {
    const get = id => document.getElementById(id);
    const val = id => get(id)?.value;
    const checked = id => get(id)?.checked;
    const srcId = opts.sourceId || 'clone-source-path';
    const destId = opts.destId || 'clone-dest-path';
    const destEl = get(destId);
    const destPath = val(destId);
    const exists = await (async () => {
      try {
        const electronApi = window.electron;
        if (!destPath) return false;
        if (typeof electronApi?.fileExistsAsync === 'function') return await electronApi.fileExistsAsync(destPath);
        if (typeof ipc?.invoke === 'function') return await ipc.invoke('path-exists', destPath);
        if (typeof electronApi?.fileExists === 'function') return !!electronApi.fileExists(destPath);
      } catch {}
      return false;
    })();
    if (!destPath || !exists) {
      // Abort if destination is missing or doesn't exist
      const validationMessage = t(
        'cloneInvalidDestinationFolder',
        '❌ Please select a valid destination folder.'
      );
      setCloneDestinationValidation(validationMessage, destEl);
      destEl?.focus();
      destEl?.scrollIntoView?.({ block: 'nearest' });
      return null;
    }
    setCloneDestinationValidation('', destEl);
    return {
      source: val(srcId),
      destination: destPath,
      createIfMissing: true,
      skipExisting: checked(opts.skipExistingId || 'clone-skip-existing'),
      flatten: checked(opts.flattenId || 'clone-flatten'),
      preserveTimestamps: true,
      removeEmptyFolders: checked(opts.removeEmptyId || 'clone-remove-empty'),
      checksum: checked(opts.checksumId || 'clone-checksum'),
      checksumMethod: val(opts.checksumMethodId || 'clone-checksum-method') || 'blake3',
      verbose: false,
      saveLog: checked(opts.saveLogId || 'clone-save-log'),
      maxThreads: get(opts.parallelId || 'clone-parallel')?.checked
        ? get(opts.autoThreadsId || 'clone-auto-threads')?.checked
          ? null
          : parseInt(val(opts.maxThreadsId || 'clone-max-threads') || '3', 10)
        : 1,
      byteCompare: checked(opts.byteCompareId || 'clone-byte-compare'),
      retryFailures: checked(opts.retryId || 'clone-retry-failures'),
      backup: document.getElementById('dualCopy')?.checked,
      backupPath: document.getElementById('backup-path')?.value,
      ...getSelectedFolders(val(srcId)),
      excludeExtensions: val(opts.excludeExtId || 'clone-exclude-ext'),
      excludePatterns: val(opts.excludePatternId || 'clone-exclude-pattern'),
      notes: val(opts.notesId || 'clone-notes'),
      cloneMode: true
    };
  }

  async function calculateCloneBytes(cfg) {
    try {
      const res = await ipc.invoke('calculate-clone-bytes', cfg);
      if (res?.success) {
        const total = res.total ?? 0;
        const fileCount = res.fileCount ?? res.count ?? 0;
        const folderCount = res.folderCount ?? 0;
        cloneStatsCache = { total, fileCount, folderCount, count: fileCount };
      }
    } catch {
      // ignore errors
    }
    return cloneStatsCache;
  }

  function getCachedCloneStats() {
    return cloneStatsCache;
  }

  async function queueCloneJob(opts = {}) {
    const config = await buildCloneConfig(opts);
    if (!config) return null;
    const descriptor = {
      config,
      expectedCopyBytes: cloneStatsCache.total || 0,
      expectedBackupBytes: config.backup ? cloneStatsCache.total || 0 : 0,
      fileSizeMap: {}
    };
    const jobId = await ipc.invoke('queue-add-ingest', descriptor);
    await ipc.invoke('queue-start');
    return jobId;
  }

  function initClonePanel() {
    const checkbox = document.getElementById('clone-show-queue');
    const table = document.getElementById('clone-status-table');
    const header = document.getElementById('clone-queue-header');
    if (checkbox && table && header) {
      const update = () => {
        const show = checkbox.checked;
        table.style.display = show ? '' : 'none';
        header.style.display = show ? '' : 'none';
      };
      checkbox.addEventListener('change', update);
      update();
    }

    const destEl = document.getElementById('clone-dest-path');
    if (destEl && !destEl.dataset.validationBound) {
      const clearDestinationValidation = () => setCloneDestinationValidation('', destEl);
      destEl.addEventListener('input', clearDestinationValidation);
      destEl.addEventListener('change', clearDestinationValidation);
      destEl.dataset.validationBound = 'true';
    }

    void refreshPresetDropdown();
  }

  const api = {
    initClonePanel,
    buildCloneConfig,
    calculateCloneBytes,
    getCachedCloneStats,
    refreshPresetDropdown,
    applyClonePreset,
    getSelectedFolders,
    renderFolderTree,
    queueCloneJob,
    updateCountsUI
  };

  if (typeof window !== 'undefined') {
    window.cloneUtils = api;
    // Signal to panels that clone utilities are ready (supports delayed-load scenarios).
    try {
      window.dispatchEvent(new Event('clone-utils-ready'));
    } catch {
      // non-fatal
    }
  }
  if (typeof module !== 'undefined') {
    module.exports = api;
  }
})();
