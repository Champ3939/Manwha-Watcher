const $ = (selector) => document.querySelector(selector);

function languageName(code) {
  const map = { en: 'Englisch', de: 'Deutsch', fr: 'Französisch', es: 'Spanisch', pt: 'Portugiesisch', it: 'Italienisch', pl: 'Polnisch', ru: 'Russisch', tr: 'Türkisch', id: 'Indonesisch', vi: 'Vietnamesisch', ko: 'Koreanisch', ja: 'Japanisch', zh: 'Chinesisch', th: 'Thailändisch', ar: 'Arabisch' };
  return map[String(code || '').toLowerCase()] || (code ? String(code).toUpperCase() : 'Sprache unbekannt');
}

function normalizeSeriesStatus(value) {
  const raw = String(value || '').trim().toLowerCase().replace(/[\s_-]+/g, ' ');
  if (/\b(?:cancelled|canceled|discontinued)\b/.test(raw)) return 'cancelled';
  if (/\b(?:dropped|abandoned)\b/.test(raw)) return 'dropped';
  if (/\b(?:hiatus|on hiatus|paused|pause)\b/.test(raw)) return 'hiatus';
  if (/\b(?:completed|complete|finished|ended)\b/.test(raw)) return 'completed';
  if (/\b(?:upcoming|not yet released|coming soon|announced|pre release|pre-release)\b/.test(raw)) return 'upcoming';
  if (/\b(?:ongoing|on going|publishing|releasing|active|serialization)\b/.test(raw)) return 'ongoing';
  return 'unknown';
}

function seriesStatusName(value) {
  return { ongoing: 'Ongoing', completed: 'Completed', hiatus: 'Hiatus', upcoming: 'Upcoming', cancelled: 'Cancelled', dropped: 'Dropped', unknown: 'Unbekannt' }[normalizeSeriesStatus(value)] || 'Unbekannt';
}

function selectedSeriesStatuses() {
  return ['ongoing','completed','hiatus','upcoming','cancelled','dropped','unknown'].filter((key) => $('#status-' + key)?.checked);
}

function catalogStatusAllowed(item) {
  return selectedSeriesStatuses().includes(normalizeSeriesStatus(item?.status));
}

async function saveSeriesStatusSettings() {
  let allowedSeriesStatuses = selectedSeriesStatuses();
  if (!allowedSeriesStatuses.length) {
    $('#status-ongoing').checked = true;
    allowedSeriesStatuses = ['ongoing'];
    setStatus('Mindestens ein Serienstatus muss sichtbar sein. Ongoing wurde wieder aktiviert.');
  }
  await window.manhwaAPI.setSettings({ seriesStatusFilterEnabled: true, allowedSeriesStatuses });
  renderCatalog();
  updateSiteDownloadControls();
  const hidden = catalogItems.length - catalogItems.filter(catalogStatusAllowed).length;
  setStatus(`Statusfilter gespeichert: ${allowedSeriesStatuses.map(seriesStatusName).join(', ')}${hidden ? ` · ${hidden} Serie(n) ausgeblendet` : ''}.`);
}


function updateStatusScanButton() {
  const button = $('#statusScanBtn');
  if (!button) return;
  const unknown = catalogItems.filter((item) => normalizeSeriesStatus(item.status) === 'unknown').length;
  button.disabled = statusScanRunning || !catalogItems.length;
  button.textContent = statusScanRunning ? 'Status wird geprüft …' : (unknown ? `Status prüfen (${unknown})` : 'Status neu prüfen');
}

async function runStatusDebug() {
  const target = selectedCatalog?.series || catalogItems.find(catalogStatusAllowed) || catalogItems[0];
  if (!target?.url) return setStatus('Bitte zuerst einen Katalog laden oder eine Serie auswählen.');
  const card = $('#statusDebugCard');
  const output = $('#statusDebugOutput');
  card?.classList.remove('hidden');
  if (output) output.textContent = `Status-Debug für „${target.title || target.url}“ läuft …`;
  setStatus(`Status-Debug für „${target.title || target.url}“ …`);
  try {
    const report = await window.manhwaAPI.catalogDebugStatus(target.url);
    const compact = {
      series: { title: target.title || null, url: target.url },
      finalDetection: report?.finalDetection || null,
      http: report?.http ? {
        finalUrl: report.http.finalUrl || null,
        detected: report.http.detected || null,
        bytes: report.http.bytes || null,
        structured: report.http.structured || [],
        lineHits: report.http.lineHits || [],
        rawHits: (report.http.rawHits || []).slice(0, 10),
        error: report.http.error || null
      } : null,
      browser: report?.browser ? {
        url: report.browser.url || null,
        title: report.browser.title || null,
        htmlLang: report.browser.htmlLang || null,
        bodyLength: report.browser.bodyLength || null,
        lineHits: report.browser.lineHits || [],
        snippets: report.browser.snippets || [],
        error: report.browser.error || null
      } : null
    };
    if (output) output.textContent = JSON.stringify(compact, null, 2);
    const detected = normalizeSeriesStatus(report?.finalDetection?.status);
    setStatus(`Status-Debug fertig: ${seriesStatusName(detected)}. Den Inhalt des Debug-Feldes kannst du mir schicken.`);
  } catch (error) {
    if (output) output.textContent = `FEHLER\n${error.message}`;
    setStatus(`Status-Debug fehlgeschlagen: ${error.message}`);
  }
}

async function refreshCatalogStatuses(force = false) {
  if (statusScanRunning) return;
  if (!catalogItems.length) return setStatus('Bitte zuerst einen Serienkatalog laden.');
  const unknownBefore = catalogItems.filter((item) => normalizeSeriesStatus(item.status) === 'unknown').length;
  if (!force && unknownBefore === 0) {
    if (!confirm('Alle Serien haben bereits einen Status. Alle Statuswerte trotzdem neu prüfen?')) return;
    force = true;
  }
  statusScanRunning = true;
  updateStatusScanButton();
  const meta = $('#browseMeta');
  try {
    setStatus(`Statusprüfung gestartet: ${unknownBefore || catalogItems.length} Serie(n) …`);
    if (meta) meta.textContent = `Serienstatus wird von den Detailseiten gelesen und lokal gecacht …`;
    const result = await window.manhwaAPI.catalogRefreshStatuses({
      catalogUrl: lastCatalogResult?.pageUrl || normalizeBrowseUrl($('#browseUrl')?.value || ''),
      force,
      items: catalogItems.map((item) => ({ title: item.title, url: item.url, status: item.status, statusSource: item.statusSource || null }))
    });
    const byUrl = new Map((result.statuses || []).map((entry) => [normalizeBrowseUrl(entry.url).replace(/\/$/, ''), entry]));
    catalogItems = catalogItems.map((item) => {
      const hit = byUrl.get(normalizeBrowseUrl(item.url).replace(/\/$/, ''));
      return hit ? { ...item, status: normalizeSeriesStatus(hit.status), statusSource: hit.source || 'series-page' } : item;
    });
    const unknown = catalogItems.filter((item) => normalizeSeriesStatus(item.status) === 'unknown').length;
    renderCatalog();
    setStatus(`Statusprüfung fertig: ${result.updated || 0} neu erkannt · ${unknown} weiterhin unbekannt.`);
    if (meta) meta.textContent = `${lastCatalogResult?.pageTitle || lastCatalogResult?.hostname || 'Katalog'} · ${catalogItems.length} Serien · Statuscache aktualisiert · ${unknown} unbekannt`;
  } catch (error) {
    setStatus(`Statusprüfung fehlgeschlagen: ${error.message}`);
  } finally {
    statusScanRunning = false;
    updateStatusScanButton();
  }
}

async function saveLanguageSettings() {
  const allowedLanguages = [];
  if ($('#langEn')?.checked) allowedLanguages.push('en');
  if ($('#langDe')?.checked) allowedLanguages.push('de');
  if (!allowedLanguages.length) {
    $('#langEn').checked = true;
    allowedLanguages.push('en');
    setStatus('Mindestens eine Sprache muss aktiv sein. Englisch wurde wieder aktiviert.');
  }
  await window.manhwaAPI.setSettings({
    languageFilterEnabled: true,
    allowedLanguages,
    allowUnknownLanguage: Boolean($('#langUnknown')?.checked)
  });
  setStatus(`Sprachfilter gespeichert: ${allowedLanguages.map((x) => x.toUpperCase()).join(' + ')}${$('#langUnknown')?.checked ? ' + unbekannt' : ''}.`);
}

window.addEventListener('error', (event) => {
  try { window.manhwaAPI?.rendererLog?.('error', 'JavaScript-Fehler', { message: event.message, source: event.filename, line: event.lineno, column: event.colno }); } catch {}
});
window.addEventListener('unhandledrejection', (event) => {
  try { window.manhwaAPI?.rendererLog?.('error', 'Unbehandelte Promise-Ablehnung', { message: String(event.reason?.message || event.reason || 'unknown') }); } catch {}
});
const list = $('#seriesList');
const status = $('#status');
let lastChapterTest = null;
let pickerInProgress = false;
let catalogItems = [];
let catalogSources = [];
let savedWebsites = [];
let editingWebsiteId = null;
let selectedCatalog = null;
let selectedChapterIds = new Set();
let catalogDownloadedIds = new Set();
let catalogLoading = false;
let statusScanRunning = false;
let lastCatalogResult = null;
let downloadActivity = new Map();
let recentDownloads = [];
let queueItems = [];
let queueRefreshTimer = null;
let updateScanRunning = false;
let liveUpdateRows = [];
let siteDownloadRunning = false;
let siteDownloadPaused = false;
let phoneSyncStatus = { root: '', targetCount: 0, targets: [], running: false };
let readingListItems = [];
let newsItems = [];
let newsSummaryState = null;
let libraryHealthResult = null;
let libraryScanRunning = false;
let libraryRepairRunning = false;

function setStatus(text) { status.textContent = text; }

async function loadAppVersion() {
  try {
    const version = await window.manhwaAPI.getAppVersion();
    const node = $('#versionLabel');
    if (node && version) {
      node.textContent = `v${version} · Stable · SQLite + Favoriten + Leseliste + Neuheiten`;
      document.title = `Manhwa Watcher v${version}`;
    }
  } catch {}
}

function formatDate(value) { return value ? new Date(value).toLocaleString() : 'noch nie'; }
function shortConnector(id) { return String(id || '').replace(/^recipe:/, ''); }
function slugify(value) { return String(value || '').toLowerCase().replace(/^www\./, '').replace(/\.[a-z]{2,}$/i, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48); }
function humanizeDomain(domain) { return String(domain || '').replace(/^www\./, '').split('.')[0].replace(/[-_]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()); }
function showPanel(id, show = true) { $(id).classList.toggle('hidden', !show); }

function normalizeBrowseUrl(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  try {
    const u = new URL(raw.includes('://') ? raw : `https://${raw}`);
    return u.href;
  } catch { return raw; }
}

function sameUrl(a, b) {
  const left = normalizeBrowseUrl(a).replace(/\/$/, '');
  const right = normalizeBrowseUrl(b).replace(/\/$/, '');
  return Boolean(left && right && left === right);
}

async function refreshPhoneSync() {
  try {
    phoneSyncStatus = await window.manhwaAPI.getPhoneSyncStatus();
    const root = String(phoneSyncStatus.root || '').trim();
    const pathNode = $('#phoneSyncPath');
    if (pathNode) pathNode.textContent = root || 'Noch nicht ausgewählt.';
    const count = Number(phoneSyncStatus.targetCount || phoneSyncStatus.targets?.length || 0);
    const countNode = $('#phoneSyncCount');
    if (countNode) countNode.textContent = String(count);
    const headerButton = $('#phoneSyncToggleBtn');
    if (headerButton) headerButton.textContent = count ? `Handy-Sync (${count})` : 'Handy-Sync';
    const openButton = $('#openPhoneSyncFolderBtn');
    if (openButton) openButton.disabled = !root;
    const runButton = $('#runPhoneSyncBtn');
    if (runButton) runButton.disabled = !root || !count || Boolean(phoneSyncStatus.running);
    renderPhoneSyncSeries();
    if (selectedCatalog?.series) {
      selectedCatalog.syncEnabled = (phoneSyncStatus.targets || []).some((item) => sameUrl(item.seriesUrl, selectedCatalog.series.url));
      renderCatalogChapters();
    }
  } catch (error) {
    setStatus(`Handy-Sync-Status konnte nicht geladen werden: ${error.message}`);
  }
}

function renderPhoneSyncSeries() {
  const box = $('#phoneSyncSeriesList');
  if (!box) return;
  box.innerHTML = '';
  const targets = Array.isArray(phoneSyncStatus.targets) ? phoneSyncStatus.targets : [];
  if (!targets.length) {
    box.innerHTML = '<div class="empty compact">Noch keine Serien markiert. Öffne eine Serie und klicke rechts oben auf „📱 Sync“.</div>';
    return;
  }
  for (const target of targets) {
    const row = document.createElement('div'); row.className = 'phone-sync-row';
    const copy = document.createElement('div'); copy.className = 'phone-sync-row-copy';
    const title = document.createElement('strong'); title.textContent = target.title || 'Serie';
    const url = document.createElement('small'); url.textContent = target.seriesUrl || '';
    copy.append(title, url);
    const remove = document.createElement('button'); remove.className = 'danger'; remove.textContent = 'Sync aus';
    remove.addEventListener('click', async () => {
      try {
        await window.manhwaAPI.togglePhoneSyncSeries({ url: target.seriesUrl, title: target.title, enabled: false });
        await refreshPhoneSync();
        setStatus(`Handy-Sync für „${target.title}“ deaktiviert. Bereits synchronisierte Dateien werden nicht gelöscht.`);
      } catch (error) { setStatus(`Handy-Sync konnte nicht geändert werden: ${error.message}`); }
    });
    row.append(copy, remove); box.appendChild(row);
  }
}

async function runPhoneSync() {
  const progress = $('#phoneSyncProgress');
  try {
    progress.className = 'update-progress working';
    progress.textContent = 'Handy-Sync wird vorbereitet …';
    const result = await window.manhwaAPI.runPhoneSync();
    if (result?.skipped) {
      progress.textContent = 'Ein Handy-Sync läuft bereits.';
      return;
    }
    progress.className = result.errors ? 'update-progress error' : 'update-progress done';
    progress.textContent = `${result.checkedSeries || 0}/${result.totalSeries || 0} Serien · ${result.copied || 0} CBZ neu kopiert · ${result.existing || 0} bereits vorhanden${result.errors ? ` · ${result.errors} Fehler` : ''}`;
    setStatus(`Handy-Sync fertig: ${result.copied || 0} neue CBZ.`);
  } catch (error) {
    progress.className = 'update-progress error';
    progress.textContent = `Fehler: ${error.message}`;
    setStatus(`Handy-Sync fehlgeschlagen: ${error.message}`);
  } finally {
    await refreshPhoneSync();
  }
}

function renderSources() {
  const listBox = $('#sourceList');
  const select = $('#sourceSelect');
  const previous = select.value;
  listBox.innerHTML = '';
  select.innerHTML = '<option value="">Quelle auswählen …</option>';
  const total = savedWebsites.length + catalogSources.length;
  $('#sourceCount').textContent = String(total);

  if (!total) {
    listBox.innerHTML = '<div class="empty compact">Noch keine Webseiten gespeichert oder Web-Connectoren eingerichtet.</div>';
    return;
  }

  const activateButton = (button) => {
    document.querySelectorAll('.source-row.active').forEach((node) => node.classList.remove('active'));
    button.classList.add('active');
  };

  for (const site of savedWebsites) {
    const value = `site:${site.id}`;
    const option = document.createElement('option');
    option.value = value; option.textContent = `★ ${site.name}`;
    select.appendChild(option);

    const button = document.createElement('button');
    button.className = 'source-row saved-source';
    button.innerHTML = '<strong></strong><small></small><span class="source-kind">gespeichert</span>';
    button.querySelector('strong').textContent = site.name;
    button.querySelector('small').textContent = site.url;
    button.addEventListener('click', async () => {
      select.value = value;
      $('#browseUrl').value = site.url;
      activateButton(button);
      await loadCatalog(false);
    });
    listBox.appendChild(button);
  }

  for (const source of catalogSources) {
    const value = `connector:${source.domain}`;
    const option = document.createElement('option');
    option.value = value; option.textContent = `${source.label} · ${source.domain}`;
    select.appendChild(option);

    const button = document.createElement('button');
    button.className = 'source-row';
    button.innerHTML = '<strong></strong><small></small><span class="source-kind">Connector</span>';
    button.querySelector('strong').textContent = source.label;
    button.querySelector('small').textContent = source.domain;
    button.addEventListener('click', async () => {
      select.value = value;
      $('#browseUrl').value = `https://${source.domain}/`;
      activateButton(button);
      await loadCatalog(false);
    });
    listBox.appendChild(button);
  }
  if ([...select.options].some((o) => o.value === previous)) select.value = previous;
}

