(() => {
  'use strict';

  const STORAGE_KEY = 'manhwa-watcher-pagination-v1.1.3';
  const DEFAULT_SIZE = 10;
  const PAGE_SIZES = [10, 25, 50, 100];
  const sizes = loadSizes();
  const pages = { sources: 1, catalog: 1, chapters: 1 };
  const configs = {
    sources: { list: '#sourceList', column: '.sources-column', row: '.source-row' },
    catalog: { list: '#browseResults', column: '.titles-column', row: '.title-row' },
    chapters: { list: '#catalogChapters', column: '.chapters-column', row: '.catalog-chapter-row' }
  };
  const pending = new Set();

  function loadSizes() {
    try {
      const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
      return {
        sources: PAGE_SIZES.includes(Number(parsed.sources)) ? Number(parsed.sources) : DEFAULT_SIZE,
        catalog: PAGE_SIZES.includes(Number(parsed.catalog)) ? Number(parsed.catalog) : DEFAULT_SIZE,
        chapters: PAGE_SIZES.includes(Number(parsed.chapters)) ? Number(parsed.chapters) : DEFAULT_SIZE
      };
    } catch {
      return { sources: DEFAULT_SIZE, catalog: DEFAULT_SIZE, chapters: DEFAULT_SIZE };
    }
  }

  function persistSizes() {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(sizes)); } catch {}
  }

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }

  function injectStyles() {
    if (document.getElementById('mw-pagination-styles')) return;
    const style = document.createElement('style');
    style.id = 'mw-pagination-styles';
    style.textContent = `
      .mw-pager {
        flex: 0 0 auto;
        display: grid;
        grid-template-columns: auto auto minmax(0,1fr) auto auto auto;
        align-items: center;
        gap: 5px;
        min-height: 42px;
        padding: 7px 8px;
        border-top: 1px solid #222d49;
        background: #10192d;
        color: #8f9abd;
        font-size: 10px;
      }
      .mw-pager button {
        min-width: 30px;
        padding: 6px 8px;
        border-radius: 7px;
        background: #24304f;
        font-size: 10px;
      }
      .mw-pager button:disabled { opacity: .35; }
      .mw-page-info {
        min-width: 0;
        display: flex;
        align-items: center;
        justify-content: center;
        gap: 5px;
        white-space: nowrap;
      }
      .mw-page-number {
        width: 48px !important;
        min-width: 48px;
        padding: 5px 6px !important;
        border-radius: 7px !important;
        text-align: center;
        font-size: 10px;
      }
      .mw-page-size {
        width: 62px;
        padding: 5px 6px;
        border-radius: 7px;
        font-size: 10px;
      }
      .mw-page-size-label { white-space: nowrap; color: #7785aa; }

      /* The Sources column is deliberately narrow. Its pager uses a compact
         layout so page controls never overlap or get clipped. */
      .sources-column .mw-pager {
        grid-template-columns: 24px minmax(52px,1fr) 24px 46px;
        gap: 3px;
        min-height: 38px;
        padding: 5px 4px;
      }
      .sources-column .mw-pager button {
        min-width: 24px;
        padding: 5px 4px;
      }
      .sources-column .mw-page-info { gap: 3px; }
      .sources-column .mw-page-number {
        width: 31px !important;
        min-width: 31px;
        padding: 4px 2px !important;
      }
      .sources-column .mw-page-size {
        width: 46px;
        padding: 4px 2px;
      }

      @media (max-width: 900px) {
        .mw-pager:not([data-kind="sources"]) { grid-template-columns: auto auto minmax(100px,1fr) auto auto; }
        .mw-pager:not([data-kind="sources"]) .mw-page-size-label { display: none; }
      }
    `;
    document.head.appendChild(style);
  }

  function ensurePager(kind) {
    const cfg = configs[kind];
    const column = document.querySelector(cfg.column);
    if (!column) return null;
    let pager = column.querySelector(`.mw-pager[data-kind="${kind}"]`);
    if (pager) return pager;

    pager = document.createElement('div');
    pager.className = 'mw-pager';
    pager.dataset.kind = kind;
    const sizeOptions = PAGE_SIZES.map((n) => `<option value="${n}">${n}</option>`).join('');
    pager.innerHTML = kind === 'sources'
      ? `
        <button type="button" data-action="prev" title="Vorherige Seite">‹</button>
        <span class="mw-page-info"><input class="mw-page-number" type="number" min="1" value="1" aria-label="Seitennummer" /> / <span data-role="pages">1</span></span>
        <button type="button" data-action="next" title="Nächste Seite">›</button>
        <label class="mw-page-size-label" title="Einträge pro Seite"><select class="mw-page-size" aria-label="Einträge pro Seite">${sizeOptions}</select></label>
      `
      : `
        <button type="button" data-action="first" title="Erste Seite">«</button>
        <button type="button" data-action="prev" title="Vorherige Seite">‹</button>
        <span class="mw-page-info">Seite <input class="mw-page-number" type="number" min="1" value="1" aria-label="Seitennummer" /> / <span data-role="pages">1</span></span>
        <button type="button" data-action="next" title="Nächste Seite">›</button>
        <button type="button" data-action="last" title="Letzte Seite">»</button>
        <label class="mw-page-size-label" title="Einträge pro Seite"><select class="mw-page-size" aria-label="Einträge pro Seite">${sizeOptions}</select></label>
      `;
    pager.querySelector('.mw-page-size').value = String(sizes[kind]);

    pager.addEventListener('click', (event) => {
      const action = event.target.closest('button')?.dataset.action;
      if (!action) return;
      const totalPages = Number(pager.dataset.totalPages || 1);
      if (action === 'first') pages[kind] = 1;
      else if (action === 'prev') pages[kind] -= 1;
      else if (action === 'next') pages[kind] += 1;
      else if (action === 'last') pages[kind] = totalPages;
      pages[kind] = clamp(pages[kind], 1, Math.max(1, totalPages));
      applyPagination(kind, true);
    });

    const pageInput = pager.querySelector('.mw-page-number');
    const jump = () => {
      const totalPages = Number(pager.dataset.totalPages || 1);
      pages[kind] = clamp(Number.parseInt(pageInput.value, 10) || 1, 1, Math.max(1, totalPages));
      applyPagination(kind, true);
    };
    pageInput.addEventListener('change', jump);
    pageInput.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') { event.preventDefault(); jump(); pageInput.blur(); }
    });

    pager.querySelector('.mw-page-size').addEventListener('change', (event) => {
      sizes[kind] = PAGE_SIZES.includes(Number(event.target.value)) ? Number(event.target.value) : DEFAULT_SIZE;
      pages[kind] = 1;
      persistSizes();
      applyPagination(kind, true);
    });

    column.appendChild(pager);
    return pager;
  }

  function applyPagination(kind, scrollTop = false) {
    const cfg = configs[kind];
    const list = document.querySelector(cfg.list);
    if (!list) return;
    const pager = ensurePager(kind);
    if (!pager) return;

    const rows = [...list.querySelectorAll(`:scope > ${cfg.row}`)];
    const total = rows.length;
    const pageSize = sizes[kind];
    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    pages[kind] = clamp(pages[kind], 1, totalPages);
    const start = (pages[kind] - 1) * pageSize;
    const end = start + pageSize;

    // Do not use the HTML `hidden` attribute here. The existing renderer CSS
    // explicitly sets display:flex on rows, which overrides the browser's
    // hidden presentation. Inline display:none reliably wins that cascade.
    rows.forEach((row, index) => {
      row.style.display = index >= start && index < end ? '' : 'none';
    });

    pager.dataset.totalPages = String(totalPages);
    pager.querySelector('[data-role="pages"]').textContent = String(totalPages);
    pager.querySelector('.mw-page-number').value = String(pages[kind]);
    pager.querySelector('.mw-page-number').max = String(totalPages);
    pager.querySelector('.mw-page-size').value = String(pageSize);
    const firstButton = pager.querySelector('[data-action="first"]');
    if (firstButton) firstButton.disabled = pages[kind] <= 1;
    pager.querySelector('[data-action="prev"]').disabled = pages[kind] <= 1;
    pager.querySelector('[data-action="next"]').disabled = pages[kind] >= totalPages;
    const lastButton = pager.querySelector('[data-action="last"]');
    if (lastButton) lastButton.disabled = pages[kind] >= totalPages;
    pager.style.display = total > 0 ? 'grid' : 'none';
    if (scrollTop) list.scrollTop = 0;
  }

  function scheduleApply(kind, scrollTop = false) {
    const key = `${kind}:${scrollTop ? 1 : 0}`;
    if (pending.has(key)) return;
    pending.add(key);
    requestAnimationFrame(() => {
      pending.delete(key);
      applyPagination(kind, scrollTop);
    });
  }

  function resetPage(kind) {
    pages[kind] = 1;
    scheduleApply(kind, true);
  }

  function observeLists() {
    for (const [kind, cfg] of Object.entries(configs)) {
      const list = document.querySelector(cfg.list);
      if (!list) continue;
      new MutationObserver((mutations) => {
        if (mutations.some((entry) => entry.type === 'childList')) scheduleApply(kind);
      }).observe(list, { childList: true });
    }
  }

  function currentFilteredChapters() {
    try {
      if (!selectedCatalog?.series) return [];
      const needle = document.querySelector('#chapterSearch')?.value.trim().toLowerCase() || '';
      const hideDownloaded = Boolean(document.querySelector('#hideDownloaded')?.checked);
      return [...(selectedCatalog.series.chapters || [])].filter((chapter) => {
        const id = String(chapter.id);
        const downloaded = Boolean(chapter.downloaded) || catalogDownloadedIds.has(id);
        const matches = !needle || String(chapter.title || '').toLowerCase().includes(needle) || String(chapter.number ?? '').includes(needle);
        return matches && (!hideDownloaded || !downloaded);
      });
    } catch {
      return [];
    }
  }

  function installResetListeners() {
    document.querySelector('#browseSearch')?.addEventListener('input', () => resetPage('catalog'), { capture: true });
    document.querySelector('#chapterSearch')?.addEventListener('input', () => resetPage('chapters'), { capture: true });
    document.querySelector('#hideDownloaded')?.addEventListener('change', () => resetPage('chapters'), { capture: true });
    document.querySelector('#favoritesOnly')?.addEventListener('change', () => resetPage('catalog'), { capture: true });
    document.querySelector('#readingOnly')?.addEventListener('change', () => resetPage('catalog'), { capture: true });
    document.querySelectorAll('.series-status-filter input[type="checkbox"]').forEach((node) => {
      node.addEventListener('change', () => resetPage('catalog'), { capture: true });
    });
    document.querySelector('#browseLoadBtn')?.addEventListener('click', () => { resetPage('catalog'); resetPage('chapters'); }, { capture: true });
    document.querySelector('#sourceSelect')?.addEventListener('change', () => { resetPage('catalog'); resetPage('chapters'); }, { capture: true });
    document.querySelector('#sourceList')?.addEventListener('click', (event) => {
      if (event.target.closest('.source-row')) { resetPage('catalog'); resetPage('chapters'); }
    }, { capture: true });
    document.querySelector('#browseResults')?.addEventListener('click', (event) => {
      if (event.target.closest('.title-row')) resetPage('chapters');
    }, { capture: true });

    const selectAll = document.querySelector('#chapterSelectAllBtn');
    selectAll?.addEventListener('click', (event) => {
      const chapters = currentFilteredChapters();
      if (!chapters.length) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      for (const chapter of chapters) selectedChapterIds.add(String(chapter.id));
      renderCatalogChapters();
    }, { capture: true });
  }

  function init() {
    injectStyles();
    ensurePager('sources');
    ensurePager('catalog');
    ensurePager('chapters');
    observeLists();
    installResetListeners();
    applyPagination('sources');
    applyPagination('catalog');
    applyPagination('chapters');
    try { window.manhwaAPI?.rendererLog?.('info', 'Pagination v1.1.3 geladen', { defaultPageSize: DEFAULT_SIZE }); } catch {}
  }

  try {
    init();
  } catch (error) {
    console.error('Pagination konnte nicht initialisiert werden:', error);
    try { window.manhwaAPI?.rendererLog?.('error', 'Pagination konnte nicht initialisiert werden', { message: error.message }); } catch {}
  }
})();
