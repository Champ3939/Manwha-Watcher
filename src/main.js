const path = require('path');
const fs = require('fs');
const { app, BrowserWindow, ipcMain, dialog, shell, Notification } = require('electron');
const Store = require('./core/store');
const Logger = require('./core/logger');
const BrowserService = require('./core/browserService');
const ConnectorManager = require('./core/connectorManager');
const GenericManifestConnector = require('./connectors/genericManifest');
const DemoConnector = require('./connectors/demo');
const AutoDetectConnector = require('./connectors/autoDetect');
const RecipeLoader = require('./connectors/recipeLoader');
const Downloader = require('./core/downloader');
const { scanSeriesDownloads } = require('./core/downloadStatus');
const Watcher = require('./core/watcher');
const { UpdateScanner } = require('./core/updateScanner');
const { SiteDownloader } = require('./core/siteDownloader');
const { PhoneSync } = require('./core/phoneSync');
const { BackupManager } = require('./core/backupManager');
const { UpdateScheduler } = require('./core/updateScheduler');
const { LibraryHealth } = require('./core/libraryHealth');
const { LibraryRepair } = require('./core/libraryRepair');
const { evaluateLanguage, languageLabel } = require('./core/languageFilter');
const { normalizeSeriesStatus, seriesStatusLabel, isSeriesStatusAllowed } = require('./core/seriesStatus');

let mainWindow, store, logger, browserService, connectors, recipeLoader, downloader, watcher, updateScanner, updateScheduler, siteDownloader, phoneSync, backupManager, libraryHealth, libraryRepair;

function getDataDir() {
  if (process.env.PORTABLE_EXECUTABLE_DIR) return path.join(process.env.PORTABLE_EXECUTABLE_DIR, 'Manhwa-Watcher-Data');
  if (process.platform === 'win32') return path.join(path.dirname(process.execPath), 'Manhwa-Watcher-Data');
  if (!app.isPackaged) return path.join(__dirname, '..', 'data');
  return path.join(app.getPath('userData'), 'data');
}

function emit(payload) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('app:event', payload);
  if (payload.type === 'chapter-done' && !payload.bulk && store?.getSettings().notifications && Notification.isSupported()) {
    new Notification({ title: 'Manhwa Watcher', body: `${payload.seriesTitle} – ${payload.chapterTitle} heruntergeladen.` }).show();
  }
  if (payload.type === 'scheduled-update-done' && store?.getSettings().notifications && Notification.isSupported()) {
    const count = Number(payload.summary?.downloadedChapters || 0);
    if (count > 0) new Notification({ title: 'Manhwa Watcher – Updates', body: `${count} neue Kapitel wurden automatisch heruntergeladen.` }).show();
  }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    title: `Manhwa Watcher v${app.getVersion()}`,
    width: 1240, height: 880, minWidth: 960, minHeight: 680,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true }
  });
  mainWindow.setMenuBarVisibility(false);
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}

function unsupportedMessage(url) {
  let domain = url;
  try { domain = new URL(url).hostname; } catch {}
  return `Quelle noch nicht unterstützt. Domain: ${domain}. Öffne das Connector-Labor, erstelle einen passenden Connector und lade ihn anschließend neu.`;
}

function sameUrl(a, b) {
  try {
    const ua = new URL(String(a || '')); const ub = new URL(String(b || ''));
    ua.hash = ''; ub.hash = '';
    return ua.href.replace(/\/$/, '') === ub.href.replace(/\/$/, '');
  } catch { return String(a || '').replace(/\/$/, '') === String(b || '').replace(/\/$/, ''); }
}

function canonicalUrlKey(value) {
  try {
    const u = new URL(String(value || ''));
    u.hash = '';
    return u.href.replace(/\/$/, '');
  } catch {
    return String(value || '').trim().replace(/\/$/, '');
  }
}

function toCsvList(value, fallback = []) {
  if (Array.isArray(value)) return value.map(String).map((v) => v.trim()).filter(Boolean);
  const list = String(value || '').split(',').map((v) => v.trim()).filter(Boolean);
  return list.length ? list : fallback;
}

function normalizeDomain(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  try { return new URL(raw.includes('://') ? raw : `https://${raw}`).hostname.toLowerCase().replace(/^www\./, ''); }
  catch { return raw.toLowerCase().replace(/^www\./, ''); }
}

function buildRecipe(input) {
  const domain = normalizeDomain(input.domain || input.url);
  return {
    $schema: 'manhwa-watcher-web-recipe-v1',
    id: String(input.id || '').trim(),
    label: String(input.label || input.id || '').trim(),
    domains: [domain].filter(Boolean),
    timeoutMs: Math.max(3000, Math.min(120000, Number(input.timeoutMs) || 30000)),
    settleMs: Math.max(0, Math.min(10000, Number(input.settleMs) || 400)),
    series: { titleSelector: String(input.titleSelector || '').trim() || undefined },
    chapters: {
      selector: String(input.chapterSelector || '').trim(),
      titleSelector: String(input.chapterTitleSelector || '').trim() || undefined,
      urlSelector: String(input.chapterUrlSelector || '').trim() || undefined,
      urlAttributes: toCsvList(input.chapterUrlAttributes, ['href']),
      numberRegex: String(input.numberRegex || '').trim() || undefined,
      order: String(input.chapterOrder || 'number-asc')
    },
    pages: {
      selector: String(input.pageSelector || '').trim(),
      urlSelector: String(input.pageUrlSelector || '').trim() || undefined,
      urlAttributes: toCsvList(input.pageUrlAttributes, ['src', 'data-src', 'data-lazy-src', 'data-original']),
      waitForSelector: String(input.pageWaitForSelector || '').trim() || undefined
    }
  };
}