async function refreshWebsites() {
  try {
    savedWebsites = await window.manhwaAPI.listWebsites();
    const button = $('#websitesToggleBtn');
    if (button) button.textContent = savedWebsites.length ? `Webseiten (${savedWebsites.length})` : 'Webseiten';
    renderSources();
    renderWebsiteManager();
  } catch (error) {
    setStatus(`Gespeicherte Webseiten konnten nicht geladen werden: ${error.message}`);
  }
}

function renderWebsiteManager() {
  const box = $('#websiteList');
  if (!box) return;
  box.innerHTML = '';
  if (!savedWebsites.length) {
    box.innerHTML = '<div class="empty compact">Noch keine Webseiten gespeichert.</div>';
    return;
  }
  for (const site of savedWebsites) {
    const row = document.createElement('div');
    row.className = 'website-row';
    const info = document.createElement('div');
    info.className = 'website-row-copy';
    const name = document.createElement('strong'); name.textContent = site.name;
    const url = document.createElement('small'); url.textContent = site.url;
    info.append(name, url);
    const open = document.createElement('button'); open.className = 'secondary'; open.textContent = 'Öffnen';
    open.addEventListener('click', async () => {
      $('#browseUrl').value = site.url;
      $('#sourceSelect').value = `site:${site.id}`;
      showPanel('#websitesPanel', false);
      $('#browsePanel').scrollIntoView({ behavior: 'smooth', block: 'start' });
      await loadCatalog(false);
    });
    const edit = document.createElement('button'); edit.className = 'secondary'; edit.textContent = 'Bearbeiten';
    edit.addEventListener('click', () => {
      editingWebsiteId = site.id;
      $('#websiteName').value = site.name;
      $('#websiteUrl').value = site.url;
      $('#saveWebsiteBtn').textContent = 'Änderungen speichern';
      $('#cancelWebsiteEditBtn').classList.remove('hidden');
      $('#websiteName').focus();
    });
    const remove = document.createElement('button'); remove.className = 'danger'; remove.textContent = 'Löschen';
    remove.addEventListener('click', async () => {
      if (!confirm(`„${site.name}“ aus den gespeicherten Webseiten entfernen?`)) return;
      try {
        await window.manhwaAPI.removeWebsite(site.id);
        await refreshWebsites();
        setStatus(`„${site.name}“ wurde aus den gespeicherten Webseiten entfernt.`);
      } catch (error) { setStatus(`Webseite konnte nicht entfernt werden: ${error.message}`); }
    });
    row.append(info, open, edit, remove);
    box.appendChild(row);
  }
}

function resetWebsiteEditor() {
  editingWebsiteId = null;
  $('#websiteName').value = '';
  $('#websiteUrl').value = '';
  $('#saveWebsiteBtn').textContent = 'Webseite speichern';
  $('#cancelWebsiteEditBtn').classList.add('hidden');
}

async function saveWebsiteFromEditor() {
  const data = { name: $('#websiteName').value.trim(), url: normalizeBrowseUrl($('#websiteUrl').value) };
  if (!data.url) return setStatus('Bitte eine Webseiten-/Katalog-URL eingeben.');
  try {
    const item = editingWebsiteId
      ? await window.manhwaAPI.updateWebsite(editingWebsiteId, data)
      : await window.manhwaAPI.addWebsite(data);
    resetWebsiteEditor();
    await refreshWebsites();
    setStatus(`Webseite „${item.name}“ gespeichert.`);
  } catch (error) { setStatus(`Webseite konnte nicht gespeichert werden: ${error.message}`); }
}

async function saveCurrentWebsite() {
  const raw = normalizeBrowseUrl($('#browseUrl').value);
  if (!raw) return setStatus('Bitte zuerst eine Katalog-URL eingeben.');
  let inferred = '';
  try {
    const u = new URL(raw);
    inferred = lastCatalogResult?.siteName || lastCatalogResult?.title || humanizeDomain(u.hostname);
  } catch {}
  try {
    const item = await window.manhwaAPI.addWebsite({ name: inferred, url: raw });
    await refreshWebsites();
    $('#sourceSelect').value = `site:${item.id}`;
    setStatus(`„${item.name}“ wurde als Webseite gespeichert.`);
  } catch (error) { setStatus(`Webseite konnte nicht gespeichert werden: ${error.message}`); }
}


function readingKey(value) { return normalizeBrowseUrl(value || '').replace(/\/$/, ''); }
function readingEntryFor(value) {
  const key = readingKey(value);
  return readingListItems.find((item) => readingKey(item.seriesUrl) === key) || null;
}
function catalogListAllowed(item) {
  const entry = readingEntryFor(item?.url);
  if ($('#favoritesOnly')?.checked && !entry?.favorite) return false;
  if ($('#readingOnly')?.checked && !entry?.reading) return false;
  return true;
}
async function refreshReadingList() {
  try {
    readingListItems = await window.manhwaAPI.listReadingList('all');
    if (selectedCatalog?.series?.url) selectedCatalog.readingList = readingEntryFor(selectedCatalog.series.url);
    renderCatalog();
    if (selectedCatalog?.series) renderCatalogChapters();
    return readingListItems;
  } catch (error) {
    setStatus(`Favoriten/Leseliste konnten nicht geladen werden: ${error.message}`);
    return [];
  }
}
async function toggleSelectedReadingList(field) {
  if (!selectedCatalog?.series) return;
  const series = selectedCatalog.series;
  const current = readingEntryFor(series.url) || {};
  const nextValue = !Boolean(current[field]);
  const catalogHit = catalogItems.find((entry) => sameUrl(entry.url, series.url));
  await window.manhwaAPI.setReadingListEntry({
    seriesUrl: series.url,
    title: series.title,
    cover: catalogHit?.cover || current.cover || null,
    status: normalizeSeriesStatus(series.status),
    language: series.language || current.language || null,
    favorite: field === 'favorite' ? nextValue : Boolean(current.favorite),
    reading: field === 'reading' ? nextValue : Boolean(current.reading)
  });
  await refreshReadingList();
  const label = field === 'favorite' ? 'Favorit' : 'Leseliste';
  setStatus(nextValue ? `„${series.title}“ wurde zu ${label === 'Favorit' ? 'den Favoriten' : 'der Leseliste'} hinzugefügt.` : `„${series.title}“ wurde aus ${label === 'Favorit' ? 'den Favoriten' : 'der Leseliste'} entfernt.`);
}

async function refreshNewsButton() {
  try {
    newsSummaryState = await window.manhwaAPI.getNewsSummary();
    const button = $('#newsToggleBtn');
    if (button) button.textContent = newsSummaryState?.unread ? `Neuheiten (${newsSummaryState.unread})` : 'Neuheiten';
  } catch {}
}
function renderNewsPanel() {
  const box = $('#newsList');
  if (!box) return;
  box.innerHTML = '';
  const summary = newsSummaryState || {};
  const when = summary.latestScanAt ? new Date(summary.latestScanAt).toLocaleString() : 'noch nie';
  $('#newsLastScan').textContent = summary.latestScanAt ? `Scan: ${when}` : 'kein Scan';
  $('#newsSummary').textContent = summary.latestScanAt
    ? `${summary.checkedSeries || 0} Serien geprüft · ${summary.updatedSeries || newsItems.length || 0} mit Updates · ${summary.newChapters || 0} neue Kapitel · ${summary.downloadedChapters || 0} geladen${summary.errors ? ` · ${summary.errors} Fehler` : ''}`
    : 'Noch kein Update-Scan durchgeführt.';
  if (!newsItems.length) {
    box.innerHTML = '<div class="empty compact">Beim letzten Scan wurden keine neuen Kapitel gefunden.</div>';
    return;
  }
  for (const item of newsItems) {
    const row = document.createElement('div'); row.className = `news-row${item.errors?.length ? ' warning' : ''}`;
    const copy = document.createElement('div'); copy.className = 'news-copy';
    const title = document.createElement('strong'); title.textContent = item.title || item.seriesUrl || 'Serie';
    const meta = document.createElement('small'); meta.textContent = `+${item.newChapters || 0} neue Kapitel · ${item.downloaded || 0} heruntergeladen${item.errors?.length ? ` · ${item.errors.length} Fehler` : ''}`;
    copy.append(title, meta);
    const badge = document.createElement('span'); badge.className = 'news-badge'; badge.textContent = `+${item.newChapters || 0}`;
    const open = document.createElement('button'); open.className = 'secondary'; open.textContent = 'Öffnen';
    open.addEventListener('click', async () => {
      showPanel('#newsPanel', false);
      $('#browsePanel').scrollIntoView({ behavior: 'smooth', block: 'start' });
      await openCatalogSeries({ title: item.title, url: item.seriesUrl });
    });
    row.append(copy, badge, open); box.appendChild(row);
  }
}
async function refreshNews({ markSeen = false } = {}) {
  try {
    const result = await window.manhwaAPI.listNews({ latestOnly: true, limit: 300 });
    newsItems = result.items || [];
    newsSummaryState = result.summary || null;
    renderNewsPanel();
    if (markSeen && newsSummaryState?.unread) {
      newsSummaryState = await window.manhwaAPI.markNewsSeen({ latestOnly: true });
      renderNewsPanel();
    }
    await refreshNewsButton();
  } catch (error) { setStatus(`Neuheiten konnten nicht geladen werden: ${error.message}`); }
}

function currentFilteredCatalogItems() {
  const needle = $('#browseSearch')?.value.trim().toLowerCase() || '';
  return catalogItems
    .filter(catalogStatusAllowed)
    .filter(catalogListAllowed)
    .filter((item) => !needle || String(item.title || '').toLowerCase().includes(needle) || String(item.url || '').toLowerCase().includes(needle));
}

function updateSiteDownloadControls() {
  const button = $('#downloadSiteBtn');
  if (button) button.disabled = siteDownloadRunning || !catalogItems.length || !normalizeBrowseUrl($('#browseUrl')?.value || '');
  const filteredButton = $('#downloadFilteredBtn');
  if (filteredButton) {
    const needle = $('#browseSearch')?.value.trim() || '';
    const count = needle ? currentFilteredCatalogItems().length : 0;
    filteredButton.disabled = siteDownloadRunning || !needle || !count;
    filteredButton.textContent = needle ? `Treffer herunterladen (${count})` : 'Treffer herunterladen';
  }
  const pause = $('#sitePauseBtn');
  const cancel = $('#siteCancelBtn');
  if (pause) { pause.disabled = !siteDownloadRunning; pause.textContent = siteDownloadPaused ? 'Fortsetzen' : 'Pause'; }
  if (cancel) cancel.disabled = !siteDownloadRunning;
}

async function startFullSiteDownload() {
  const url = normalizeBrowseUrl($('#browseUrl').value);
  if (!url) return setStatus('Bitte zuerst eine gespeicherte Quelle oder Katalog-URL auswählen.');
  if (siteDownloadRunning) return setStatus('Der komplette Katalog-Download läuft bereits.');
  if (!catalogItems.length) {
    await loadCatalog(false);
    if (!catalogItems.length) return setStatus('Es wurde keine Serienliste gefunden.');
  }
  const eligibleItems = catalogItems.filter(catalogStatusAllowed);
  const count = eligibleItems.length;
  if (!count) return setStatus('Keine Serie entspricht dem aktuellen Statusfilter.');
  const hiddenCount = catalogItems.length - count;
  const ok = confirm(`Komplette Quelle herunterladen?\n\n${count} Serien entsprechen dem aktuellen Statusfilter.${hiddenCount ? ` ${hiddenCount} Serie(n) werden wegen ihres Status übersprungen.` : ''} Alle noch fehlenden Kapitel werden nacheinander als CBZ gespeichert; vorhandene Downloads werden übersprungen.\n\nDas kann sehr lange dauern und viel Speicherplatz belegen. Bitte nur für Inhalte verwenden, die du automatisiert herunterladen darfst.`);
  if (!ok) return;
  siteDownloadRunning = true;
  siteDownloadPaused = false;
  updateSiteDownloadControls();
  const panel = $('#siteDownloadPanel');
  panel.classList.remove('hidden', 'paused', 'error');
  const title = $('#siteDownloadTitle');
  if (title) title.textContent = 'Komplette Quelle herunterladen';
  $('#siteDownloadProgress').textContent = `${count} Serien werden vorbereitet …`;
  $('#siteDownloadMeta').textContent = 'Vorhandene CBZs werden übersprungen. Downloads laufen seriell, damit die Quelle nicht unnötig belastet wird.';
  setStatus(`Kompletter Katalog-Download gestartet: ${count} Serien.`);
  try {
    const result = await window.manhwaAPI.startSiteDownload({
      url,
      items: eligibleItems.map((item) => ({ title: item.title, url: item.url, cover: item.cover || null, status: normalizeSeriesStatus(item.status) }))
    });
    if (result?.skipped) {
      $('#siteDownloadProgress').textContent = 'Ein kompletter Katalog-Download läuft bereits.';
      return;
    }
    const suffix = result.canceled ? ' · abgebrochen' : '';
    $('#siteDownloadProgress').textContent = `${result.checkedSeries || 0}/${result.totalSeries || 0} Serien geprüft · ${result.downloadedChapters || 0} Kapitel neu geladen · ${result.alreadyDownloaded || 0} bereits vorhanden${suffix}`;
    $('#siteDownloadMeta').textContent = result.errors ? `${result.errors} Fehler. Erfolgreiche CBZs bleiben erhalten; Details stehen im Debug-Log.` : 'Fertig. Alle erreichbaren Serien wurden verarbeitet.';
    panel.classList.toggle('error', Boolean(result.errors));
    await refreshDownloads();
    if (selectedCatalog?.series?.url) await openCatalogSeries({ title: selectedCatalog.series.title, url: selectedCatalog.series.url });
    setStatus(result.canceled ? 'Kompletter Katalog-Download wurde abgebrochen.' : `Katalog-Download fertig: ${result.downloadedChapters || 0} neue Kapitel.`);
  } catch (error) {
    panel.classList.add('error');
    $('#siteDownloadProgress').textContent = `Fehler: ${error.message}`;
    $('#siteDownloadMeta').textContent = 'Bereits vollständig geschriebene CBZ-Dateien bleiben erhalten.';
    setStatus(`Kompletter Katalog-Download fehlgeschlagen: ${error.message}`);
  } finally {
    siteDownloadRunning = false;
    siteDownloadPaused = false;
    updateSiteDownloadControls();
  }
}

async function startFilteredCatalogDownload() {
  const url = normalizeBrowseUrl($('#browseUrl').value);
  const query = $('#browseSearch')?.value.trim() || '';
  if (!url) return setStatus('Bitte zuerst eine gespeicherte Quelle oder Katalog-URL auswählen.');
  if (!query) return setStatus('Bitte zuerst einen Suchbegriff eingeben.');
  if (siteDownloadRunning) return setStatus('Ein Serien-Batch-Download läuft bereits.');
  if (!catalogItems.length) {
    await loadCatalog(false);
    if (!catalogItems.length) return setStatus('Es wurde keine Serienliste gefunden.');
  }
  const items = currentFilteredCatalogItems();
  if (!items.length) return setStatus(`Keine sichtbaren Serien für „${query}“ gefunden.`);
  const ok = confirm(`Alle aktuellen Suchtreffer herunterladen?\n\nSuchbegriff: ${query}\nTreffer: ${items.length}\n\nEs werden genau die derzeit durch Suche + Statusfilter sichtbaren Serien verarbeitet. Sprachfilter gelten zusätzlich beim Download. Vorhandene CBZs werden übersprungen.\n\nBitte nur für Inhalte verwenden, die du automatisiert herunterladen darfst.`);
  if (!ok) return;
  siteDownloadRunning = true;
  siteDownloadPaused = false;
  updateSiteDownloadControls();
  const panel = $('#siteDownloadPanel');
  panel.classList.remove('hidden', 'paused', 'error');
  const title = $('#siteDownloadTitle');
  if (title) title.textContent = `Suchtreffer herunterladen: „${query}“`;
  $('#siteDownloadProgress').textContent = `${items.length} Suchtreffer werden vorbereitet …`;
  $('#siteDownloadMeta').textContent = 'Nur die aktuell sichtbaren Suchtreffer werden verarbeitet. Vorhandene CBZs werden übersprungen.';
  setStatus(`Download für ${items.length} Suchtreffer gestartet.`);
  try {
    const result = await window.manhwaAPI.startSiteDownload({
      url,
      items: items.map((item) => ({ title: item.title, url: item.url, cover: item.cover || null, status: normalizeSeriesStatus(item.status) }))
    });
    if (result?.skipped) {
      $('#siteDownloadProgress').textContent = 'Ein Serien-Batch-Download läuft bereits.';
      return;
    }
    const suffix = result.canceled ? ' · abgebrochen' : '';
    $('#siteDownloadProgress').textContent = `${result.checkedSeries || 0}/${result.totalSeries || 0} Treffer geprüft · ${result.downloadedChapters || 0} Kapitel neu geladen · ${result.alreadyDownloaded || 0} bereits vorhanden${suffix}`;
    $('#siteDownloadMeta').textContent = result.errors ? `${result.errors} Fehler. Erfolgreiche CBZs bleiben erhalten; Details stehen im Debug-Log.` : 'Fertig. Alle ausgewählten Suchtreffer wurden verarbeitet.';
    panel.classList.toggle('error', Boolean(result.errors));
    await refreshDownloads();
    if (selectedCatalog?.series?.url) await openCatalogSeries({ title: selectedCatalog.series.title, url: selectedCatalog.series.url });
    setStatus(result.canceled ? 'Suchtreffer-Download wurde abgebrochen.' : `Suchtreffer-Download fertig: ${result.downloadedChapters || 0} neue Kapitel.`);
  } catch (error) {
    panel.classList.add('error');
    $('#siteDownloadProgress').textContent = `Fehler: ${error.message}`;
    $('#siteDownloadMeta').textContent = 'Bereits vollständig geschriebene CBZ-Dateien bleiben erhalten.';
    setStatus(`Suchtreffer-Download fehlgeschlagen: ${error.message}`);
  } finally {
    siteDownloadRunning = false;
    siteDownloadPaused = false;
    updateSiteDownloadControls();
  }
}

async function toggleSiteDownloadPause() {
  if (!siteDownloadRunning) return;
  try {
    if (siteDownloadPaused) {
      await window.manhwaAPI.resumeSiteDownload();
      siteDownloadPaused = false;
      $('#siteDownloadPanel').classList.remove('paused');
      setStatus('Kompletter Katalog-Download wird fortgesetzt.');
    } else {
      await window.manhwaAPI.pauseSiteDownload();
      siteDownloadPaused = true;
      $('#siteDownloadPanel').classList.add('paused');
      setStatus('Katalog-Download pausiert. Der aktuell laufende Bildabruf darf noch fertig werden.');
    }
    updateSiteDownloadControls();
  } catch (error) { setStatus(`Pause/Fortsetzen fehlgeschlagen: ${error.message}`); }
}

async function cancelSiteDownload() {
  if (!siteDownloadRunning) return;
  if (!confirm('Kompletten Katalog-Download abbrechen? Das aktuell laufende Kapitel wird eventuell noch fertiggestellt.')) return;
  try {
    await window.manhwaAPI.cancelSiteDownload();
    $('#siteDownloadProgress').textContent = 'Abbruch angefordert …';
    setStatus('Abbruch angefordert.');
  } catch (error) { setStatus(`Abbrechen fehlgeschlagen: ${error.message}`); }
}

function renderCatalog(items = catalogItems) {
  const container = $('#browseResults');
  const needle = $('#browseSearch')?.value.trim().toLowerCase() || '';
  const statusFiltered = items.filter(catalogStatusAllowed).filter(catalogListAllowed);
  const filtered = items === catalogItems
    ? currentFilteredCatalogItems()
    : statusFiltered.filter((item) => !needle || String(item.title || '').toLowerCase().includes(needle) || String(item.url || '').toLowerCase().includes(needle));
  $('#catalogCount').textContent = (needle || statusFiltered.length !== items.length) ? `${filtered.length}/${items.length}` : String(items.length);
  const statusMeta = $('#statusFilterMeta');
  if (statusMeta) {
    const unknown = items.filter((item) => normalizeSeriesStatus(item.status) === 'unknown').length;
    const visibleText = statusFiltered.length === items.length ? `${items.length} sichtbar` : `${statusFiltered.length}/${items.length} sichtbar`;
    statusMeta.textContent = `${visibleText}${unknown ? ` · ${unknown} unbekannt` : ''}`;
  }
  updateStatusScanButton();
  updateSiteDownloadControls();
  container.innerHTML = '';
  if (!filtered.length) {
    container.innerHTML = `<div class="empty compact">${catalogItems.length ? 'Keine Treffer für diesen Filter.' : 'Noch keine Serien gefunden. Links eine Quelle anklicken oder eine Katalog-URL laden.'}</div>`;
    return;
  }
  for (const item of filtered) {
    const card = document.createElement('button');
    card.className = `title-row${selectedCatalog?.series?.url === item.url ? ' active' : ''}`;
    if (item.cover) {
      const img = document.createElement('img'); img.className = 'title-cover'; img.src = item.cover; img.alt = ''; img.loading = 'lazy';
      img.addEventListener('error', () => img.remove());
      card.appendChild(img);
    }
    const copy = document.createElement('span'); copy.className = 'title-row-copy';
    const titleLine = document.createElement('span'); titleLine.className = 'title-row-titleline';
    const title = document.createElement('strong'); title.textContent = item.title;
    const normalizedStatus = normalizeSeriesStatus(item.status);
    const badge = document.createElement('span'); badge.className = `series-status-badge status-${normalizedStatus}`; badge.textContent = seriesStatusName(normalizedStatus);
    titleLine.append(title, badge);
    const listEntry = readingEntryFor(item.url);
    if (listEntry?.favorite) { const fav = document.createElement('span'); fav.className = 'reading-badge favorite'; fav.textContent = '★'; fav.title = 'Favorit'; titleLine.append(fav); }
    if (listEntry?.reading) { const read = document.createElement('span'); read.className = 'reading-badge reading'; read.textContent = '📖'; read.title = 'Leseliste'; titleLine.append(read); }
    const meta = document.createElement('small'); meta.textContent = item.reason || new URL(item.url).pathname;
    copy.append(titleLine, meta); card.append(copy);
    card.addEventListener('click', () => openCatalogSeries(item));
    container.appendChild(card);
  }
}

function updateDownloadButtons() {
  const hasSeries = Boolean(selectedCatalog?.series);
  const total = selectedCatalog?.series?.chapters?.length || 0;
  $('#chapterSelectAllBtn').disabled = !hasSeries || !total;
  $('#chapterSelectNoneBtn').disabled = !hasSeries || !selectedChapterIds.size;
  $('#downloadSelectedBtn').disabled = !hasSeries || !selectedChapterIds.size;
  $('#downloadAllBtn').disabled = !hasSeries || !total;
  if (hasSeries) $('#downloadSelectedBtn').textContent = selectedChapterIds.size ? `Ausgewählte herunterladen (${selectedChapterIds.size})` : 'Ausgewählte herunterladen';
}

function renderCatalogChapters() {
  const container = $('#catalogChapters');
  container.innerHTML = '';
  if (!selectedCatalog?.series) {
    $('#selectedSeriesTitle').textContent = 'Kapitel';
    $('#selectedSeriesMeta').textContent = 'Wähle zuerst eine Serie aus der mittleren Liste.';
    $('#selectedChapterCount').textContent = '0';
    $('#favoriteSelectedBtn').disabled = true; $('#readingSelectedBtn').disabled = true; $('#watchSelectedBtn').disabled = true; $('#syncSelectedBtn').disabled = true; $('#labSelectedBtn').disabled = true;
    updateDownloadButtons();
    container.innerHTML = '<div class="empty compact">Kapitel erscheinen hier.</div>';
    return;
  }
  const series = selectedCatalog.series;
  const needle = $('#chapterSearch')?.value.trim().toLowerCase() || '';
  const all = [...(series.chapters || [])].reverse();
  const hideDownloaded = Boolean($('#hideDownloaded')?.checked);
  const chapters = all.filter((chapter) => {
    const downloaded = Boolean(chapter.downloaded) || catalogDownloadedIds.has(String(chapter.id));
    const matches = !needle || String(chapter.title || '').toLowerCase().includes(needle) || String(chapter.number ?? '').includes(needle);
    return matches && (!hideDownloaded || !downloaded);
  });
  $('#selectedSeriesTitle').textContent = series.title;
  $('#selectedSeriesMeta').textContent = `${seriesStatusName(series.status)} · ${selectedCatalog.connector?.label || shortConnector(series.connectorId)} · ${series.language ? languageName(series.language) + ' · ' : ''}${series.url}`;
  $('#selectedChapterCount').textContent = `${chapters.length}/${all.length}`;
  $('#favoriteSelectedBtn').disabled = false; $('#readingSelectedBtn').disabled = false; $('#watchSelectedBtn').disabled = false; $('#syncSelectedBtn').disabled = false; $('#labSelectedBtn').disabled = false;
  const listEntry = readingEntryFor(series.url);
  $('#favoriteSelectedBtn').textContent = listEntry?.favorite ? '★ Favorit' : '☆ Favorit';
  $('#favoriteSelectedBtn').classList.toggle('list-active', Boolean(listEntry?.favorite));
  $('#readingSelectedBtn').textContent = listEntry?.reading ? '📖 ✓ Leseliste' : '📖 Leseliste';
  $('#readingSelectedBtn').classList.toggle('list-active', Boolean(listEntry?.reading));
  $('#watchSelectedBtn').textContent = selectedCatalog.watched ? '✓ Beobachtet' : 'Beobachten';
  $('#syncSelectedBtn').textContent = selectedCatalog.syncEnabled ? '📱 ✓ Sync' : '📱 Sync';
  $('#syncSelectedBtn').classList.toggle('sync-active', Boolean(selectedCatalog.syncEnabled));
  if (!chapters.length) container.innerHTML = '<div class="empty compact">Keine Kapitel für diesen Filter.</div>';

  for (const chapter of chapters) {
    const id = String(chapter.id);
    const row = document.createElement('div'); row.className = 'catalog-chapter-row';
    const check = document.createElement('input'); check.type = 'checkbox'; check.checked = selectedChapterIds.has(id); check.dataset.chapterId = id;
    check.addEventListener('change', () => {
      if (check.checked) selectedChapterIds.add(id); else selectedChapterIds.delete(id);
      updateDownloadButtons();
    });
    const copy = document.createElement('div'); copy.className = 'catalog-chapter-copy';
    const title = document.createElement('strong');
    title.textContent = chapter.title || `Chapter ${id}`;
    const state = document.createElement('small');
    const downloaded = Boolean(chapter.downloaded) || catalogDownloadedIds.has(id);
    if (downloaded) row.classList.add('downloaded');
    const activity = downloadActivity.get(id);
    if (activity?.type === 'error') { state.textContent = `Fehler: ${activity.message}`; state.className = 'error'; }
    else if (activity?.text) { state.textContent = activity.text; state.className = 'working'; }
    else { state.textContent = downloaded ? `✓ heruntergeladen${chapter.downloadFile ? ' · CBZ' : chapter.downloadFolder ? ' · Ordner' : ''}` : (chapter.url || 'bereit'); if (downloaded) state.className = 'done'; }
    if (downloaded) {
      const badge = document.createElement('span');
      badge.className = 'downloaded-badge';
      badge.textContent = chapter.downloadFormat === 'folder' ? '✓ ORDNER' : '✓ CBZ';
      title.append(' ', badge);
    }
    copy.append(title, state);
    const actions = document.createElement('div'); actions.className = 'catalog-chapter-actions';
    if (downloaded && chapter.downloadFile) {
      const show = document.createElement('button'); show.className = 'secondary'; show.textContent = 'CBZ';
      show.addEventListener('click', async () => { try { await window.manhwaAPI.showDownloadedFile(chapter.downloadFile); } catch (error) { setStatus(`CBZ konnte nicht angezeigt werden: ${error.message}`); } });
      actions.appendChild(show);
    } else if (downloaded && chapter.downloadFolder) {
      const open = document.createElement('button'); open.className = 'secondary'; open.textContent = 'Ordner';
      open.addEventListener('click', async () => { try { await window.manhwaAPI.openDownloadedFolder(chapter.downloadFolder); } catch (error) { setStatus(`Ordner konnte nicht geöffnet werden: ${error.message}`); } });
      actions.appendChild(open);
    }
    const button = document.createElement('button'); button.className = downloaded ? 'secondary' : ''; button.textContent = downloaded ? 'Erneut' : 'Download'; button.disabled = Boolean(activity?.text && activity.type !== 'error');
    button.addEventListener('click', async () => { await downloadCatalogChapters([id]); });
    actions.appendChild(button);
    row.append(check, copy, actions); container.appendChild(row);
  }
  updateDownloadButtons();
}

async function openCatalogSeries(item) {
  $('#catalogChapterState').textContent = `„${item.title}“ wird geladen …`;
  $('#catalogChapters').innerHTML = '<div class="empty compact">Kapitelliste wird geladen – vorhandener Connector oder automatische Erkennung …</div>';
  selectedChapterIds.clear(); catalogDownloadedIds.clear(); updateDownloadButtons();
  try {
    const result = await window.manhwaAPI.catalogOpenSeries(item.url);
    selectedCatalog = result;
    selectedCatalog.readingList = readingEntryFor(result.series?.url || item.url);
    const openedStatus = normalizeSeriesStatus(result.series?.status);
    if (openedStatus !== 'unknown') {
      const match = catalogItems.find((entry) => sameUrl(entry.url, result.series?.url || item.url));
      if (match) { match.status = openedStatus; match.statusSource = 'series-open'; }
    }
    for (const chapter of result.series?.chapters || []) if (chapter.downloaded) catalogDownloadedIds.add(String(chapter.id));
    const downloadedCount = Number(result.downloadedCount ?? (result.series.chapters || []).filter((chapter) => chapter.downloaded).length);
    const diskNote = result.diskDetected ? ` · ${result.diskDetected} CBZ/Ordner auf Festplatte erkannt` : '';
    $('#catalogChapterState').textContent = `${result.series.chapters?.length || 0} Kapitel · ${downloadedCount} heruntergeladen${diskNote}${result.watched ? ' · Serie wird beobachtet' : ''}.`;
    renderCatalog(); renderCatalogChapters();
    setStatus(`„${result.series.title}“ geöffnet. ${result.series.autoDetected ? 'Kapitel automatisch erkannt. ' : ''}Kapitel können direkt ausgewählt werden.`);
  } catch (error) {
    selectedCatalog = null;
    $('#catalogChapterState').textContent = `Fehler: ${error.message}`;
    $('#catalogChapters').innerHTML = '<div class="empty compact">Die automatische Erkennung konnte diese Serie nicht sicher auslesen. Im Connector-Labor kann dafür optional ein genauer Recipe-Connector erstellt werden.</div>';
    renderCatalogChapters();
    setStatus(`Serie konnte nicht geöffnet werden: ${error.message}`);
  }
}