function registerIpc(connectorDir) {
  ipcMain.handle('app:get-version', () => app.getVersion());
  ipcMain.handle('library:list', () => store.listSeries());
  ipcMain.handle('library:add', async (_event, rawUrl) => {
    const url = String(rawUrl || '').trim();
    const connector = connectors.getForUrl(url);
    if (!connector) throw new Error(unsupportedMessage(url));
    logger.info('Serie wird hinzugefügt', { url, connector: connector.id });
    const info = await connector.getSeriesInfo(url);
    return store.addSeries(info);
  });
  ipcMain.handle('library:remove', (_event, id) => store.removeSeries(id));
  ipcMain.handle('library:update', (_event, id, patch) => store.updateSeries(id, patch));
  ipcMain.handle('series:check', async (_event, id) => {
    logger.info('Manuelle Serienprüfung gestartet', { seriesId: id });
    return watcher.checkSeries(id, { autoDownload: false });
  });
  ipcMain.handle('series:check-all', () => watcher.checkAll());
  ipcMain.handle('updates:scan', async () => {
    logger.info('Manueller Update-Scan angefordert');
    return updateScanner.scanAndUpdate();
  });
  ipcMain.handle('site-download:start', async (_event, data) => {
    logger.info('Kompletter Katalog-Download angefordert', { url: String(data?.url || ''), suppliedItems: Array.isArray(data?.items) ? data.items.length : 0 });
    return siteDownloader.start({ url: data?.url, items: data?.items });
  });
  ipcMain.handle('site-download:status', () => siteDownloader.status());
  ipcMain.handle('site-download:pause', () => siteDownloader.pause());
  ipcMain.handle('site-download:resume', () => siteDownloader.resume());
  ipcMain.handle('site-download:cancel', () => siteDownloader.cancel());
  ipcMain.handle('chapter:download', (_event, seriesId, chapterId) => watcher.download(seriesId, chapterId));
  ipcMain.handle('settings:get', () => store.getSettings());
  ipcMain.handle('settings:set', (_event, patch) => { const settings = store.setSettings(patch); watcher.configure(); updateScheduler?.configure(); return settings; });
  function setDownloadRoot(rawPath) {
    const folder = path.resolve(String(rawPath || '').trim());
    if (!String(rawPath || '').trim()) throw new Error('Bitte einen Downloadordner auswählen oder eingeben.');
    fs.mkdirSync(folder, { recursive: true });
    const testFile = path.join(folder, `.manhwa-watcher-write-test-${process.pid}-${Date.now()}`);
    try {
      fs.writeFileSync(testFile, 'ok', 'utf8');
      fs.rmSync(testFile, { force: true });
    } catch (error) {
      try { fs.rmSync(testFile, { force: true }); } catch {}
      throw new Error(`Der Ordner ist nicht beschreibbar: ${error.message}`);
    }
    const settings = store.setSettings({ downloadRoot: folder });
    logger.info('Downloadordner geändert', { downloadRoot: folder });
    return settings;
  }
  ipcMain.handle('settings:choose-folder', async () => {
    const current = String(store.getSettings().downloadRoot || '').trim();
    if (mainWindow && !mainWindow.isDestroyed()) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
    const options = {
      title: 'Downloadordner für Manhwa Watcher auswählen',
      buttonLabel: 'Diesen Ordner verwenden',
      defaultPath: current || app.getPath('downloads'),
      properties: ['openDirectory', 'createDirectory']
    };
    // Ohne Parent öffnen: Auf Windows kann ein parented Dialog hinter einem sichtbaren
    // Browser-/DevTools-Fenster landen und wirkt dann so, als würde der Button nichts tun.
    const result = await dialog.showOpenDialog(options);
    if (result.canceled || !result.filePaths[0]) return null;
    return setDownloadRoot(result.filePaths[0]);
  });
  ipcMain.handle('settings:set-download-folder', (_event, rawPath) => setDownloadRoot(rawPath));
  ipcMain.handle('settings:open-folder', async () => { const folder = store.getSettings().downloadRoot; fs.mkdirSync(folder, { recursive: true }); return shell.openPath(folder); });
  ipcMain.handle('sync:status', () => phoneSync.status());
  ipcMain.handle('sync:list-series', () => store.listSyncSeries());
  ipcMain.handle('sync:choose-folder', async () => {
    const result = await dialog.showOpenDialog(mainWindow, { title: 'Handy-Sync-Ordner auswählen', properties: ['openDirectory', 'createDirectory'] });
    if (result.canceled || !result.filePaths[0]) return phoneSync.status();
    store.setSettings({ syncRoot: result.filePaths[0] });
    logger.info('Handy-Sync-Ordner geändert', { syncRoot: result.filePaths[0] });
    return phoneSync.status();
  });
  ipcMain.handle('sync:open-folder', async () => {
    const folder = String(store.getSettings().syncRoot || '').trim();
    if (!folder) throw new Error('Noch kein Handy-Sync-Ordner ausgewählt.');
    fs.mkdirSync(folder, { recursive: true });
    return shell.openPath(folder);
  });
  ipcMain.handle('sync:toggle-series', async (_event, data) => {
    const url = String(data?.url || '').trim();
    const title = String(data?.title || '').trim();
    const enabled = Boolean(data?.enabled);
    if (!url) throw new Error('Serien-URL fehlt.');
    logger.info('Handy-Sync für Serie geändert', { url, title, enabled });
    return phoneSync.setSeriesEnabled({ url, title, enabled });
  });
  ipcMain.handle('sync:run', async () => {
    logger.info('Manueller Handy-Sync angefordert');
    return phoneSync.syncAll();
  });
  ipcMain.handle('websites:list', () => store.listWebsites());
  ipcMain.handle('websites:add', (_event, input) => {
    const item = store.addWebsite(input || {});
    logger.info('Webseite gespeichert', { id: item.id, name: item.name, url: item.url });
    return item;
  });
  ipcMain.handle('websites:update', (_event, id, patch) => {
    const item = store.updateWebsite(String(id || ''), patch || {});
    logger.info('Gespeicherte Webseite geändert', { id: item.id, name: item.name, url: item.url });
    return item;
  });
  ipcMain.handle('websites:remove', (_event, id) => {
    const removed = store.removeWebsite(String(id || ''));
    if (removed) logger.info('Gespeicherte Webseite entfernt', { id: String(id || '') });
    return removed;
  });
  ipcMain.handle('reading-list:list', (_event, mode) => store.listReadingList({ mode: String(mode || 'all') }));
  ipcMain.handle('reading-list:get', (_event, url) => store.getReadingListEntry(String(url || '')));
  ipcMain.handle('reading-list:set', (_event, data) => store.setReadingList(data || {}));
  ipcMain.handle('online-library:list', (_event, options) => store.listOnlineLibrary({ query: String(options?.query || ''), limit: Number(options?.limit) || 10000 }));
  ipcMain.handle('online-library:get', (_event, url) => store.getOnlineLibraryEntry(String(url || '')));
  ipcMain.handle('online-library:set', (_event, data) => store.setOnlineLibrary(data || {}));
  ipcMain.handle('online-library:remove', (_event, url) => store.removeOnlineLibrary(String(url || '')));
  ipcMain.handle('online-library:mark-read', (_event, data) => store.markOnlineLibraryRead(String(data?.seriesUrl || ''), { id: data?.chapterId || null, title: data?.chapterTitle || null, url: data?.chapterUrl || null }));
  ipcMain.handle('online-library:mark-unread', (_event, data) => store.markOnlineLibraryUnread(String(data?.seriesUrl || ''), { id: data?.chapterId || null, title: data?.chapterTitle || null, url: data?.chapterUrl || null }));
  ipcMain.handle('reader:open', async (_event, rawUrl) => {
    const url = String(rawUrl || '').trim();
    if (!/^https?:\/\//i.test(url)) throw new Error('Ungültige Reader-URL.');
    logger.info('Online-Reader wird geöffnet', { url });
    return browserService.openLockedReader(url);
  });
  ipcMain.handle('reader:open-chapter', async (_event, data) => {
    const seriesUrl = String(data?.seriesUrl || '').trim();
    const chapterId = String(data?.chapterId || '').trim();
    const candidateUrl = String(data?.chapterUrl || '').trim();
    if (!seriesUrl || !chapterId) throw new Error('Serie oder Kapitel fehlt.');
    const connector = connectors.getForUrl(seriesUrl);
    if (!connector) throw new Error(unsupportedMessage(seriesUrl));

    // Resolve the chapter again from the source every time. Some sites mutate the
    // visible reader page or redirect the embedded browser after it has been open;
    // reusing a stale URL can therefore open a different title on the second click.
    const info = await connector.getSeriesInfo(seriesUrl);
    const chapters = Array.isArray(info?.chapters) ? info.chapters : [];
    let chapter = chapters.find((entry) => String(entry.id) === chapterId);
    if (!chapter && candidateUrl) chapter = chapters.find((entry) => entry?.url && sameUrl(entry.url, candidateUrl));
    if (!chapter) {
      const wantedTitle = String(data?.chapterTitle || '').trim().toLowerCase();
      if (wantedTitle) chapter = chapters.find((entry) => String(entry?.title || '').trim().toLowerCase() === wantedTitle);
    }
    if (!chapter?.url) throw new Error('Kapitel wurde auf der Serienseite nicht mehr gefunden. Bitte die Serie neu laden.');

    logger.info('Online-Reader: Kapitel frisch aufgelöst', {
      seriesUrl, chapterId, requestedUrl: candidateUrl || null, resolvedUrl: chapter.url, title: chapter.title
    });
    const opened = await browserService.openLockedReader(chapter.url);
    return { ...opened, chapterId: String(chapter.id), chapterTitle: chapter.title || data?.chapterTitle || `Chapter ${chapterId}`, url: opened?.url || chapter.url };
  });
  ipcMain.handle('news:list', (_event, options) => ({ items: store.listNews({ latestOnly: options?.latestOnly !== false, limit: Number(options?.limit) || 300 }), summary: store.getNewsSummary() }));
  ipcMain.handle('news:summary', () => store.getNewsSummary());
  ipcMain.handle('news:mark-seen', (_event, options) => store.markNewsSeen({ latestOnly: options?.latestOnly !== false }));
  ipcMain.handle('downloads:list', (_event, limit) => store.listDownloads({ limit: Number(limit) || 500 }));
  ipcMain.handle('downloads:open-folder', async (_event, folder) => {
    const target = String(folder || '').trim();
    if (!target) throw new Error('Kein Downloadordner gespeichert.');
    if (!fs.existsSync(target)) throw new Error('Der gespeicherte Downloadordner existiert nicht mehr.');
    return shell.openPath(target);
  });
  ipcMain.handle('downloads:show-file', async (_event, file) => {
    const target = String(file || '').trim();
    if (!target) throw new Error('Keine CBZ-Datei gespeichert.');
    if (!fs.existsSync(target)) throw new Error('Die gespeicherte CBZ-Datei existiert nicht mehr.');
    shell.showItemInFolder(target);
    return true;
  });
  ipcMain.handle('queue:list', (_event, limit) => downloader.listQueue({ limit: Number(limit) || 300 }));
  ipcMain.handle('queue:retry', (_event, id) => { downloader.retryQueueItem(String(id || '')).catch((error) => logger.error('Queue-Retry fehlgeschlagen', { id: String(id || ''), message: error.message })); return { queued: true }; });
  ipcMain.handle('queue:clear-finished', () => downloader.clearFinishedQueue());
  ipcMain.handle('library-health:status', () => libraryHealth.status());
  ipcMain.handle('library-health:scan', async (_event, options) => libraryHealth.scan({ deep: Boolean(options?.deep) }));
  ipcMain.handle('library-health:open-path', async (_event, targetPath) => {
    const target = String(targetPath || '').trim();
    if (!target) throw new Error('Kein Pfad angegeben.');
    if (!fs.existsSync(target)) throw new Error('Der Pfad existiert nicht mehr.');
    const stat = fs.statSync(target);
    if (stat.isFile()) { shell.showItemInFolder(target); return true; }
    return shell.openPath(target);
  });
  ipcMain.handle('library-health:retry-file', async (_event, rawFile) => {
    const raw = String(rawFile || '').trim();
    if (!raw) throw new Error('Keine CBZ-Datei angegeben.');
    const target = path.resolve(raw);
    const record = store.listDownloads({ limit: 5000 }).find((item) => item?.file && path.resolve(item.file) === target);
    if (!record) throw new Error('Für diese Datei wurde kein Downloadverlauf gefunden.');
    if (!record.seriesUrl) throw new Error('Im Downloadverlauf fehlt die Serien-URL.');
    const connector = connectors.getForUrl(record.seriesUrl) || connectors.getForUrl(record.chapterUrl || '');
    if (!connector) throw new Error(unsupportedMessage(record.seriesUrl));
    logger.info('Bibliotheksprüfung: erneuter Download angefordert', { file: raw, series: record.seriesTitle, chapter: record.chapterTitle });
    const info = await connector.getSeriesInfo(record.seriesUrl);
    const chapter = (info.chapters || []).find((item) =>
      (record.chapterId && String(item.id) === String(record.chapterId)) ||
      (record.chapterUrl && item.url && sameUrl(record.chapterUrl, item.url)) ||
      (record.chapterTitle && String(item.title || '').trim() === String(record.chapterTitle).trim())
    );
    if (!chapter) throw new Error('Das Kapitel wurde auf der Quelle nicht mehr gefunden.');
    const jobSeries = { ...info, id: `repair:${connector.id}:${record.seriesUrl}` };
    const pages = await connector.getPages(jobSeries, chapter);
    if (!Array.isArray(pages) || !pages.length) throw new Error('Keine Reader-Seiten erkannt.');
    const settings = store.getSettings();
    downloader.enqueue({ series: jobSeries, chapter, pages, root: settings.downloadRoot }).then(async (download) => {
      const saved = store.markDownloaded({ ...record, seriesTitle: info.title || record.seriesTitle, seriesUrl: info.url || record.seriesUrl, chapterId: chapter.id, chapterTitle: chapter.title, chapterUrl: chapter.url, folder: download.folder, file: download.file, format: download.format, pageCount: download.pageCount || pages.length, downloadedAt: new Date().toISOString() });
      try { await phoneSync.syncRecord(saved); } catch (syncError) { logger.error('Handy-Sync nach Reparaturdownload fehlgeschlagen', { message: syncError.message }); }
      emit({ type: 'library-repair-done', file: download.file, seriesTitle: info.title || record.seriesTitle, chapterTitle: chapter.title });
    }).catch((error) => {
      logger.error('Bibliotheksprüfung: Reparaturdownload fehlgeschlagen', { file: raw, message: error.message });
      emit({ type: 'library-repair-error', file: raw, message: error.message, seriesTitle: record.seriesTitle, chapterTitle: record.chapterTitle });
    });
    return { queued: true, seriesTitle: info.title || record.seriesTitle, chapterTitle: chapter.title, pageCount: pages.length };
  });
  ipcMain.handle('library-health:repair-all', async () => {
    const current = libraryHealth.status().lastResult;
    const scan = current?.deep ? current : await libraryHealth.scan({ deep: true });
    if (!scan?.library?.problems?.length) return { total: 0, checked: 0, fixed: 0, failed: 0, skipped: 0, connectorFallbacks: 0, results: [] };
    return libraryRepair.repair(scan);
  });
  ipcMain.handle('schedule:status', () => updateScheduler.status());
  ipcMain.handle('schedule:run-now', () => updateScheduler.run('manual-schedule'));
  ipcMain.handle('backup:export', async () => {
    const stamp = new Date().toISOString().slice(0, 10);
    const result = await dialog.showSaveDialog(mainWindow, {
      title: 'Manhwa-Watcher-Backup speichern',
      defaultPath: path.join(app.getPath('documents'), `Manhwa-Watcher-Backup-${stamp}.zip`),
      filters: [{ name: 'ZIP-Backup', extensions: ['zip'] }]
    });
    if (result.canceled || !result.filePath) return null;
    const file = /\.zip$/i.test(result.filePath) ? result.filePath : `${result.filePath}.zip`;
    return backupManager.exportTo(file);
  });
  ipcMain.handle('backup:restore', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'Manhwa-Watcher-Backup wiederherstellen',
      properties: ['openFile'],
      filters: [{ name: 'Manhwa-Watcher-Backup', extensions: ['zip'] }]
    });
    if (result.canceled || !result.filePaths[0]) return null;
    const restored = backupManager.restoreFrom(result.filePaths[0]);
    store.load();
    connectors.reload();
    watcher.configure();
    updateScheduler.configure();
    emit({ type: 'backup-restored', file: restored.file });
    return { ...restored, settings: store.getSettings() };
  });
  ipcMain.handle('connectors:list', () => connectors.diagnostics());
  ipcMain.handle('connectors:reload', () => {
    const result = connectors.reload();
    logger.info('Connectoren neu geladen', { count: result.length, errors: connectors.errors.length });
    return result;
  });
  ipcMain.handle('connectors:open-folder', async () => { fs.mkdirSync(connectorDir, { recursive: true }); return shell.openPath(connectorDir); });
  ipcMain.handle('browser:self-test', () => browserService.selfTest());
  ipcMain.handle('browser:clear-data', () => browserService.clearSiteData());
  ipcMain.handle('browser:restart', (_event, fallbackUrl) => {
    logger.info('IPC browser:restart empfangen', { fallbackUrl: String(fallbackUrl || '') || null });
    return browserService.restartWindow({ reloadLast: true, fallbackUrl: String(fallbackUrl || '').trim() || null });
  });

  ipcMain.handle('lab:load', async (_event, url) => {
    const target = String(url || '').trim();
    logger.info('IPC lab:load empfangen', { url: target });
    if (!/^https?:\/\//i.test(target) && !/^data:/i.test(target)) throw new Error('Bitte eine http://- oder https://-URL eingeben.');
    try {
      const result = await browserService.inspectPage(target, { settleMs: 450, timeoutMs: 30000 });
      logger.info('Connector-Labor: Seite geladen', result);
      return result;
    } catch (error) {
      logger.error('Connector-Labor: Seite konnte nicht geladen werden', { url: target, message: error.message });
      throw error;
    }
  });
  ipcMain.handle('lab:browser-visible', (_event, visible, fallbackUrl) => {
    logger.info('IPC lab:browser-visible empfangen', { visible: Boolean(visible), fallbackUrl: String(fallbackUrl || '') || null });
    return browserService.setVisible(Boolean(visible), { fallbackUrl: String(fallbackUrl || '').trim() || null });
  });
  ipcMain.handle('lab:devtools', () => browserService.openDevTools());
  ipcMain.handle('catalog:discover', async (_event, data) => {
    const url = String(data?.url || '').trim();
    const force = Boolean(data?.force);
    logger.info('Serien-Katalog: vollständige Analyse gestartet', { url, force });
    const result = await browserService.discoverSeries({ url, settleMs: 600, limit: 10000, maxPages: 60, force });
    const statusCache = new Map(store.listSeriesStatuses().map((entry) => [canonicalUrlKey(entry.seriesUrl), entry]));
    const items = (result?.items || []).map((item) => {
      const cachedStatus = statusCache.get(canonicalUrlKey(item.url));
      const detected = normalizeSeriesStatus(item.status);
      if (detected !== 'unknown') return item;
      return cachedStatus ? { ...item, status: normalizeSeriesStatus(cachedStatus.status), statusSource: cachedStatus.source || 'cache', statusUpdatedAt: cachedStatus.updatedAt || null } : item;
    });
    const enriched = { ...result, items, count: items.length };
    logger.info('Serien-Katalog: vollständige Analyse beendet', {
      requestedUrl: url,
      catalogUrl: enriched?.pageUrl || url,
      count: enriched?.count || 0,
      pagesScanned: enriched?.pagesScanned || 0,
      scannedLinks: enriched?.scannedLinks || 0,
      cached: Boolean(enriched?.cached),
      statusCacheHits: items.filter((item) => item.statusSource === 'cache').length
    });
    return enriched;
  });
  ipcMain.handle('catalog:debug-status', async (_event, rawUrl) => {
    const url = String(rawUrl || '').trim();
    if (!url) throw new Error('Keine Serien-URL für Status-Debug angegeben.');
    logger.info('Status-Debug gestartet', { url });
    return browserService.debugSeriesStatus(url, { timeoutMs: 30000 });
  });
  ipcMain.handle('catalog:refresh-statuses', async (_event, data) => {
    const items = (Array.isArray(data?.items) ? data.items : []).slice(0, 10000);
    const force = Boolean(data?.force);
    const catalogUrl = String(data?.catalogUrl || '').trim() || null;
    if (!items.length) return { checked: 0, updated: 0, unknown: 0, statuses: [] };
    logger.info('Katalog-Statusprüfung gestartet', { items: items.length, force, catalogUrl });
    emit({ type: 'catalog-status-start', total: items.length });

    const output = new Array(items.length);
    let cursor = 0;
    let checked = 0;
    let updated = 0;
    const workers = Math.min(3, items.length);
    const work = async () => {
      while (true) {
        const index = cursor++;
        if (index >= items.length) return;
        const item = items[index] || {};
        const url = String(item.url || '').trim();
        const title = String(item.title || url);
        let status = normalizeSeriesStatus(item.status);
        let source = 'catalog';
        let error = null;
        try {
          const currentStatus = normalizeSeriesStatus(item.status);
          const cached = !force ? store.getSeriesStatus(url) : null;
          if (!force && currentStatus !== 'unknown') {
            status = currentStatus;
            source = item.statusSource || 'catalog';
          } else if (cached && normalizeSeriesStatus(cached.status) !== 'unknown') {
            status = normalizeSeriesStatus(cached.status);
            source = cached.source || 'cache';
          } else {
            const result = await browserService.discoverSeriesStatus(url, { referer: catalogUrl, timeoutMs: 20000 });
            status = normalizeSeriesStatus(result?.status);
            source = result?.source || 'series-page';
            store.setSeriesStatus(url, status, { title, source });
            if (status !== 'unknown') updated += 1;
          }
        } catch (err) {
          error = err.message;
          logger.debug?.('Katalog-Statusprüfung für Serie fehlgeschlagen', { url, title, message: err.message });
        }
        checked += 1;
        output[index] = { url, title, status, source, error };
        emit({ type: 'catalog-status-progress', current: checked, total: items.length, title, url, status, source, error });
        await new Promise((resolve) => setTimeout(resolve, 120));
      }
    };
    await Promise.all(Array.from({ length: workers }, () => work()));
    const unknown = output.filter((item) => normalizeSeriesStatus(item?.status) === 'unknown').length;
    emit({ type: 'catalog-status-done', total: items.length, checked, updated, unknown });
    logger.info('Katalog-Statusprüfung beendet', { checked, updated, unknown });
    return { checked, updated, unknown, statuses: output.filter(Boolean) };
  });
  ipcMain.handle('catalog:open-series', async (_event, rawUrl) => {
    const url = String(rawUrl || '').trim();
    const connector = connectors.getForUrl(url);
    if (!connector) throw new Error(unsupportedMessage(url));
    logger.info('Katalog: Serie wird geöffnet', { url, connector: connector.id });
    const info = await connector.getSeriesInfo(url);
    if (normalizeSeriesStatus(info.status) !== 'unknown') store.setSeriesStatus(info.url || url, normalizeSeriesStatus(info.status), { title: info.title, source: 'series-open' });
    const watched = store.listSeries().find((item) => sameUrl(item.url, info.url) || sameUrl(item.url, url)) || null;
    const downloadedById = new Map((watched?.chapters || []).map((chapter) => [String(chapter.id), Boolean(chapter.downloaded)]));
    const history = store.findDownloadsForSeries(info.url || url);
    const diskScan = scanSeriesDownloads(store.getSettings().downloadRoot, info.title, info.chapters || []);
    let diskDetected = 0;
    const series = {
      ...info,
      chapters: (info.chapters || []).map((chapter) => {
        const record = history.find((item) => String(item.chapterId) === String(chapter.id) || (item.chapterUrl && chapter.url && sameUrl(item.chapterUrl, chapter.url)));
        const disk = diskScan.matches.get(String(chapter.id)) || null;
        const historyExists = Boolean(record && ((!record.file && record.folder && fs.existsSync(record.folder)) || (record.file && fs.existsSync(record.file))));
        const downloaded = Boolean(downloadedById.get(String(chapter.id)) || historyExists || disk);
        if (disk) {
          diskDetected += 1;
          if (!record || (disk.file && record.file !== disk.file) || (!disk.file && record.folder !== disk.folder)) {
            store.markDownloaded({
              seriesTitle: info.title,
              seriesUrl: info.url || url,
              chapterId: chapter.id,
              chapterTitle: chapter.title,
              chapterUrl: chapter.url,
              folder: disk.folder,
              file: disk.file,
              format: disk.format,
              pageCount: record?.pageCount || 0,
              downloadedAt: record?.downloadedAt || new Date().toISOString()
            });
          }
        }
        const source = disk || (historyExists ? record : null);
        return {
          ...chapter,
          downloaded,
          downloadFolder: source?.folder || null,
          downloadFile: source?.file || null,
          downloadFormat: source?.format || null,
          downloadedAt: source?.downloadedAt || record?.downloadedAt || null,
          detectedFromDisk: Boolean(disk)
        };
      })
    };
    const downloadedCount = series.chapters.filter((chapter) => chapter.downloaded).length;
    logger.info('Katalog: Downloadstatus abgeglichen', { title: info.title, chapters: series.chapters.length, downloaded: downloadedCount, diskDetected });
    return { series, connector: connector.describe?.() || { id: connector.id, label: connector.label }, watched: Boolean(watched), watchedId: watched?.id || null, downloadedCount, diskDetected, syncEnabled: phoneSync.isSeriesEnabled(info.url || url) };
  });
  ipcMain.handle('catalog:watch-series', async (_event, rawUrl) => {
    const url = String(rawUrl || '').trim();
    const connector = connectors.getForUrl(url);
    if (!connector) throw new Error(unsupportedMessage(url));
    const info = await connector.getSeriesInfo(url);
    const item = store.addSeries(info);
    logger.info('Katalog: Serie zur Beobachtung hinzugefügt', { url, title: item.title, connector: item.connectorId });
    return item;
  });
  ipcMain.handle('catalog:download-chapters', async (_event, data) => {
    const url = String(data?.url || '').trim();
    const requested = new Set((Array.isArray(data?.chapterIds) ? data.chapterIds : []).map((id) => String(id)));
    if (!requested.size) throw new Error('Keine Kapitel ausgewählt.');
    const connector = connectors.getForUrl(url);
    if (!connector) throw new Error(unsupportedMessage(url));
    logger.info('Katalog: Direkter Download vorbereitet', { url, count: requested.size, connector: connector.id });
    const info = await connector.getSeriesInfo(url);
    const selected = (info.chapters || []).filter((chapter) => requested.has(String(chapter.id)));
    if (!selected.length) throw new Error('Die ausgewählten Kapitel wurden nicht mehr gefunden. Bitte die Serie neu laden.');
    const settings = store.getSettings();
    const seriesStatus = normalizeSeriesStatus(info.status);
    if (!isSeriesStatusAllowed(seriesStatus, settings)) {
      throw new Error(`Statusfilter: ${seriesStatusLabel(seriesStatus)} ist aktuell ausgeblendet.`);
    }
    const seriesLanguage = evaluateLanguage(info, settings);
    if (!seriesLanguage.allowed) {
      const label = seriesLanguage.language ? languageLabel(seriesLanguage.language) : 'unbekannte Sprache';
      throw new Error(`Sprachfilter: ${label} wird nicht heruntergeladen. Erlaubt sind Englisch und Deutsch.`);
    }
    const blockedByLanguage = [];
    const allowedSelected = selected.filter((chapter) => {
      const check = evaluateLanguage([chapter, info], settings);
      if (check.allowed) return true;
      blockedByLanguage.push({ id: String(chapter.id), title: chapter.title, language: check.language || null });
      return false;
    });
    if (!allowedSelected.length) throw new Error('Sprachfilter: Keines der ausgewählten Kapitel ist Englisch oder Deutsch.');
    const jobSeries = { ...info, id: `catalog:${connector.id}:${url}` };
    const results = [];
    const errors = blockedByLanguage.map((chapter) => ({ id: chapter.id, title: chapter.title, message: `Sprachfilter: ${chapter.language ? languageLabel(chapter.language) : 'unbekannte Sprache'} übersprungen.` }));
    logger.info('Katalog: Direkter Download gestartet', { title: info.title, count: selected.length, connector: connector.id });
    for (const chapter of allowedSelected) {
      try {
        emit({ type: 'resolve-pages-start', seriesId: jobSeries.id, chapterId: chapter.id, chapterTitle: chapter.title, seriesTitle: info.title });
        logger.info('Katalog: Reader-Seiten werden ermittelt', { title: info.title, chapter: chapter.title, url: chapter.url });
        const pages = await connector.getPages(jobSeries, chapter);
        if (!Array.isArray(pages) || !pages.length) throw new Error('Keine Reader-Seiten erkannt.');
        emit({ type: 'resolve-pages-done', seriesId: jobSeries.id, chapterId: chapter.id, chapterTitle: chapter.title, seriesTitle: info.title, pageCount: pages.length });
        logger.info('Katalog: Reader-Seiten erkannt', { title: info.title, chapter: chapter.title, pages: pages.length });
        const download = await downloader.enqueue({ series: jobSeries, chapter, pages, root: settings.downloadRoot });
        const record = store.markDownloaded({ seriesTitle: info.title, seriesUrl: info.url || url, chapterId: chapter.id, chapterTitle: chapter.title, chapterUrl: chapter.url, folder: download.folder, file: download.file, format: download.format, pageCount: download.pageCount || pages.length });
        try { await phoneSync.syncRecord(record); }
        catch (syncError) { logger.error('Handy-Sync nach Direktdownload fehlgeschlagen', { title: info.title, chapter: chapter.title, message: syncError.message }); }
        results.push({ id: String(chapter.id), title: chapter.title, folder: download.folder, file: download.file, format: download.format, pageCount: download.pageCount || pages.length });
      } catch (error) {
        const message = String(error?.message || error || 'Unbekannter Downloadfehler');
        errors.push({ id: String(chapter.id), title: chapter.title, message });
        logger.error('Katalog: Kapitel-Download fehlgeschlagen', { title: info.title, chapter: chapter.title, message });
        emit({ type: 'download-error', seriesId: jobSeries.id, chapterId: chapter.id, chapterTitle: chapter.title, seriesTitle: info.title, message });
      }
    }
    const watched = store.listSeries().find((item) => sameUrl(item.url, info.url) || sameUrl(item.url, url));
    if (watched && results.length) {
      const done = new Set(results.map((item) => String(item.id)));
      const chapters = (watched.chapters || []).map((chapter) => done.has(String(chapter.id)) ? { ...chapter, downloaded: true } : chapter);
      store.updateSeries(watched.id, { chapters, lastError: errors.length ? errors[0].message : null });
    }
    logger.info('Katalog: Direkter Download beendet', { title: info.title, downloaded: results.length, errors: errors.length });
    return { title: info.title, results, errors };
  });
  ipcMain.handle('lab:analyze', async (_event, data) => {
    const url = String(data?.url || '').trim() || null;
    logger.info('Connector-Labor: DOM-Analyse gestartet', { url });
    const result = await browserService.analyzeSelectors({ url, settleMs: 500 });
    logger.info('Connector-Labor: DOM-Analyse beendet', {
      titleCandidates: result?.titles?.length || 0,
      chapterCandidates: result?.chapters?.length || 0,
      pageCandidates: result?.pages?.length || 0
    });
    return result;
  });
  ipcMain.handle('lab:pick-element', async (_event, data) => {
    const mode = ['title', 'chapters', 'pages'].includes(data?.mode) ? data.mode : 'generic';
    const url = String(data?.url || '').trim() || null;
    logger.info('Connector-Labor: Element-Picker angefordert', { mode, url });
    return browserService.pickElement({ url, mode, timeoutMs: 90000 });
  });
  ipcMain.handle('lab:highlight', async (_event, data) => {
    return browserService.highlightSelector({
      url: String(data?.url || '').trim() || null,
      selector: String(data?.selector || '').trim(),
      limit: Number(data?.limit) || 80
    });
  });
  ipcMain.handle('lab:clear-highlights', () => browserService.clearHighlights());
  ipcMain.handle('lab:test-title', async (_event, data) => {
    const selector = String(data?.selector || '').trim();
    const result = await browserService.testSelector({ url: data?.url || null, selector, limit: 5 });
    logger.info('Connector-Labor: Titel-Selektor getestet', { selector, count: result.count });
    return result;
  });
  ipcMain.handle('lab:test-chapters', async (_event, data) => {
    const result = await browserService.testSelector({
      url: data?.url || null,
      selector: String(data?.selector || '').trim(),
      textSelector: String(data?.titleSelector || '').trim() || null,
      urlSelector: String(data?.urlSelector || '').trim() || null,
      urlAttributes: toCsvList(data?.urlAttributes, ['href']),
      limit: 50
    });
    logger.info('Connector-Labor: Kapitel-Selektor getestet', { selector: data?.selector, count: result.count });
    return result;
  });
  ipcMain.handle('lab:test-pages', async (_event, data) => {
    const result = await browserService.testSelector({
      url: data?.url || null,
      selector: String(data?.selector || '').trim(),
      urlSelector: String(data?.urlSelector || '').trim() || null,
      urlAttributes: toCsvList(data?.urlAttributes, ['src', 'data-src', 'data-lazy-src', 'data-original']),
      limit: 80
    });
    logger.info('Connector-Labor: Seiten-Selektor getestet', { selector: data?.selector, count: result.count });
    return result;
  });
  ipcMain.handle('lab:save-recipe', (_event, input) => {
    const recipe = buildRecipe(input || {});
    const saved = recipeLoader.save(recipe, { overwrite: Boolean(input?.overwrite) });
    const settings = store.getSettings();
    const repairedDomains = new Set((Array.isArray(recipe.domains) ? recipe.domains : []).map((domain) => String(domain).toLowerCase().replace(/^www\./, '')));
    const currentOverrides = Array.isArray(settings.connectorAutoDetectDomains) ? settings.connectorAutoDetectDomains : [];
    const nextOverrides = currentOverrides.filter((domain) => !repairedDomains.has(String(domain).toLowerCase().replace(/^www\./, '')));
    if (nextOverrides.length !== currentOverrides.length) store.setSettings({ connectorAutoDetectDomains: nextOverrides });
    connectors.reload();
    logger.info('Connector aus Labor gespeichert', { id: recipe.id, domains: recipe.domains, file: saved.file, autoDetectOverrideRemoved: nextOverrides.length !== currentOverrides.length });
    return { recipe, diagnostics: connectors.diagnostics() };
  });
  ipcMain.handle('lab:detect', (_event, rawUrl) => {
    const url = String(rawUrl || '').trim();
    let hostname = '';
    try { hostname = new URL(url).hostname.toLowerCase().replace(/^www\./, ''); } catch {}
    const connector = connectors.getForUrl(url);
    return { hostname, connector: connector?.describe?.() || null };
  });

  ipcMain.on('debug:renderer', (_event, payload) => {
    const level = ['info', 'warn', 'error'].includes(payload?.level) ? payload.level : 'info';
    logger[level](`Renderer: ${String(payload?.message || 'Ereignis')}`, payload?.details ?? null);
  });
  ipcMain.handle('debug:list', () => logger.list());
  ipcMain.handle('debug:clear', () => logger.clear());
  ipcMain.handle('debug:open-folder', () => shell.openPath(logger.logDir));
}