async function loadCatalog(force = false) {
  const url = normalizeBrowseUrl($('#browseUrl').value);
  if (!url) return setStatus('Bitte zuerst links eine Quelle auswählen oder eine Katalog-URL eingeben.');
  if (catalogLoading) return;
  const state = $('#browseState');
  const loadBtn = $('#browseLoadBtn');
  try {
    catalogLoading = true;
    loadBtn.disabled = true;
    state.textContent = 'Katalog …'; state.className = 'pill';
    $('#browseMeta').textContent = 'Vollständiger Katalog wird gesucht: Browse-Seite, Infinite Scroll und Pagination werden geprüft …';
    const result = await window.manhwaAPI.catalogDiscover({ url, force });
    lastCatalogResult = result;
    catalogItems = Array.isArray(result.items) ? result.items : [];
    selectedCatalog = null; selectedChapterIds.clear(); catalogDownloadedIds.clear();
    state.textContent = `${catalogItems.length} Serien`; state.className = catalogItems.length ? 'pill ok' : 'pill bad';
    const parts = [];
    if (result.pageTitle || result.hostname) parts.push(result.pageTitle || result.hostname);
    if (result.declaredTotal && result.declaredTotal > catalogItems.length) parts.push(`${result.declaredTotal} laut Katalog`);
    if (result.pagesScanned) parts.push(`${result.pagesScanned} Seite${result.pagesScanned === 1 ? '' : 'n'}`);
    if (result.scannedLinks) parts.push(`${result.scannedLinks} Links analysiert`);
    if (result.loadMoreClicks) parts.push(`${result.loadMoreClicks}× „Load more“`);
    if (result.cached) parts.push('Cache');
    if (result.truncated) parts.push('Sicherheitslimit erreicht');
    $('#browseMeta').textContent = parts.join(' · ') || `${catalogItems.length} Serien geladen`;
    renderCatalog(); renderCatalogChapters(); updateSiteDownloadControls();
    setStatus(catalogItems.length ? `${catalogItems.length} Serien im vollständigen Katalog. Das Suchfeld filtert jetzt alle geladenen Titel.` : 'Keine eindeutigen Serienlinks gefunden. Probiere eine andere Katalog-/Browse-Seite der Quelle.');
  } catch (error) {
    state.textContent = 'Fehler'; state.className = 'pill bad';
    $('#browseMeta').textContent = error.message;
    catalogItems = []; updateSiteDownloadControls();
    setStatus(`Serienliste konnte nicht geladen werden: ${error.message}`);
  } finally {
    catalogLoading = false;
    loadBtn.disabled = false;
  }
}

async function downloadCatalogChapters(ids) {
  if (!selectedCatalog?.series) return;
  const unique = [...new Set((ids || []).map(String))];
  if (!unique.length) return setStatus('Bitte mindestens ein Kapitel auswählen.');
  if (unique.length > 50 && !confirm(`${unique.length} Kapitel herunterladen? Das kann eine Weile dauern.`)) return;
  const state = $('#catalogChapterState');
  for (const id of unique) downloadActivity.set(id, { type: 'queued', text: 'Warteschlange …' });
  renderCatalogChapters();
  try {
    state.textContent = `Download gestartet: ${unique.length} Kapitel · Reader-Seiten werden ermittelt …`;
    $('#downloadSelectedBtn').disabled = true; $('#downloadAllBtn').disabled = true;
    const result = await window.manhwaAPI.catalogDownloadChapters({ url: selectedCatalog.series.url, chapterIds: unique });
    for (const item of result.results || []) {
      const id = String(item.id);
      catalogDownloadedIds.add(id);
      downloadActivity.delete(id);
      const chapter = (selectedCatalog.series.chapters || []).find((entry) => String(entry.id) === id);
      if (chapter) { chapter.downloaded = true; chapter.downloadFolder = item.folder || null; chapter.downloadFile = item.file || null; chapter.downloadFormat = item.format || null; chapter.downloadedAt = new Date().toISOString(); }
    }
    for (const item of result.errors || []) downloadActivity.set(String(item.id), { type: 'error', message: item.message });
    selectedChapterIds.clear();
    const ok = result.results?.length || 0;
    const bad = result.errors?.length || 0;
    state.textContent = bad ? `${ok} Kapitel heruntergeladen · ${bad} fehlgeschlagen. Fehler stehen direkt beim Kapitel.` : `${ok} Kapitel heruntergeladen.`;
    renderCatalogChapters(); await refreshDownloads(); await render();
    setStatus(bad ? `${result.title}: ${ok} fertig, ${bad} Fehler.` : `${result.title}: ${ok} Kapitel heruntergeladen.`);
  } catch (error) {
    for (const id of unique) downloadActivity.set(id, { type: 'error', message: error.message });
    state.textContent = `Downloadfehler: ${error.message}`;
    setStatus(`Downloadfehler: ${error.message}`);
    renderCatalogChapters(); updateDownloadButtons();
  }
}

async function refreshDownloads() {
  try {
    recentDownloads = await window.manhwaAPI.listDownloads(500);
    const downloadsButton = $('#downloadsToggleBtn');
    if (downloadsButton) downloadsButton.textContent = recentDownloads.length ? `Downloads (${recentDownloads.length})` : 'Downloads';
    const box = $('#downloadsList');
    if (!box) return;
    box.innerHTML = '';
    if (!recentDownloads.length) { box.innerHTML = '<div class="empty compact">Noch keine Downloads gespeichert.</div>'; return; }
    for (const item of recentDownloads) {
      const row = document.createElement('div'); row.className = 'download-history-row';
      const series = document.createElement('div'); series.innerHTML = '<strong></strong><small></small>'; series.querySelector('strong').textContent = item.seriesTitle || 'Serie'; series.querySelector('small').textContent = `${item.pageCount || 0} Seiten`;
      const chapter = document.createElement('div'); chapter.className = 'chapter-name'; chapter.innerHTML = '<strong></strong><small></small>'; chapter.querySelector('strong').textContent = item.chapterTitle || `Chapter ${item.chapterId}`; chapter.querySelector('small').textContent = item.file || item.folder || '';
      const when = document.createElement('div'); when.className = 'download-time'; when.textContent = item.downloadedAt ? new Date(item.downloadedAt).toLocaleString() : '';
      const open = document.createElement('button'); open.className = 'secondary'; open.textContent = item.file ? 'CBZ' : 'Ordner'; open.addEventListener('click', async () => { try { if (item.file) await window.manhwaAPI.showDownloadedFile(item.file); else await window.manhwaAPI.openDownloadedFolder(item.folder); } catch (error) { setStatus(`Download konnte nicht angezeigt werden: ${error.message}`); } });
      row.append(series, chapter, when, open); box.appendChild(row);
    }
  } catch (error) { setStatus(`Downloadverlauf konnte nicht geladen werden: ${error.message}`); }
}



function formatBytes(bytes) {
  const value = Math.max(0, Number(bytes) || 0);
  if (!value) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  const index = Math.min(units.length - 1, Math.floor(Math.log(value) / Math.log(1024)));
  const scaled = value / (1024 ** index);
  const digits = index >= 3 ? 2 : (index >= 2 ? 1 : 0);
  return `${scaled.toLocaleString('de-DE', { minimumFractionDigits: digits, maximumFractionDigits: digits })} ${units[index]}`;
}

function renderLibraryHealth(result) {
  libraryHealthResult = result || null;
  if (!result) return;
  const library = result.library || {};
  const disk = result.disk || {};
  const sync = result.sync || {};
  const deep = Boolean(result.deep);
  $('#librarySeriesStat').textContent = String(library.seriesCount || 0);
  $('#librarySeriesMeta').textContent = library.root || 'kein Downloadordner';
  $('#libraryCbzStat').textContent = Number(library.cbzCount || 0).toLocaleString('de-DE');
  $('#libraryCbzMeta').textContent = deep ? `${library.metadataMissing || 0} ohne ComicInfo.xml` : 'Kapitelarchive';
  $('#libraryBytesStat').textContent = formatBytes(library.bytes || 0);
  $('#libraryDiskPath').textContent = library.root || '–';
  $('#libraryFreeStat').textContent = disk.available ? formatBytes(disk.free || 0) : '–';
  $('#libraryDiskTotal').textContent = disk.available ? `${formatBytes(disk.total || 0)} gesamt` : 'Laufwerksdaten nicht verfügbar';
  $('#syncBytesStat').textContent = sync.root ? formatBytes(sync.bytes || 0) : '–';
  $('#syncStorageMeta').textContent = sync.root ? `${sync.cbzCount || 0} CBZ · ${sync.targetCount || 0} Sync-Serie(n)` : 'kein Sync-Ordner';
  const issueCount = Number(result.issueCount || 0);
  $('#libraryIssueStat').textContent = deep ? String(issueCount) : `${issueCount}${issueCount ? '+' : ''}`;
  $('#libraryIssueMeta').textContent = deep
    ? `${library.corruptCount || 0} beschädigt · ${library.missing?.length || 0} Serie(n) mit Lücken · ${library.partCount || 0} .part · ${library.metadataMissing || 0} ohne Metadaten`
    : `${library.partCount || 0} .part · ${library.missing?.length || 0} mögliche Lücken · CBZ-Integrität noch ungeprüft`;
  $('#libraryHealthSummary').textContent = `${library.seriesCount || 0} Serien · ${(library.cbzCount || 0).toLocaleString('de-DE')} CBZ · ${formatBytes(library.bytes || 0)}${deep ? ` · ${issueCount} Problem(e)` : ' · Schnellscan'}`;

  const issueCard = $('#libraryIssueStat')?.closest('.problem-card');
  issueCard?.classList.toggle('has-issues', issueCount > 0);
  const button = $('#libraryToggleBtn');
  if (button) button.textContent = library.bytes ? `Bibliothek (${formatBytes(library.bytes).replace(' ', '')})` : 'Bibliothek';

  const usageBar = $('#libraryDiskUsageBar');
  const usageText = $('#libraryDiskUsageText');
  if (disk.available && disk.total > 0) {
    const pct = Math.max(0, Math.min(100, ((disk.total - disk.free) / disk.total) * 100));
    if (usageBar) usageBar.style.width = `${pct.toFixed(1)}%`;
    if (usageText) usageText.textContent = `${formatBytes(disk.total - disk.free)} belegt / ${formatBytes(disk.total)} · ${formatBytes(disk.free)} frei`;
  } else {
    if (usageBar) usageBar.style.width = '0%';
    if (usageText) usageText.textContent = 'Laufwerksbelegung nicht verfügbar';
  }

  const largest = $('#largestSeriesList');
  if (largest) {
    largest.innerHTML = '';
    const rows = Array.isArray(result.largestSeries) ? result.largestSeries.slice(0, 20) : [];
    if (!rows.length) largest.innerHTML = '<div class="empty compact">Keine Serienordner gefunden.</div>';
    for (const item of rows) {
      const row = document.createElement('div'); row.className = 'library-series-row';
      const copy = document.createElement('div'); copy.className = 'library-row-copy';
      const title = document.createElement('strong'); title.textContent = item.title || 'Serie';
      const meta = document.createElement('small'); meta.textContent = `${formatBytes(item.bytes || 0)} · ${item.cbzCount || 0} CBZ${item.corruptCount ? ` · ${item.corruptCount} beschädigt` : ''}`;
      copy.append(title, meta);
      const actions = document.createElement('div'); actions.className = 'library-row-actions';
      const open = document.createElement('button'); open.className = 'secondary'; open.textContent = 'Ordner';
      open.addEventListener('click', async () => { try { await window.manhwaAPI.openLibraryPath(item.folder); } catch (error) { setStatus(`Ordner konnte nicht geöffnet werden: ${error.message}`); } });
      actions.append(open); row.append(copy, actions); largest.appendChild(row);
    }
  }

  const problems = $('#libraryProblemsList');
  if (problems) {
    problems.innerHTML = '';
    const rows = Array.isArray(library.problems) ? library.problems.slice(0, 500) : [];
    if (!rows.length) problems.innerHTML = `<div class="empty compact">${deep ? 'Keine Probleme gefunden.' : 'Keine offensichtlichen Probleme im Schnellscan. Für CBZ-Integrität „Bibliothek prüfen“ ausführen.'}</div>`;
    for (const item of rows) {
      const row = document.createElement('div'); row.className = `library-problem-row ${item.severity === 'error' ? 'error' : (item.severity === 'info' ? 'info' : 'warning')}`;
      const copy = document.createElement('div'); copy.className = 'library-row-copy';
      const title = document.createElement('strong');
      const badge = document.createElement('span'); badge.className = 'library-problem-badge';
      badge.textContent = item.type === 'corrupt' ? 'CBZ' : (item.type === 'partial' ? 'PART' : (item.type === 'metadata' ? 'META' : 'LÜCKE'));
      const titleText = document.createTextNode(item.seriesTitle || 'Bibliothek');
      title.append(badge, titleText);
      const meta = document.createElement('small'); meta.textContent = item.message || 'Problem erkannt.';
      copy.append(title, meta);
      const actions = document.createElement('div'); actions.className = 'library-row-actions';
      const target = item.file || item.folder;
      if (target) {
        const open = document.createElement('button'); open.className = 'secondary'; open.textContent = item.file ? 'Anzeigen' : 'Ordner';
        open.addEventListener('click', async () => { try { await window.manhwaAPI.openLibraryPath(target); } catch (error) { setStatus(`Pfad konnte nicht geöffnet werden: ${error.message}`); } });
        actions.append(open);
      }
      if (item.type === 'corrupt' && item.file) {
        const retry = document.createElement('button'); retry.className = 'secondary'; retry.textContent = 'Neu laden';
        retry.addEventListener('click', async () => {
          try {
            retry.disabled = true; retry.textContent = 'Queue …';
            const queued = await window.manhwaAPI.retryLibraryFile(item.file);
            setStatus(`${queued.seriesTitle} – ${queued.chapterTitle} wurde zur Reparatur in die Download-Queue gestellt.`);
            await refreshQueue();
          } catch (error) {
            retry.disabled = false; retry.textContent = 'Neu laden';
            setStatus(`Reparaturdownload nicht möglich: ${error.message}`);
          }
        });
        actions.append(retry);
      }
      row.append(copy, actions); problems.appendChild(row);
    }
  }
}

async function runLibraryHealthScan(deep = false) {
  if (libraryScanRunning) return;
  libraryScanRunning = true;
  const quick = $('#refreshLibraryStatsBtn');
  const deepBtn = $('#deepLibraryScanBtn');
  const repairBtn = $('#repairLibraryBtn');
  const progress = $('#libraryScanProgress');
  if (quick) quick.disabled = true;
  if (deepBtn) deepBtn.disabled = true;
  if (repairBtn) repairBtn.disabled = true;
  if (progress) { progress.className = 'update-progress working'; progress.textContent = deep ? 'Tiefe Bibliotheksprüfung wird gestartet …' : 'Speicher wird analysiert …'; }
  try {
    const result = await window.manhwaAPI.scanLibraryHealth({ deep });
    renderLibraryHealth(result);
    if (progress) {
      progress.className = result.issueCount ? 'update-progress error' : 'update-progress done';
      progress.textContent = deep
        ? `Prüfung fertig: ${result.library?.cbzCount || 0} CBZ · ${result.issueCount || 0} Problem(e) · ${formatBytes(result.library?.bytes || 0)}`
        : `Speicher aktualisiert: ${result.library?.seriesCount || 0} Serien · ${result.library?.cbzCount || 0} CBZ · ${formatBytes(result.library?.bytes || 0)}`;
    }
    setStatus(deep ? `Bibliotheksprüfung abgeschlossen: ${result.issueCount || 0} Problem(e) gefunden.` : `Speicherübersicht aktualisiert: ${formatBytes(result.library?.bytes || 0)} Bibliothek.`);
  } catch (error) {
    if (progress) { progress.className = 'update-progress error'; progress.textContent = `Prüfung fehlgeschlagen: ${error.message}`; }
    setStatus(`Bibliotheksprüfung fehlgeschlagen: ${error.message}`);
  } finally {
    libraryScanRunning = false;
    if (quick) quick.disabled = false;
    if (deepBtn) deepBtn.disabled = false;
    if (repairBtn) repairBtn.disabled = libraryRepairRunning;
  }
}

async function repairLibraryProblems() {
  if (libraryRepairRunning || libraryScanRunning) return;
  if (!libraryHealthResult?.deep) await runLibraryHealthScan(true);
  const problems = Array.isArray(libraryHealthResult?.library?.problems) ? libraryHealthResult.library.problems : [];
  if (!problems.length) { setStatus('Keine reparierbaren Bibliotheksprobleme gefunden.'); return; }
  const counts = problems.reduce((acc, item) => { acc[item.type] = (acc[item.type] || 0) + 1; return acc; }, {});
  const details = [
    counts.corrupt ? `${counts.corrupt} beschädigte CBZ` : '',
    counts.partial ? `${counts.partial} .part-Datei(en)` : '',
    counts.metadata ? `${counts.metadata}× ComicInfo.xml fehlt` : '',
    counts.missing ? `${counts.missing} Serie(n) mit Chapter-Lücken` : ''
  ].filter(Boolean).join('\n');
  if (!window.confirm(`Manhwa Watcher hat ${problems.length} Problem(e) erkannt.\n\n${details}\n\nSicher erkennbare Probleme jetzt automatisch beheben?`)) return;
  libraryRepairRunning = true;
  const repair = $('#repairLibraryBtn');
  const quick = $('#refreshLibraryStatsBtn');
  const deepBtn = $('#deepLibraryScanBtn');
  const progress = $('#libraryScanProgress');
  const summaryBox = $('#libraryRepairSummary');
  if (repair) { repair.disabled = true; repair.textContent = 'Repariert …'; }
  if (quick) quick.disabled = true;
  if (deepBtn) deepBtn.disabled = true;
  if (summaryBox) { summaryBox.className = 'repair-summary'; summaryBox.textContent = 'Automatische Reparatur läuft …'; }
  if (progress) { progress.className = 'update-progress working'; progress.textContent = 'Automatische Reparatur wird gestartet …'; }
  try {
    const result = await window.manhwaAPI.repairLibraryProblems();
    const failedRows = (result.results || []).filter((item) => !item.ok).slice(0, 8);
    const lines = [
      `✓ ${result.fixed || 0} Problem(e) behoben`,
      result.skipped ? `↷ ${result.skipped} übersprungen` : '',
      result.failed ? `✗ ${result.failed} nicht automatisch lösbar` : '',
      result.connectorFallbacks ? `↻ ${result.connectorFallbacks} Connector-Domain(s) automatisch auf Auto-Erkennung umgestellt` : '',
      ...failedRows.map((item) => `• ${item.title || item.type}: ${item.message || 'nicht reparierbar'}`)
    ].filter(Boolean);
    if (summaryBox) { summaryBox.className = result.failed ? 'repair-summary error' : 'repair-summary done'; summaryBox.textContent = lines.join('\n'); }
    setStatus(`Autoreparatur abgeschlossen: ${result.fixed || 0} behoben, ${result.failed || 0} offen.`);
    await refreshDownloads(); await refreshQueue();
    libraryHealthResult = null;
  } catch (error) {
    if (summaryBox) { summaryBox.className = 'repair-summary error'; summaryBox.textContent = `Autoreparatur fehlgeschlagen: ${error.message}`; }
    setStatus(`Autoreparatur fehlgeschlagen: ${error.message}`);
  } finally {
    libraryRepairRunning = false;
    if (repair) { repair.disabled = false; repair.textContent = 'Probleme beheben'; }
    if (quick) quick.disabled = false;
    if (deepBtn) deepBtn.disabled = false;
    await runLibraryHealthScan(true);
  }
}

function queueStatusLabel(status) {
  return { queued: 'Wartend', running: 'Lädt', done: 'Fertig', failed: 'Fehler' }[status] || String(status || 'Unbekannt');
}

function scheduleQueueRefresh() {
  if (queueRefreshTimer) return;
  queueRefreshTimer = setTimeout(async () => {
    queueRefreshTimer = null;
    await refreshQueue();
  }, 120);
}

async function refreshQueue() {
  try {
    queueItems = await window.manhwaAPI.listQueue(300);
    const button = $('#queueToggleBtn');
    const active = queueItems.filter((item) => item.status === 'queued' || item.status === 'running').length;
    const failed = queueItems.filter((item) => item.status === 'failed').length;
    if (button) button.textContent = active ? `Queue (${active})` : (failed ? `Queue (!${failed})` : 'Queue');
    const summary = $('#queueSummary');
    if (summary) {
      const done = queueItems.filter((item) => item.status === 'done').length;
      summary.textContent = `${active} aktiv/wartend · ${done} fertig · ${failed} fehlgeschlagen`;
      summary.className = failed ? 'update-progress error' : (active ? 'update-progress working' : 'update-progress done');
    }
    const box = $('#queueList');
    if (!box) return;
    box.innerHTML = '';
    if (!queueItems.length) { box.innerHTML = '<div class="empty compact">Noch keine Downloadjobs in dieser Sitzung.</div>'; return; }
    for (const item of queueItems) {
      const row = document.createElement('div'); row.className = `queue-row queue-${item.status || 'unknown'}`;
      const copy = document.createElement('div'); copy.className = 'queue-copy';
      const title = document.createElement('strong'); title.textContent = `${item.seriesTitle || 'Serie'} – ${item.chapterTitle || 'Kapitel'}`;
      const meta = document.createElement('small');
      const progress = item.total ? `${Math.min(item.current || 0, item.total)}/${item.total} Seiten` : 'wird vorbereitet';
      meta.textContent = item.status === 'failed' ? (item.error || 'Download fehlgeschlagen') : `${queueStatusLabel(item.status)} · ${progress}`;
      copy.append(title, meta);
      const badge = document.createElement('span'); badge.className = 'queue-badge'; badge.textContent = queueStatusLabel(item.status);
      row.append(copy, badge);
      if (item.status === 'failed') {
        const retry = document.createElement('button'); retry.className = 'secondary'; retry.textContent = 'Erneut';
        retry.addEventListener('click', async () => {
          try { retry.disabled = true; await window.manhwaAPI.retryQueueItem(item.id); await refreshQueue(); setStatus(`${item.chapterTitle} erneut in die Queue gestellt.`); }
          catch (error) { retry.disabled = false; setStatus(`Queue-Retry fehlgeschlagen: ${error.message}`); }
        });
        row.appendChild(retry);
      } else if (item.status === 'done' && item.file) {
        const open = document.createElement('button'); open.className = 'secondary'; open.textContent = 'CBZ';
        open.addEventListener('click', async () => { try { await window.manhwaAPI.showDownloadedFile(item.file); } catch (error) { setStatus(error.message); } });
        row.appendChild(open);
      }
      box.appendChild(row);
    }
  } catch (error) { setStatus(`Queue konnte nicht geladen werden: ${error.message}`); }
}

async function exportBackup() {
  const state = $('#backupState');
  try {
    state.className = 'update-progress working'; state.textContent = 'Backup wird erstellt …';
    const result = await window.manhwaAPI.exportBackup();
    if (!result) { state.className = 'update-progress'; state.textContent = 'Backup abgebrochen.'; return; }
    state.className = 'update-progress done'; state.textContent = `Backup gespeichert: ${result.file}`;
    setStatus(`Backup gespeichert: ${result.file}`);
  } catch (error) { state.className = 'update-progress error'; state.textContent = `Backup fehlgeschlagen: ${error.message}`; setStatus(state.textContent); }
}

async function restoreBackup() {
  if (!confirm('Backup wiederherstellen?\n\nEinstellungen, Webseiten, Verlauf, Sync-Auswahl und Connector-Rezepte werden aus dem Backup geladen. Deine CBZ-Dateien werden nicht verändert.')) return;
  const state = $('#backupState');
  try {
    state.className = 'update-progress working'; state.textContent = 'Backup wird wiederhergestellt …';
    const result = await window.manhwaAPI.restoreBackup();
    if (!result) { state.className = 'update-progress'; state.textContent = 'Wiederherstellung abgebrochen.'; return; }
    await loadSettings(); await refreshWebsites(); await refreshDownloads(); await refreshPhoneSync(); await renderConnectors(); await render();
    state.className = 'update-progress done'; state.textContent = `Wiederhergestellt: ${result.file}`;
    setStatus('Backup wurde wiederhergestellt.');
  } catch (error) { state.className = 'update-progress error'; state.textContent = `Wiederherstellung fehlgeschlagen: ${error.message}`; setStatus(state.textContent); }
}

function setResult(element, data, good = true) {
  element.className = `result-box ${good ? 'good' : 'bad'}`;
  element.textContent = typeof data === 'string' ? data : JSON.stringify(data, null, 2);
}

function renderSuggestionList(containerSelector, items, targetInputSelector, kind) {
  const container = $(containerSelector);
  container.innerHTML = '';
  if (!items?.length) {
    container.innerHTML = '<div class="suggestion-empty">Keine sicheren Vorschläge gefunden.</div>';
    return;
  }
  for (const item of items.slice(0, 8)) {
    const button = document.createElement('button');
    button.className = 'suggestion';
    const code = document.createElement('code');
    code.textContent = item.selector;
    const meta = document.createElement('small');
    const example = Array.isArray(item.examples) ? item.examples.filter(Boolean)[0] : item.example;
    meta.textContent = `${item.count ?? '?'} Treffer${example ? ` · ${String(example).slice(0, 85)}` : ''}`;
    button.append(code, meta);
    button.addEventListener('click', () => {
      $(targetInputSelector).value = item.selector;
      if (kind === 'pages' && !$('#pageWaitForSelector').value.trim()) $('#pageWaitForSelector').value = item.selector;
      setStatus(`Selektor übernommen: ${item.selector}`);
    });
    container.appendChild(button);
  }
}

function pickerPreview(result) {
  const suggestions = result?.suggestions?.slice(0, 8).map((item) => {
    const symbol = item.symbol || (item.quality === 'very-good' || item.quality === 'good' ? '✓' : item.quality === 'warning' ? '⚠' : '✗');
    const label = item.qualityLabel || 'Prüfen';
    return `  ${symbol} ${item.count}×  ${item.selector} · ${label}`;
  }).join('\n') || '(keine brauchbaren weiteren Vorschläge)';
  const adjusted = result?.autoAdjusted ? `\nAutomatisch korrigiert: ${result.originalTag || '?'} → ${result.tag || '?'}` : '';
  const warning = result?.warning ? `\nHinweis: ${result.warning}` : '';
  return `Gewählt: ${result?.tag || '-'}\nTreffer: ${result?.count ?? 0}\nSelektor: ${result?.selector || '-'}\nQualität: ${result?.symbol || ''} ${result?.qualityLabel || '-'}\nText: ${result?.text || '(leer)'}${adjusted}${warning}\n\nWeitere Vorschläge:\n${suggestions}`;
}

async function runPicker(mode, url, inputSelector, resultSelector) {
  if (pickerInProgress) return setStatus('Der Element-Picker ist bereits aktiv.');
  if (!url) return setStatus('Bitte zuerst eine Seite laden bzw. eine Reader-URL angeben.');
  pickerInProgress = true;
  setStatus('Browser ist geöffnet: gewünschtes Element anklicken. ESC bricht ab.');
  try {
    const result = await window.manhwaAPI.labPickElement({ url, mode });
    if (result?.cancelled) {
      setStatus(result.timeout ? 'Element-Picker: Zeitüberschreitung.' : 'Element-Picker abgebrochen.');
      return;
    }
    if (result?.selector && result?.quality !== 'bad') $(inputSelector).value = result.selector;
    if (mode === 'pages' && result?.selector && !$('#pageWaitForSelector').value.trim()) $('#pageWaitForSelector').value = result.selector;
    if (mode === 'chapters' && result?.tag === 'a') $('#chapterUrlAttributes').value = 'href';
    if (mode === 'pages') {
      const attrs = result?.attributes || {};
      const preferred = ['data-src', 'data-lazy-src', 'data-original', 'src'].filter((name) => attrs[name]);
      if (preferred.length) $('#pageUrlAttributes').value = [...new Set([...preferred, 'src', 'data-src', 'data-lazy-src', 'data-original'])].join(', ');
    }
    setResult($(resultSelector), pickerPreview(result), Boolean(result?.selector));
    setStatus(result?.selector ? `Element gewählt: ${result.selector} (${result.qualityLabel || 'Prüfen'})` : 'Kein brauchbarer Selektor gefunden – bitte genauer auf das gewünschte Element klicken.');
  } catch (error) {
    setStatus(`Element-Picker fehlgeschlagen: ${error.message}`);
  } finally {
    pickerInProgress = false;
  }
}

async function highlight(selector, url) {
  if (!selector) return setStatus('Bitte zuerst einen CSS-Selektor eintragen.');
  try {
    const result = await window.manhwaAPI.labHighlight({ selector, url, limit: 100 });
    if (result?.error) throw new Error(result.error);
    setStatus(`${result.highlighted}/${result.count} Treffer im Browser markiert.`);
  } catch (error) {
    setStatus(`Markieren fehlgeschlagen: ${error.message}`);
  }
}


function updateRowText(row) {
  const errors = Array.isArray(row.errors) ? row.errors.filter(Boolean) : [];
  if (row.status === 'checking') return 'wird geprüft …';
  if (row.status === 'error') return errors[0] || 'Prüfung fehlgeschlagen';
  if (row.status === 'language-skip') return `übersprungen · ${row.languageReason || languageName(row.language)}`;
  if (row.status === 'status-skip') return `übersprungen · ${row.statusReason || seriesStatusName(row.seriesStatus)}`;
  if (row.newChapters > 0) {
    const base = `${row.newChapters} neue Kapitel · ${row.downloaded || 0} heruntergeladen`;
    return errors.length ? `${base} · ${errors.length} Fehler` : base;
  }
  return 'aktuell · keine neuen Kapitel';
}

function renderUpdateRows(rows = liveUpdateRows) {
  const box = $('#updateResults');
  if (!box) return;
  box.innerHTML = '';
  if (!rows?.length) {
    box.innerHTML = '<div class="empty compact">Noch keine Serien geprüft.</div>';
    return;
  }
  for (const row of rows) {
    const entry = document.createElement('div');
    const statusClass = row.status === 'error' ? 'error' : (row.status === 'language-skip' ? 'language-skip' : (row.status === 'status-skip' ? 'status-skip' : (row.newChapters > 0 ? 'updated' : '')));
    entry.className = `update-result-row ${statusClass}`.trim();
    const copy = document.createElement('div');
    const title = document.createElement('strong'); title.textContent = row.title || row.url || 'Serie';
    const meta = document.createElement('small'); meta.textContent = updateRowText(row);
    copy.append(title, meta);
    const badge = document.createElement('span'); badge.className = 'update-result-badge';
    badge.textContent = row.status === 'error' ? 'Fehler' : (row.status === 'language-skip' ? 'Sprache' : (row.status === 'status-skip' ? seriesStatusName(row.seriesStatus) : (row.newChapters > 0 ? `+${row.newChapters}` : 'Aktuell')));
    entry.append(copy, badge); box.appendChild(entry);
  }
}

function renderUpdateSummary(summary) {
  const total = Number(summary?.totalSeries || 0);
  const checked = Number(summary?.checkedSeries || 0);
  const updated = Number(summary?.updatedSeries || 0);
  const chapters = Number(summary?.downloadedChapters || 0);
  const errors = Number(summary?.errors || 0);
  const languageSkipped = Number(summary?.skippedLanguageSeries || 0);
  const statusSkipped = Number(summary?.skippedStatusSeries || 0);
  $('#updateSummary').textContent = `${checked}/${total} Serien geprüft · ${updated} mit Updates · ${chapters} neue Kapitel heruntergeladen${languageSkipped ? ` · ${languageSkipped} wegen Sprache übersprungen` : ''}${statusSkipped ? ` · ${statusSkipped} wegen Status übersprungen` : ''}${errors ? ` · ${errors} Fehler` : ''}.`;
  liveUpdateRows = Array.isArray(summary?.series) ? summary.series : [];
  renderUpdateRows();
}

async function runUpdateScan() {
  if (updateScanRunning) return;
  const mainButton = $('#updateScanBtn');
  const againButton = $('#updateScanAgainBtn');
  const progress = $('#updateProgress');
  try {
    updateScanRunning = true;
    mainButton.disabled = true; againButton.disabled = true;
    mainButton.textContent = 'Scan läuft …';
    showPanel('#updatesPanel', true);
    showPanel('#debugPanel', false);
    liveUpdateRows = [];
    renderUpdateRows();
    progress.className = 'update-progress working';
    progress.textContent = 'Bekannte Serien werden gesammelt …';
    $('#updateSummary').textContent = 'Update-Scan läuft. Neue Kapitel werden automatisch als CBZ heruntergeladen.';
    $('#updatesPanel').scrollIntoView({ behavior: 'smooth', block: 'start' });
    const result = await window.manhwaAPI.scanUpdates();
    if (result?.skipped) {
      progress.className = 'update-progress working';
      progress.textContent = 'Ein Update-Scan läuft bereits.';
      return;
    }
    renderUpdateSummary(result);
    progress.className = result.errors ? 'update-progress error' : 'update-progress done';
    progress.textContent = result.errors
      ? `Fertig mit ${result.errors} Fehler(n). Erfolgreiche neue Kapitel wurden trotzdem geladen.`
      : 'Fertig. Alle bekannten Serien sind geprüft.';
    await refreshDownloads();
    await refreshNews({ markSeen: false });
    await render();
    if (selectedCatalog?.series?.url) {
      const current = { title: selectedCatalog.series.title, url: selectedCatalog.series.url };
      await openCatalogSeries(current);
    }
    const message = result.updatedSeries
      ? `${result.updatedSeries} Serie(n) hatten Updates – ${result.downloadedChapters} neue Kapitel wurden heruntergeladen.`
      : `Keine Updates gefunden. ${result.checkedSeries} Serie(n) geprüft.`;
    setStatus(result.errors ? `${message} ${result.errors} Fehler – Details im Update-Fenster.` : message);
  } catch (error) {
    progress.className = 'update-progress error';
    progress.textContent = `Update-Scan fehlgeschlagen: ${error.message}`;
    setStatus(`Update-Scan fehlgeschlagen: ${error.message}`);
  } finally {
    updateScanRunning = false;
    mainButton.disabled = false; againButton.disabled = false;
    mainButton.textContent = 'Updates scannen';
  }
}