app.whenReady().then(() => {
  const dataDir = getDataDir();
  const connectorDir = path.join(dataDir, 'Connectors');
  store = new Store(dataDir);
  logger = new Logger(dataDir);
  browserService = new BrowserService({ onEvent: emit, logger });
  recipeLoader = new RecipeLoader(connectorDir, browserService);
  connectors = new ConnectorManager([
    new DemoConnector(),
    new GenericManifestConnector((url, options) => browserService.fetchJson(url, options)),
    new AutoDetectConnector(browserService)
  ], recipeLoader, { getAutoDetectDomains: () => store.getSettings().connectorAutoDetectDomains || [] });
  downloader = new Downloader((url, options) => browserService.fetchBinary(url, options), emit, () => store.getSettings());
  phoneSync = new PhoneSync({ store, logger, onEvent: emit });
  watcher = new Watcher({ store, connectors, downloader, onEvent: (event) => {
    if (event.type === 'check-error') logger.error('Serienprüfung fehlgeschlagen', { seriesId: event.seriesId, message: event.message });
    emit(event);
  }, phoneSync });
  updateScanner = new UpdateScanner({ store, connectors, downloader, phoneSync, logger, onEvent: emit });
  updateScheduler = new UpdateScheduler({ store, scanner: updateScanner, logger, onEvent: emit });
  backupManager = new BackupManager({ dataDir, connectorDir, store, logger, appVersion: app.getVersion() });
  libraryHealth = new LibraryHealth({ store, logger, onEvent: emit });
  libraryRepair = new LibraryRepair({ store, connectors, downloader, phoneSync, logger, onEvent: emit });
  siteDownloader = new SiteDownloader({ store, connectors, browserService, downloader, phoneSync, logger, onEvent: emit });
  registerIpc(connectorDir);
  createWindow();
  watcher.configure();
  updateScheduler.configure({ initial: true });
  logger.info(`Manhwa Watcher v${app.getVersion()} gestartet`, { dataDir });
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on('before-quit', () => { watcher?.stop(); updateScheduler?.stop(); browserService?.destroy(); store?.close?.(); });
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