async function renderConnectors() {
  const info = await window.manhwaAPI.listConnectors();
  const web = info.connectors.filter((item) => item.type === 'web-recipe');
  const domains = web.flatMap((item) => item.domains || []);
  catalogSources = web.flatMap((item) => (item.domains || []).map((domain) => ({ connectorId: item.id, label: item.label, domain })));
  let text = `${info.connectors.length} Connector(en), davon ${web.length} Web-Recipe(s)`;
  if (domains.length) text += ` · ${domains.join(', ')}`;
  if (info.errors?.length) text += ` · ${info.errors.length} Fehler`;
  $('#connectorSummary').textContent = text;
  renderSources();
}

async function openLab(url = '') {
  showPanel('#labPanel', true);
  showPanel('#debugPanel', false);
  if (url) {
    $('#labUrl').value = url;
    await detectLabUrl();
  }
  $('#labPanel').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

async function detectLabUrl() {
  const url = $('#labUrl').value.trim();
  if (!url) return;
  const result = await window.manhwaAPI.labDetect(url);
  if (result.hostname) {
    $('#labDomain').value = result.hostname;
    if (!$('#labId').value.trim()) $('#labId').value = slugify(result.hostname);
    if (!$('#labLabel').value.trim()) $('#labLabel').value = humanizeDomain(result.hostname);
  }
  if (result.connector) {
    setStatus(`Für diese URL ist bereits „${result.connector.label}“ registriert.`);
  }
}

async function render() {
  const series = await window.manhwaAPI.listSeries();
  list.innerHTML = '';
  if (!series.length) { list.innerHTML = '<div class="empty">Noch keine Serien hinzugefügt.</div>'; return; }

  for (const item of series) {
    const fragment = $('#seriesTemplate').content.cloneNode(true);
    fragment.querySelector('.title').textContent = item.title;
    fragment.querySelector('.meta').textContent = `${shortConnector(item.connectorId)} · zuletzt geprüft: ${formatDate(item.lastCheckedAt)} · ${item.url}`;
    const error = fragment.querySelector('.series-error');
    if (item.lastError) { error.textContent = `⚠ ${item.lastError}`; error.style.display = 'block'; }

    const auto = fragment.querySelector('.autoDownload');
    auto.checked = Boolean(item.autoDownload);
    auto.addEventListener('change', async () => {
      await window.manhwaAPI.updateSeries(item.id, { autoDownload: auto.checked });
      setStatus(auto.checked ? 'Auto-Download aktiviert.' : 'Auto-Download deaktiviert.');
    });

    fragment.querySelector('.lab').addEventListener('click', () => openLab(item.url));

    fragment.querySelector('.check').addEventListener('click', async (event) => {
      const button = event.currentTarget;
      try {
        button.disabled = true; setStatus(`${item.title} wird geprüft …`);
        const result = await window.manhwaAPI.checkSeries(item.id);
        setStatus(result.newChapters.length ? `${result.newChapters.length} neue Kapitel gefunden.` : 'Keine neuen Kapitel.');
        await render();
      } catch (err) { setStatus(`Fehler: ${err.message}`); await render(); }
      finally { button.disabled = false; }
    });

    fragment.querySelector('.remove').addEventListener('click', async () => {
      if (!confirm(`„${item.title}“ wirklich entfernen?`)) return;
      await window.manhwaAPI.removeSeries(item.id); await render();
    });

    const chapters = fragment.querySelector('.chapters');
    const shown = [...(item.chapters || [])].reverse().slice(0, 40);
    if (!shown.length) chapters.innerHTML = '<div class="empty">Keine Kapitel gefunden.</div>';
    for (const chapter of shown) {
      const row = document.createElement('div'); row.className = 'chapter';
      const title = document.createElement('div'); title.textContent = chapter.title;
      const state = document.createElement('small'); state.textContent = chapter.downloaded ? '✓ heruntergeladen' : 'nicht geladen';
      if (chapter.downloaded) state.className = 'done';
      const button = document.createElement('button'); button.textContent = chapter.downloaded ? 'Fertig' : 'Download'; button.disabled = chapter.downloaded;
      button.addEventListener('click', async () => {
        try {
          button.disabled = true; setStatus(`${item.title} – ${chapter.title} wird heruntergeladen …`);
          await window.manhwaAPI.downloadChapter(item.id, chapter.id);
          setStatus(`${chapter.title} wurde heruntergeladen.`); await render();
        } catch (err) { button.disabled = false; setStatus(`Downloadfehler: ${err.message}`); }
      });
      row.append(title, state, button); chapters.appendChild(row);
    }
    list.appendChild(fragment);
  }
}

async function loadSettings() {
  const settings = await window.manhwaAPI.getSettings();
  $('#autoCheck').checked = Boolean(settings.autoCheck);
  $('#interval').value = settings.checkIntervalMinutes;
  $('#requestDelay').value = settings.requestDelayMs ?? 350;
  $('#notifications').checked = settings.notifications !== false;
  $('#autoUpdateScan').checked = Boolean(settings.autoUpdateScan);
  $('#updateIntervalHours').value = Math.max(1, Number(settings.updateScanIntervalHours) || 6);
  $('#updateScanOnStartup').checked = Boolean(settings.updateScanOnStartup);
  const allowedLanguages = Array.isArray(settings.allowedLanguages) ? settings.allowedLanguages : ['en', 'de'];
  $('#langEn').checked = allowedLanguages.includes('en');
  $('#langDe').checked = allowedLanguages.includes('de');
  $('#langUnknown').checked = Boolean(settings.allowUnknownLanguage);
  const allowedStatuses = Array.isArray(settings.allowedSeriesStatuses) ? settings.allowedSeriesStatuses : ['ongoing','completed','hiatus','upcoming','unknown'];
  for (const key of ['ongoing','completed','hiatus','upcoming','cancelled','dropped','unknown']) {
    const node = $('#status-' + key);
    if (node) node.checked = allowedStatuses.includes(key);
  }
  $('#folderPath').value = settings.downloadRoot || '';
}

async function refreshDebugLog() {
  const entries = await window.manhwaAPI.getDebugLog();
  const box = $('#debugLog');
  if (!entries.length) { box.textContent = 'Noch keine Einträge.'; return; }
  box.innerHTML = '';
  for (const entry of entries.slice().reverse()) {
    const line = document.createElement('div');
    line.className = `log-${entry.level}`;
    const details = entry.details == null ? '' : ` | ${JSON.stringify(entry.details)}`;
    line.textContent = `${new Date(entry.time).toLocaleTimeString()} [${entry.level.toUpperCase()}] ${entry.message}${details}`;
    box.appendChild(line);
  }
}

function collectRecipeForm() {
  return {
    url: $('#labUrl').value.trim(),
    domain: $('#labDomain').value.trim(),
    id: $('#labId').value.trim(),
    label: $('#labLabel').value.trim(),
    titleSelector: $('#titleSelector').value.trim(),
    chapterSelector: $('#chapterSelector').value.trim(),
    chapterTitleSelector: $('#chapterTitleSelector').value.trim(),
    chapterUrlSelector: $('#chapterUrlSelector').value.trim(),
    chapterUrlAttributes: $('#chapterUrlAttributes').value.trim(),
    chapterOrder: $('#chapterOrder').value,
    numberRegex: $('#numberRegex').value,
    pageSelector: $('#pageSelector').value.trim(),
    pageUrlSelector: $('#pageUrlSelector').value.trim(),
    pageUrlAttributes: $('#pageUrlAttributes').value.trim(),
    pageWaitForSelector: $('#pageWaitForSelector').value.trim(),
    settleMs: Number($('#settleMs').value) || 400,
    timeoutMs: Number($('#timeoutMs').value) || 30000,
    overwrite: $('#overwriteConnector').checked
  };
}

$('#autoCheck').addEventListener('change', async (event) => { await window.manhwaAPI.setSettings({ autoCheck: event.target.checked }); setStatus('Einstellung gespeichert.'); });
$('#notifications').addEventListener('change', async (event) => { await window.manhwaAPI.setSettings({ notifications: event.target.checked }); setStatus('Einstellung gespeichert.'); });
$('#autoUpdateScan').addEventListener('change', async (event) => { await window.manhwaAPI.setSettings({ autoUpdateScan: event.target.checked }); setStatus(event.target.checked ? 'Automatische Update-Scans aktiviert.' : 'Automatische Update-Scans deaktiviert.'); });
$('#updateIntervalHours').addEventListener('change', async (event) => { const hours = Math.max(1, Math.min(168, Number(event.target.value) || 6)); event.target.value = hours; await window.manhwaAPI.setSettings({ updateScanIntervalHours: hours }); setStatus(`Auto-Update-Intervall: ${hours} Stunden.`); });
$('#updateScanOnStartup').addEventListener('change', async (event) => { await window.manhwaAPI.setSettings({ updateScanOnStartup: event.target.checked }); setStatus('Start-Scan-Einstellung gespeichert.'); });
$('#langEn').addEventListener('change', saveLanguageSettings);
$('#langDe').addEventListener('change', saveLanguageSettings);
$('#langUnknown').addEventListener('change', saveLanguageSettings);
for (const key of ['ongoing','completed','hiatus','upcoming','cancelled','dropped','unknown']) $('#status-' + key)?.addEventListener('change', saveSeriesStatusSettings);
$('#favoritesOnly')?.addEventListener('change', () => { renderCatalog(); updateSiteDownloadControls(); });
$('#readingOnly')?.addEventListener('change', () => { renderCatalog(); updateSiteDownloadControls(); });
$('#statusScanBtn')?.addEventListener('click', (event) => refreshCatalogStatuses(Boolean(event.shiftKey)));
$('#statusDebugBtn')?.addEventListener('click', runStatusDebug);
$('#statusDebugCloseBtn')?.addEventListener('click', () => $('#statusDebugCard')?.classList.add('hidden'));
$('#interval').addEventListener('change', async (event) => { await window.manhwaAPI.setSettings({ checkIntervalMinutes: Math.max(1, Number(event.target.value) || 30) }); setStatus('Prüfintervall gespeichert.'); });
$('#requestDelay').addEventListener('change', async (event) => { await window.manhwaAPI.setSettings({ requestDelayMs: Math.max(0, Number(event.target.value) || 0) }); setStatus('Request-Pause gespeichert.'); });
$('#folderBtn').addEventListener('click', async () => {
  try {
    setStatus('Downloadordner-Auswahl wird geöffnet …');
    const settings = await window.manhwaAPI.chooseDownloadFolder();
    if (!settings) { setStatus('Downloadordner wurde nicht geändert.'); return; }
    $('#folderPath').value = settings.downloadRoot || '';
    libraryHealthResult = null;
    const libraryButton = $('#libraryToggleBtn'); if (libraryButton) libraryButton.textContent = 'Bibliothek';
    setStatus(`Downloadordner geändert: ${settings.downloadRoot}`);
  } catch (error) { setStatus(`Downloadordner konnte nicht geändert werden: ${error.message}`); }
});
$('#applyFolderBtn').addEventListener('click', async () => {
  try {
    const raw = $('#folderPath').value.trim();
    const settings = await window.manhwaAPI.setDownloadFolder(raw);
    $('#folderPath').value = settings.downloadRoot || '';
    libraryHealthResult = null;
    const libraryButton = $('#libraryToggleBtn'); if (libraryButton) libraryButton.textContent = 'Bibliothek';
    setStatus(`Downloadordner geändert: ${settings.downloadRoot}`);
  } catch (error) { setStatus(`Downloadordner konnte nicht geändert werden: ${error.message}`); }
});
$('#folderPath').addEventListener('keydown', (event) => {
  if (event.key === 'Enter') { event.preventDefault(); $('#applyFolderBtn').click(); }
});
$('#openFolderBtn').addEventListener('click', () => window.manhwaAPI.openDownloadFolder());
$('#newsToggleBtn').addEventListener('click', async () => { showPanel('#newsPanel', true); showPanel('#debugPanel', false); await refreshNews({ markSeen: true }); $('#newsPanel').scrollIntoView({ behavior: 'smooth', block: 'start' }); });
$('#closeNewsBtn').addEventListener('click', () => showPanel('#newsPanel', false));
$('#newsScanBtn').addEventListener('click', runUpdateScan);
$('#updateScanBtn').addEventListener('click', runUpdateScan);
$('#updateScanAgainBtn').addEventListener('click', runUpdateScan);
$('#closeUpdatesBtn').addEventListener('click', () => showPanel('#updatesPanel', false));
$('#connectorFolderBtn').addEventListener('click', () => window.manhwaAPI.openConnectorFolder());
$('#reloadConnectorsBtn').addEventListener('click', async () => { await window.manhwaAPI.reloadConnectors(); await renderConnectors(); setStatus('Connectoren wurden neu geladen.'); });
$('#browserTestBtn').addEventListener('click', async () => {
  const pill = $('#engineState');
  try { pill.textContent = 'teste …'; pill.className = 'pill'; const result = await window.manhwaAPI.browserSelfTest(); pill.textContent = result.ok ? 'bereit' : 'Fehler'; pill.className = result.ok ? 'pill ok' : 'pill bad'; setStatus(result.ok ? 'Versteckte Chromium Browser Engine funktioniert.' : 'Browser-Selbsttest fehlgeschlagen.'); }
  catch (error) { pill.textContent = 'Fehler'; pill.className = 'pill bad'; setStatus(`Browserfehler: ${error.message}`); }
});

$('#websitesToggleBtn').addEventListener('click', async () => {
  showPanel('#websitesPanel', true); showPanel('#debugPanel', false); showPanel('#downloadsPanel', false);
  await refreshWebsites();
  $('#websitesPanel').scrollIntoView({ behavior: 'smooth', block: 'start' });
});
$('#phoneSyncToggleBtn').addEventListener('click', async () => {
  showPanel('#phoneSyncPanel', true); showPanel('#debugPanel', false); showPanel('#downloadsPanel', false); showPanel('#websitesPanel', false);
  await refreshPhoneSync();
  $('#phoneSyncPanel').scrollIntoView({ behavior: 'smooth', block: 'start' });
});
$('#closePhoneSyncBtn').addEventListener('click', () => showPanel('#phoneSyncPanel', false));
$('#choosePhoneSyncFolderBtn').addEventListener('click', async () => {
  try {
    phoneSyncStatus = await window.manhwaAPI.choosePhoneSyncFolder();
    await refreshPhoneSync();
    if (phoneSyncStatus.root) setStatus(`Handy-Sync-Ordner: ${phoneSyncStatus.root}`);
  } catch (error) { setStatus(`Handy-Sync-Ordner konnte nicht gewählt werden: ${error.message}`); }
});
$('#openPhoneSyncFolderBtn').addEventListener('click', async () => {
  try { await window.manhwaAPI.openPhoneSyncFolder(); }
  catch (error) { setStatus(`Handy-Sync-Ordner konnte nicht geöffnet werden: ${error.message}`); }
});
$('#runPhoneSyncBtn').addEventListener('click', runPhoneSync);
$('#closeWebsitesBtn').addEventListener('click', () => showPanel('#websitesPanel', false));
$('#saveWebsiteBtn').addEventListener('click', saveWebsiteFromEditor);
$('#cancelWebsiteEditBtn').addEventListener('click', resetWebsiteEditor);
$('#websiteUrl').addEventListener('keydown', (event) => { if (event.key === 'Enter') saveWebsiteFromEditor(); });
$('#saveCurrentWebsiteBtn').addEventListener('click', saveCurrentWebsite);
$('#browseLoadBtn').addEventListener('click', () => loadCatalog(true));
$('#downloadSiteBtn').addEventListener('click', startFullSiteDownload);
$('#downloadFilteredBtn').addEventListener('click', startFilteredCatalogDownload);
$('#sitePauseBtn').addEventListener('click', toggleSiteDownloadPause);
$('#siteCancelBtn').addEventListener('click', cancelSiteDownload);
$('#browseSearch').addEventListener('input', () => { renderCatalog(); updateSiteDownloadControls(); });
$('#browseUrl').addEventListener('input', updateSiteDownloadControls);
$('#browseUrl').addEventListener('keydown', (event) => { if (event.key === 'Enter') loadCatalog(true); });
$('#sourceSelect').addEventListener('change', async (event) => {
  const value = event.target.value;
  if (!value) return;
  if (value.startsWith('site:')) {
    const site = savedWebsites.find((item) => item.id === value.slice(5));
    if (!site) return;
    $('#browseUrl').value = site.url;
  } else if (value.startsWith('connector:')) {
    $('#browseUrl').value = `https://${value.slice('connector:'.length)}/`;
  }
  await loadCatalog(false);
});
$('#chapterSearch').addEventListener('input', renderCatalogChapters);
$('#hideDownloaded').addEventListener('change', renderCatalogChapters);
$('#chapterSelectAllBtn').addEventListener('click', () => {
  for (const chapter of selectedCatalog?.series?.chapters || []) selectedChapterIds.add(String(chapter.id));
  renderCatalogChapters();
});
$('#chapterSelectNoneBtn').addEventListener('click', () => { selectedChapterIds.clear(); renderCatalogChapters(); });
$('#downloadSelectedBtn').addEventListener('click', () => downloadCatalogChapters([...selectedChapterIds]));
$('#downloadAllBtn').addEventListener('click', () => downloadCatalogChapters((selectedCatalog?.series?.chapters || []).map((chapter) => String(chapter.id))));
$('#favoriteSelectedBtn').addEventListener('click', async () => { try { await toggleSelectedReadingList('favorite'); } catch (error) { setStatus(`Favorit konnte nicht geändert werden: ${error.message}`); } });
$('#readingSelectedBtn').addEventListener('click', async () => { try { await toggleSelectedReadingList('reading'); } catch (error) { setStatus(`Leseliste konnte nicht geändert werden: ${error.message}`); } });
$('#watchSelectedBtn').addEventListener('click', async () => {
  if (!selectedCatalog?.series) return;
  try {
    const item = await window.manhwaAPI.catalogWatchSeries(selectedCatalog.series.url);
    selectedCatalog.watched = true; selectedCatalog.watchedId = item.id;
    renderCatalogChapters(); await render();
    setStatus(`„${item.title}“ wird jetzt beobachtet.`);
  } catch (error) { setStatus(`Beobachten fehlgeschlagen: ${error.message}`); }
});
$('#syncSelectedBtn').addEventListener('click', async () => {
  if (!selectedCatalog?.series) return;
  const next = !selectedCatalog.syncEnabled;
  try {
    const result = await window.manhwaAPI.togglePhoneSyncSeries({
      url: selectedCatalog.series.url,
      title: selectedCatalog.series.title,
      enabled: next
    });
    selectedCatalog.syncEnabled = Boolean(result.enabled);
    await refreshPhoneSync();
    renderCatalogChapters();
    if (next && !result.root) {
      setStatus(`„${selectedCatalog.series.title}“ ist für Handy-Sync markiert. Wähle jetzt unter „Handy-Sync“ den Syncthing-Ordner.`);
    } else {
      setStatus(next ? `„${selectedCatalog.series.title}“ wird aufs Handy synchronisiert. Vorhandene CBZs wurden abgeglichen.` : `Handy-Sync für „${selectedCatalog.series.title}“ deaktiviert. Dateien im Sync-Ordner bleiben erhalten.`);
    }
  } catch (error) { setStatus(`Handy-Sync konnte nicht geändert werden: ${error.message}`); }
});
$('#labSelectedBtn').addEventListener('click', () => { if (selectedCatalog?.series?.url) openLab(selectedCatalog.series.url); });
$('#labToggleBtn').addEventListener('click', () => openLab(selectedCatalog?.series?.url || $('#browseUrl').value.trim()));
$('#closeLabBtn').addEventListener('click', () => showPanel('#labPanel', false));
$('#downloadsToggleBtn').addEventListener('click', async () => { showPanel('#downloadsPanel', true); showPanel('#debugPanel', false); await refreshDownloads(); $('#downloadsPanel').scrollIntoView({ behavior: 'smooth', block: 'start' }); });
$('#closeDownloadsBtn').addEventListener('click', () => showPanel('#downloadsPanel', false));
$('#refreshDownloadsBtn').addEventListener('click', refreshDownloads);
$('#libraryToggleBtn').addEventListener('click', async () => { showPanel('#libraryPanel', true); showPanel('#debugPanel', false); $('#libraryPanel').scrollIntoView({ behavior: 'smooth', block: 'start' }); if (!libraryHealthResult) await runLibraryHealthScan(false); });
$('#closeLibraryBtn').addEventListener('click', () => showPanel('#libraryPanel', false));
$('#refreshLibraryStatsBtn').addEventListener('click', () => runLibraryHealthScan(false));
$('#deepLibraryScanBtn').addEventListener('click', () => runLibraryHealthScan(true));
$('#repairLibraryBtn').addEventListener('click', repairLibraryProblems);
$('#queueToggleBtn').addEventListener('click', async () => { showPanel('#queuePanel', true); showPanel('#debugPanel', false); await refreshQueue(); $('#queuePanel').scrollIntoView({ behavior: 'smooth', block: 'start' }); });
$('#closeQueueBtn').addEventListener('click', () => showPanel('#queuePanel', false));
$('#refreshQueueBtn').addEventListener('click', refreshQueue);
$('#clearQueueBtn').addEventListener('click', async () => { await window.manhwaAPI.clearFinishedQueue(); await refreshQueue(); });
$('#backupToggleBtn').addEventListener('click', () => { showPanel('#backupPanel', true); showPanel('#debugPanel', false); $('#backupPanel').scrollIntoView({ behavior: 'smooth', block: 'start' }); });
$('#closeBackupBtn').addEventListener('click', () => showPanel('#backupPanel', false));
$('#exportBackupBtn').addEventListener('click', exportBackup);
$('#restoreBackupBtn').addEventListener('click', restoreBackup);
$('#debugToggleBtn').addEventListener('click', async () => { showPanel('#debugPanel', true); showPanel('#labPanel', false); await refreshDebugLog(); $('#debugPanel').scrollIntoView({ behavior: 'smooth', block: 'start' }); });
$('#closeDebugBtn').addEventListener('click', () => showPanel('#debugPanel', false));
$('#refreshLogBtn').addEventListener('click', refreshDebugLog);
$('#openLogFolderBtn').addEventListener('click', () => window.manhwaAPI.openDebugFolder());
$('#clearLogBtn').addEventListener('click', async () => { await window.manhwaAPI.clearDebugLog(); await refreshDebugLog(); setStatus('Debug-Log geleert.'); });

$('#labUrl').addEventListener('change', detectLabUrl);
$('#labLoadBtn').addEventListener('click', async () => {
  const url = $('#labUrl').value.trim();
  if (!url) return;
  const pill = $('#labPageState');
  try {
    pill.textContent = 'lädt …'; pill.className = 'pill';
    window.manhwaAPI.rendererLog('info', 'URL laden geklickt', { url });
    await detectLabUrl();
    const result = await window.manhwaAPI.labLoad(url);
    pill.textContent = `${result.hostname} · bereit`; pill.className = 'pill ok';
    setStatus(`Connector-Labor: „${result.title || result.hostname}“ geladen.`);
  } catch (error) {
    pill.textContent = 'Fehler'; pill.className = 'pill bad'; setStatus(`Laborfehler: ${error.message}`);
  }
});
$('#showBrowserBtn').addEventListener('click', async () => {
  const url = $('#labUrl').value.trim();
  try {
    const result = await window.manhwaAPI.labSetBrowserVisible(true, url);
    setStatus(`Browserfenster eingeblendet${result?.url ? ` – ${result.url}` : '.'}`);
  } catch (error) { setStatus(`Browser konnte nicht angezeigt werden: ${error.message}`); }
});
$('#hideBrowserBtn').addEventListener('click', async () => { await window.manhwaAPI.labSetBrowserVisible(false, $('#labUrl').value.trim()); setStatus('Browserfenster wieder versteckt.'); });
$('#restartBrowserBtn').addEventListener('click', async () => {
  const url = $('#labUrl').value.trim();
  try {
    const result = await window.manhwaAPI.restartBrowser(url);
    const suffix = result?.reloaded ? ' Die letzte URL wurde automatisch neu geladen.' : '';
    setStatus(`Browserfenster wurde neu gestartet. Cookies und Session bleiben erhalten.${suffix}`);
  } catch (error) { setStatus(`Browser-Neustart fehlgeschlagen: ${error.message}`); }
});
$('#devToolsBtn').addEventListener('click', async () => { await window.manhwaAPI.labOpenDevTools(); setStatus('Chromium DevTools geöffnet.'); });
$('#clearBrowserDataBtn').addEventListener('click', async () => { await window.manhwaAPI.clearBrowserData(); setStatus('Browser-Cache und Site-Daten wurden gelöscht.'); });


$('#analyzePageBtn').addEventListener('click', async () => {
  const url = $('#labUrl').value.trim();
  if (!url) return setStatus('Bitte zuerst eine Serien-URL eingeben.');
  const state = $('#analysisState');
  try {
    showPanel('#analysisPanel', true);
    state.textContent = 'analysiert …'; state.className = 'pill';
    const result = await window.manhwaAPI.labAnalyze({ url });
    $('#analysisMeta').textContent = `${result.title || result.url} · ${result.stats?.anchors ?? 0} Links · ${result.stats?.images ?? 0} Bilder`;
    renderSuggestionList('#titleSuggestions', result.titles, '#titleSelector', 'title');
    renderSuggestionList('#chapterSuggestions', result.chapters, '#chapterSelector', 'chapters');
    renderSuggestionList('#pageSuggestions', result.pages, '#pageSelector', 'pages');
    state.textContent = 'fertig'; state.className = 'pill ok';
    setStatus('DOM-Analyse abgeschlossen. Vorschläge können direkt übernommen werden.');
  } catch (error) {
    state.textContent = 'Fehler'; state.className = 'pill bad';
    setStatus(`DOM-Analyse fehlgeschlagen: ${error.message}`);
  }
});

$('#pickTitleBtn').addEventListener('click', () => runPicker('title', $('#labUrl').value.trim(), '#titleSelector', '#titleResult'));
$('#pickChaptersBtn').addEventListener('click', () => runPicker('chapters', $('#labUrl').value.trim(), '#chapterSelector', '#chapterResult'));
$('#pickPagesBtn').addEventListener('click', () => {
  const url = $('#pageTestUrl').value.trim() || lastChapterTest?.items?.find((item) => item.url)?.url || '';
  runPicker('pages', url, '#pageSelector', '#pageResult');
});
$('#highlightTitleBtn').addEventListener('click', () => highlight($('#titleSelector').value.trim(), $('#labUrl').value.trim()));
$('#highlightChaptersBtn').addEventListener('click', () => highlight($('#chapterSelector').value.trim(), $('#labUrl').value.trim()));
$('#highlightPagesBtn').addEventListener('click', () => {
  const url = $('#pageTestUrl').value.trim() || lastChapterTest?.items?.find((item) => item.url)?.url || '';
  highlight($('#pageSelector').value.trim(), url);
});
$('#clearHighlightsBtn').addEventListener('click', async () => {
  try { const count = await window.manhwaAPI.labClearHighlights(); setStatus(`${count || 0} Markierung(en) entfernt.`); }
  catch (error) { setStatus(`Markierungen konnten nicht entfernt werden: ${error.message}`); }
});

$('#testTitleBtn').addEventListener('click', async () => {
  const box = $('#titleResult');
  try {
    box.textContent = 'Teste …'; box.className = 'result-box muted';
    const result = await window.manhwaAPI.labTestTitle({ url: $('#labUrl').value.trim(), selector: $('#titleSelector').value.trim() });
    if (result.error) return setResult(box, result.error, false);
    const first = result.items?.[0];
    setResult(box, result.count ? `Treffer: ${result.count}\nTitel: ${first?.text || '(leer)'}\nTag: ${first?.tag || '-'}` : 'Keine Treffer.', result.count > 0);
  } catch (error) { setResult(box, error.message, false); }
});

$('#testChaptersBtn').addEventListener('click', async () => {
  const box = $('#chapterResult');
  try {
    box.textContent = 'Teste …'; box.className = 'result-box muted';
    const result = await window.manhwaAPI.labTestChapters({
      url: $('#labUrl').value.trim(), selector: $('#chapterSelector').value.trim(),
      titleSelector: $('#chapterTitleSelector').value.trim(), urlSelector: $('#chapterUrlSelector').value.trim(),
      urlAttributes: $('#chapterUrlAttributes').value.trim()
    });
    if (result.error) return setResult(box, result.error, false);
    lastChapterTest = result;
    const firstUrl = result.items?.find((item) => item.url)?.url;
    if (firstUrl) $('#pageTestUrl').value = firstUrl;
    const preview = result.items?.slice(0, 12).map((item) => `${String(item.index).padStart(2, '0')}. ${item.text || '(ohne Titel)'}\n    ${item.url || '(keine URL)'}`).join('\n');
    setResult(box, `Treffer insgesamt: ${result.count}\n\n${preview || 'Keine Treffer.'}`, result.count > 0);
  } catch (error) { setResult(box, error.message, false); }
});

$('#testPagesBtn').addEventListener('click', async () => {
  const box = $('#pageResult');
  try {
    box.textContent = 'Teste …'; box.className = 'result-box muted';
    let url = $('#pageTestUrl').value.trim();
    if (!url) url = lastChapterTest?.items?.find((item) => item.url)?.url || '';
    if (!url) throw new Error('Bitte zuerst eine Kapitel-/Reader-URL angeben oder den Kapiteltest ausführen.');
    const result = await window.manhwaAPI.labTestPages({
      url, selector: $('#pageSelector').value.trim(), urlSelector: $('#pageUrlSelector').value.trim(), urlAttributes: $('#pageUrlAttributes').value.trim()
    });
    if (result.error) return setResult(box, result.error, false);
    const preview = result.items?.slice(0, 15).map((item) => `${String(item.index).padStart(2, '0')}. ${item.url || '(keine URL)'}`).join('\n');
    setResult(box, `Treffer insgesamt: ${result.count}\n\n${preview || 'Keine Treffer.'}`, result.count > 0);
  } catch (error) { setResult(box, error.message, false); }
});

$('#saveConnectorBtn').addEventListener('click', async () => {
  try {
    const form = collectRecipeForm();
    if (!form.id || !form.domain || !form.chapterSelector || !form.pageSelector) throw new Error('ID, Domain, Kapitel-Selektor und Bild-Selektor sind Pflichtfelder.');
    const result = await window.manhwaAPI.labSaveRecipe(form);
    await renderConnectors();
    setStatus(`Connector „${result.recipe.label}“ wurde gespeichert und aktiviert.`);
  } catch (error) { setStatus(`Connector konnte nicht gespeichert werden: ${error.message}`); }
});

window.manhwaAPI.onEvent(async (event) => {
  if (event.type === 'library-scan-start') {
    libraryScanRunning = true;
    $('#libraryScanProgress').className = 'update-progress working';
    $('#libraryScanProgress').textContent = event.deep ? 'Tiefe CBZ-Prüfung läuft …' : 'Speicher wird analysiert …';
  }
  if (event.type === 'library-scan-progress') {
    $('#libraryScanProgress').className = 'update-progress working';
    $('#libraryScanProgress').textContent = `${event.current || 0}/${event.total || 0} Serien · ${(event.cbzCount || 0).toLocaleString('de-DE')} CBZ · ${formatBytes(event.bytes || 0)}${event.deep ? ` · ${event.corruptCount || 0} beschädigt` : ''}`;
  }
  if (event.type === 'library-scan-done') {
    libraryScanRunning = false;
    renderLibraryHealth(event.result);
  }
  if (event.type === 'library-scan-error') {
    libraryScanRunning = false;
    $('#libraryScanProgress').className = 'update-progress error';
    $('#libraryScanProgress').textContent = `Prüfung fehlgeschlagen: ${event.message || 'Unbekannter Fehler'}`;
  }
  if (event.type === 'library-repair-done') {
    setStatus(`${event.seriesTitle || 'Serie'} – ${event.chapterTitle || 'Kapitel'} wurde erfolgreich neu heruntergeladen.`);
    await refreshDownloads(); await refreshQueue();
    if (!$('#libraryPanel').classList.contains('hidden')) await runLibraryHealthScan(true);
  }
  if (event.type === 'library-repair-error') {
    setStatus(`Reparaturdownload fehlgeschlagen: ${event.message || 'Unbekannter Fehler'}`);
  }
  if (event.type === 'library-auto-repair-start') {
    libraryRepairRunning = true;
    $('#libraryScanProgress').className = 'update-progress working';
    $('#libraryScanProgress').textContent = `Autoreparatur: ${event.total || 0} Problem(e) werden verarbeitet …`;
  }
  if (event.type === 'library-auto-repair-progress') {
    const label = event.problem?.seriesTitle || event.problem?.file || event.problem?.type || 'Problem';
    $('#libraryScanProgress').className = 'update-progress working';
    $('#libraryScanProgress').textContent = `Autoreparatur ${event.current || 0}/${event.total || 0}: ${label}`;
  }
  if (event.type === 'library-auto-repair-connector-fallback') {
    setStatus(`Connector-Reparatur: Für ${event.domain} wird künftig die automatische Erkennung bevorzugt.`);
  }
  if (event.type === 'library-auto-repair-done') libraryRepairRunning = false;
  if (event.type === 'browser-load-start') setStatus(`Browser lädt ${event.url} …`);
  if (event.type === 'browser-load-error') setStatus(`Browserfehler: ${event.message}`);
  if (event.type === 'browser-retry') setStatus(`Browser wird neu gestartet und lädt erneut …`);
  if (event.type === 'browser-recovery') setStatus('Kapitel-Navigation wurde blockiert – Browserzustand wird automatisch repariert …');
  if (event.type === 'reader-http-fallback-start') setStatus('Chromium-Navigation blockiert – Reader wird direkt über die Browser-Session geladen …');
  if (event.type === 'reader-http-fallback-done') setStatus(`Reader per HTTP-Fallback erkannt: ${event.pageCount || 0} Seiten.`);
  if (event.type === 'browser-renderer-gone') setStatus(`Browser-Renderer wurde beendet (${event.reason}). Beim nächsten Laden wird er neu erstellt.`);
  if (event.type === 'browser-unresponsive') setStatus('Browser reagiert nicht mehr. Du kannst ihn im Connector-Labor neu starten.');
  if (['queue-item-added','queue-item-updated','queue-item-error','queue-cleared'].includes(event.type)) scheduleQueueRefresh();
  if (event.type === 'scheduled-update-start') setStatus(event.reason === 'startup' ? 'Automatischer Start-Update-Scan läuft …' : 'Automatischer Update-Scan läuft …');
  if (event.type === 'scheduled-update-done') { const n = Number(event.summary?.downloadedChapters || 0); setStatus(n ? `Auto-Update: ${n} neue Kapitel geladen.` : 'Auto-Update: keine neuen Kapitel.'); await refreshDownloads(); await render(); }
  if (event.type === 'scheduled-update-error') setStatus(`Automatischer Update-Scan fehlgeschlagen: ${event.message}`);
  if (event.type === 'backup-restored') setStatus('Backup wurde wiederhergestellt.');
  if (event.type === 'phone-sync-file-start') {
    $('#phoneSyncProgress').className = 'update-progress working';
    $('#phoneSyncProgress').textContent = `${event.title}: ${event.chapterTitle || 'CBZ'} wird in den Handy-Sync-Ordner kopiert …`;
  }
  if (event.type === 'phone-sync-file-done') {
    $('#phoneSyncProgress').className = 'update-progress done';
    $('#phoneSyncProgress').textContent = `${event.title}: ${event.chapterTitle || 'CBZ'} ${event.copied ? 'synchronisiert' : 'war bereits vorhanden'}.`;
  }
  if (event.type === 'phone-sync-file-error') {
    $('#phoneSyncProgress').className = 'update-progress error';
    $('#phoneSyncProgress').textContent = `${event.title || 'Handy-Sync'}: ${event.message}`;
  }
  if (event.type === 'phone-sync-start') {
    phoneSyncStatus.running = true;
    $('#phoneSyncProgress').className = 'update-progress working';
    $('#phoneSyncProgress').textContent = `${event.totalSeries || 0} Serie(n) werden mit dem Handy-Sync-Ordner abgeglichen …`;
  }
  if (event.type === 'phone-sync-all-series-start') {
    $('#phoneSyncProgress').className = 'update-progress working';
    $('#phoneSyncProgress').textContent = `${event.current}/${event.total}: ${event.title} …`;
  }
  if (event.type === 'phone-sync-series-progress') {
    $('#phoneSyncProgress').textContent = `${event.title}: ${event.current}/${event.total} CBZ · ${event.copied || 0} neu · ${event.existing || 0} vorhanden`;
  }
  if (event.type === 'phone-sync-done') {
    phoneSyncStatus.running = false;
    $('#phoneSyncProgress').className = event.errors ? 'update-progress error' : 'update-progress done';
    $('#phoneSyncProgress').textContent = `${event.checkedSeries || 0}/${event.totalSeries || 0} Serien · ${event.copied || 0} neu · ${event.existing || 0} vorhanden${event.errors ? ` · ${event.errors} Fehler` : ''}`;
  }
  if (event.type === 'catalog-progress') {
    const count = Number(event.count || 0);
    if (event.phase === 'start') {
      $('#browseState').textContent = 'Katalog …';
      $('#browseMeta').textContent = 'Katalogseite wird geöffnet …';
    } else if (event.phase === 'directory') {
      $('#browseState').textContent = `${count} Serien`;
      $('#browseMeta').textContent = `Bessere Serien-/Browse-Seite wird gesucht (${event.current}/${event.max}) …`;
    } else if (event.phase === 'page' || event.phase === 'probe') {
      $('#browseState').textContent = `${count} Serien`;
      $('#browseMeta').textContent = `Katalogseite ${event.current}/${event.max} wird gelesen · bisher ${count} Serien …`;
    } else if (event.phase === 'interactive-page') {
      $('#browseState').textContent = `${count} Serien`;
      $('#browseMeta').textContent = `Weitere Katalogseite wird über „${event.control || 'Weiter'}“ geöffnet · bisher ${count} Serien …`;
    } else if (event.phase === 'done') {
      $('#browseState').textContent = `${count} Serien`;
      $('#browseMeta').textContent = `${event.current || 1} Katalogseite(n) gelesen · ${count} Serien gefunden`;
    }
  }
  if (event.type === 'catalog-status-start') {
    statusScanRunning = true; updateStatusScanButton();
    $('#browseState').textContent = 'Status …';
    $('#browseMeta').textContent = `${event.total || 0} Serienstatus werden geprüft …`;
  }
  if (event.type === 'catalog-status-progress') {
    $('#browseState').textContent = `Status ${event.current || 0}/${event.total || 0}`;
    $('#browseMeta').textContent = `${event.current || 0}/${event.total || 0}: ${event.title || 'Serie'} · ${seriesStatusName(event.status)}`;
    const match = catalogItems.find((item) => sameUrl(item.url, event.url));
    if (match && normalizeSeriesStatus(event.status) !== 'unknown') { match.status = normalizeSeriesStatus(event.status); match.statusSource = event.source || 'series-page'; }
    if ((event.current || 0) % 8 === 0 || normalizeSeriesStatus(event.status) !== 'unknown') renderCatalog();
  }
  if (event.type === 'catalog-status-done') {
    statusScanRunning = false; updateStatusScanButton();
    $('#browseState').textContent = `${catalogItems.length} Serien`;
    $('#browseMeta').textContent = `Statusprüfung abgeschlossen · ${event.updated || 0} neu erkannt · ${event.unknown || 0} unbekannt`;
  }
  if (event.type === 'update-scan-start') {
    $('#updateProgress').className = 'update-progress working';
    $('#updateProgress').textContent = `${event.totalSeries || 0} bekannte Serie(n) werden geprüft …`;
  }
  if (event.type === 'update-series-start') {
    $('#updateProgress').className = 'update-progress working';
    $('#updateProgress').textContent = `${event.current}/${event.total}: ${event.title} wird auf neue Kapitel geprüft …`;
    const existing = liveUpdateRows.find((row) => row.url === event.url);
    if (existing) Object.assign(existing, { status: 'checking', title: event.title });
    else liveUpdateRows.push({ title: event.title, url: event.url, status: 'checking', newChapters: 0, downloaded: 0, errors: [] });
    renderUpdateRows();
  }
  if (event.type === 'update-chapter-start') {
    $('#updateProgress').className = 'update-progress working';
    $('#updateProgress').textContent = `${event.title}: ${event.chapterTitle} wird heruntergeladen …`;
  }
  if (event.type === 'update-chapter-done') {
    $('#updateProgress').textContent = `${event.title}: ${event.chapterTitle} fertig (${event.downloaded}/${event.total})`;
  }
  if (event.type === 'update-chapter-error') {
    $('#updateProgress').className = 'update-progress error';
    $('#updateProgress').textContent = `${event.title}: ${event.chapterTitle} fehlgeschlagen – ${event.message}`;
  }
  if (event.type === 'update-series-done') {
    const index = liveUpdateRows.findIndex((row) => row.url === event.url);
    const next = { title: event.title, url: event.url, status: event.status, language: event.language || null, languageReason: event.languageReason || null, seriesStatus: event.seriesStatus || null, statusReason: event.statusReason || null, newChapters: event.newChapters || 0, downloaded: event.downloaded || 0, errors: event.errors || [] };
    if (index >= 0) liveUpdateRows[index] = next; else liveUpdateRows.push(next);
    renderUpdateRows();
  }
  if (event.type === 'update-scan-done') { refreshNews({ markSeen: false }).catch(() => {}); }
  if (event.type === 'site-download-start') {
    siteDownloadRunning = true; siteDownloadPaused = false; updateSiteDownloadControls();
    $('#siteDownloadPanel').classList.remove('hidden', 'paused', 'error');
    $('#siteDownloadProgress').textContent = `${event.totalSeries || 0} Serien werden verarbeitet …`;
  }
  if (event.type === 'site-series-start') {
    $('#siteDownloadProgress').textContent = `${event.current}/${event.total}: ${event.title} wird geprüft …`;
    $('#siteDownloadMeta').textContent = 'Kapitelliste wird geladen und mit vorhandenen CBZs verglichen.';
  }
  if (event.type === 'site-series-ready') {
    $('#siteDownloadProgress').textContent = `${event.current}/${event.total}: ${event.title} · ${event.missing || 0} fehlend · ${event.existing || 0} vorhanden`;
    $('#siteDownloadMeta').textContent = event.missing ? 'Fehlende Kapitel werden jetzt nacheinander als CBZ heruntergeladen.' : 'Serie ist bereits vollständig vorhanden.';
  }
  if (event.type === 'site-series-language-skip') {
    $('#siteDownloadProgress').textContent = `${event.current}/${event.total}: ${event.title} · wegen Sprache übersprungen`;
    $('#siteDownloadMeta').textContent = event.reason || (event.language ? `${languageName(event.language)} ist nicht freigegeben.` : 'Sprache konnte nicht sicher erkannt werden.');
  }
  if (event.type === 'site-series-status-skip') {
    $('#siteDownloadProgress').textContent = `${event.current}/${event.total}: ${event.title} · ${seriesStatusName(event.status)} übersprungen`;
    $('#siteDownloadMeta').textContent = event.reason || `${seriesStatusName(event.status)} ist im Statusfilter ausgeblendet.`;
  }
  if (event.type === 'site-chapter-start') {
    $('#siteDownloadProgress').textContent = `${event.seriesCurrent}/${event.seriesTotal}: ${event.title} · ${event.chapterCurrent}/${event.chapterTotal} · ${event.chapterTitle}`;
  }
  if (event.type === 'site-chapter-done') {
    $('#siteDownloadMeta').textContent = `${event.chapterTitle} fertig · ${event.downloaded}/${event.total} neue Kapitel dieser Serie geladen.`;
  }
  if (event.type === 'site-chapter-error') {
    $('#siteDownloadPanel').classList.add('error');
    $('#siteDownloadMeta').textContent = `${event.chapterTitle}: ${event.message}`;
  }
  if (event.type === 'site-series-error') {
    $('#siteDownloadPanel').classList.add('error');
    $('#siteDownloadProgress').textContent = `${event.current}/${event.total}: ${event.title} konnte nicht verarbeitet werden.`;
    $('#siteDownloadMeta').textContent = event.message || 'Unbekannter Fehler';
  }
  if (event.type === 'site-download-paused') {
    siteDownloadPaused = true; $('#siteDownloadPanel').classList.add('paused'); updateSiteDownloadControls();
    $('#siteDownloadMeta').textContent = 'Pausiert. Bereits laufende Einzelanfrage darf noch abschließen.';
  }
  if (event.type === 'site-download-resumed') {
    siteDownloadPaused = false; $('#siteDownloadPanel').classList.remove('paused'); updateSiteDownloadControls();
    $('#siteDownloadMeta').textContent = 'Download wird fortgesetzt …';
  }
  if (event.type === 'site-download-cancel-requested') $('#siteDownloadMeta').textContent = 'Abbruch angefordert …';
  if (event.type === 'site-download-done') {
    $('#siteDownloadProgress').textContent = `${event.checkedSeries || 0}/${event.totalSeries || 0} Serien · ${event.downloadedChapters || 0} neu · ${event.alreadyDownloaded || 0} vorhanden${event.skippedLanguageSeries ? ` · ${event.skippedLanguageSeries} Sprache` : ''}${event.skippedStatusSeries ? ` · ${event.skippedStatusSeries} Status` : ''}${event.canceled ? ' · abgebrochen' : ''}`;
  }
  if (event.type === 'resolve-pages-start') {
    downloadActivity.set(String(event.chapterId), { type: 'resolve', text: 'Reader-Seiten werden gesucht …' });
    $('#catalogChapterState').textContent = `${event.chapterTitle || 'Kapitel'}: Reader-Seiten werden gesucht …`;
    renderCatalogChapters();
  }
  if (event.type === 'resolve-pages-done') {
    downloadActivity.set(String(event.chapterId), { type: 'download', text: `${event.pageCount || 0} Seiten gefunden · Download startet …` });
    $('#catalogChapterState').textContent = `${event.chapterTitle || 'Kapitel'}: ${event.pageCount || 0} Seiten gefunden.`;
    renderCatalogChapters();
  }
  if (event.type === 'chapter-start' && !event.bulk) {
    downloadActivity.set(String(event.chapterId), { type: 'download', text: `0/${event.total || 0} Seiten · wird heruntergeladen …` });
    renderCatalogChapters();
  }
  if (event.type === 'page-done' && !event.bulk) {
    downloadActivity.set(String(event.chapterId), { type: 'download', text: `${event.current}/${event.total} Seiten heruntergeladen …` });
    setStatus(`Download: Seite ${event.current}/${event.total}`); renderCatalogChapters();
  }
  if (event.type === 'download-error') {
    downloadActivity.set(String(event.chapterId), { type: 'error', message: event.message || 'Unbekannter Fehler' });
    $('#catalogChapterState').textContent = `Downloadfehler: ${event.message || 'Unbekannter Fehler'}`; renderCatalogChapters();
  }
  if (event.type === 'chapter-done' && !event.bulk) { downloadActivity.delete(String(event.chapterId)); setStatus('Kapitel vollständig heruntergeladen.'); await refreshDownloads(); renderCatalogChapters(); await render(); }
  if (event.type === 'check-error') { setStatus(`Prüffehler: ${event.message}`); await render(); }
});

Promise.all([loadAppVersion(), loadSettings(), renderConnectors(), refreshWebsites(), refreshDownloads(), refreshQueue(), refreshPhoneSync(), refreshReadingList(), refreshNewsButton()]).then(async () => { renderCatalogChapters(); updateSiteDownloadControls(); await render(); }).catch((error) => setStatus(`Startfehler: ${error.message}`));
