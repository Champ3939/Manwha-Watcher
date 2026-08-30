const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('manhwaAPI', {
  getAppVersion: () => ipcRenderer.invoke('app:get-version'),
  listSeries: () => ipcRenderer.invoke('library:list'),
  addSeries: (url) => ipcRenderer.invoke('library:add', url),
  removeSeries: (id) => ipcRenderer.invoke('library:remove', id),
  updateSeries: (id, patch) => ipcRenderer.invoke('library:update', id, patch),
  checkSeries: (id) => ipcRenderer.invoke('series:check', id),
  checkAll: () => ipcRenderer.invoke('series:check-all'),
  scanUpdates: () => ipcRenderer.invoke('updates:scan'),
  startSiteDownload: (data) => ipcRenderer.invoke('site-download:start', data),
  getSiteDownloadStatus: () => ipcRenderer.invoke('site-download:status'),
  pauseSiteDownload: () => ipcRenderer.invoke('site-download:pause'),
  resumeSiteDownload: () => ipcRenderer.invoke('site-download:resume'),
  cancelSiteDownload: () => ipcRenderer.invoke('site-download:cancel'),
  downloadChapter: (seriesId, chapterId) => ipcRenderer.invoke('chapter:download', seriesId, chapterId),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSettings: (patch) => ipcRenderer.invoke('settings:set', patch),
  chooseDownloadFolder: () => ipcRenderer.invoke('settings:choose-folder'),
  setDownloadFolder: (folder) => ipcRenderer.invoke('settings:set-download-folder', folder),
  openDownloadFolder: () => ipcRenderer.invoke('settings:open-folder'),
  getPhoneSyncStatus: () => ipcRenderer.invoke('sync:status'),
  listPhoneSyncSeries: () => ipcRenderer.invoke('sync:list-series'),
  choosePhoneSyncFolder: () => ipcRenderer.invoke('sync:choose-folder'),
  openPhoneSyncFolder: () => ipcRenderer.invoke('sync:open-folder'),
  togglePhoneSyncSeries: (data) => ipcRenderer.invoke('sync:toggle-series', data),
  runPhoneSync: () => ipcRenderer.invoke('sync:run'),
  listWebsites: () => ipcRenderer.invoke('websites:list'),
  addWebsite: (data) => ipcRenderer.invoke('websites:add', data),
  updateWebsite: (id, data) => ipcRenderer.invoke('websites:update', id, data),
  removeWebsite: (id) => ipcRenderer.invoke('websites:remove', id),
  listReadingList: (mode = 'all') => ipcRenderer.invoke('reading-list:list', mode),
  getReadingListEntry: (url) => ipcRenderer.invoke('reading-list:get', url),
  setReadingListEntry: (data) => ipcRenderer.invoke('reading-list:set', data),
  listOnlineLibrary: (options = {}) => ipcRenderer.invoke('online-library:list', options),
  getOnlineLibraryEntry: (url) => ipcRenderer.invoke('online-library:get', url),
  setOnlineLibraryEntry: (data) => ipcRenderer.invoke('online-library:set', data),
  removeOnlineLibraryEntry: (url) => ipcRenderer.invoke('online-library:remove', url),
  markOnlineLibraryRead: (data) => ipcRenderer.invoke('online-library:mark-read', data),
  markOnlineLibraryUnread: (data) => ipcRenderer.invoke('online-library:mark-unread', data),
  openReader: (url) => ipcRenderer.invoke('reader:open', url),
  openChapterReader: (data) => ipcRenderer.invoke('reader:open-chapter', data),
  listNews: (options = {}) => ipcRenderer.invoke('news:list', options),
  getNewsSummary: () => ipcRenderer.invoke('news:summary'),
  markNewsSeen: (options = {}) => ipcRenderer.invoke('news:mark-seen', options),
  listDownloads: (limit = 500) => ipcRenderer.invoke('downloads:list', limit),
  openDownloadedFolder: (folder) => ipcRenderer.invoke('downloads:open-folder', folder),
  showDownloadedFile: (file) => ipcRenderer.invoke('downloads:show-file', file),
  listQueue: (limit = 300) => ipcRenderer.invoke('queue:list', limit),
  retryQueueItem: (id) => ipcRenderer.invoke('queue:retry', id),
  clearFinishedQueue: () => ipcRenderer.invoke('queue:clear-finished'),
  getLibraryHealthStatus: () => ipcRenderer.invoke('library-health:status'),
  scanLibraryHealth: (options = {}) => ipcRenderer.invoke('library-health:scan', options),
  openLibraryPath: (targetPath) => ipcRenderer.invoke('library-health:open-path', targetPath),
  retryLibraryFile: (file) => ipcRenderer.invoke('library-health:retry-file', file),
  repairLibraryProblems: () => ipcRenderer.invoke('library-health:repair-all'),
  getScheduleStatus: () => ipcRenderer.invoke('schedule:status'),
  runScheduledScanNow: () => ipcRenderer.invoke('schedule:run-now'),
  exportBackup: () => ipcRenderer.invoke('backup:export'),
  restoreBackup: () => ipcRenderer.invoke('backup:restore'),
  listConnectors: () => ipcRenderer.invoke('connectors:list'),
  reloadConnectors: () => ipcRenderer.invoke('connectors:reload'),
  openConnectorFolder: () => ipcRenderer.invoke('connectors:open-folder'),
  browserSelfTest: () => ipcRenderer.invoke('browser:self-test'),
  clearBrowserData: () => ipcRenderer.invoke('browser:clear-data'),
  restartBrowser: (fallbackUrl) => ipcRenderer.invoke('browser:restart', fallbackUrl),
  labLoad: (url) => ipcRenderer.invoke('lab:load', url),
  labSetBrowserVisible: (visible, fallbackUrl) => ipcRenderer.invoke('lab:browser-visible', visible, fallbackUrl),
  labOpenDevTools: () => ipcRenderer.invoke('lab:devtools'),
  labAnalyze: (data) => ipcRenderer.invoke('lab:analyze', data),
  catalogDiscover: (data) => ipcRenderer.invoke('catalog:discover', data),
  catalogRefreshStatuses: (data) => ipcRenderer.invoke('catalog:refresh-statuses', data),
  catalogDebugStatus: (url) => ipcRenderer.invoke('catalog:debug-status', url),
  catalogOpenSeries: (url) => ipcRenderer.invoke('catalog:open-series', url),
  catalogWatchSeries: (url) => ipcRenderer.invoke('catalog:watch-series', url),
  catalogDownloadChapters: (data) => ipcRenderer.invoke('catalog:download-chapters', data),
  labPickElement: (data) => ipcRenderer.invoke('lab:pick-element', data),
  labHighlight: (data) => ipcRenderer.invoke('lab:highlight', data),
  labClearHighlights: () => ipcRenderer.invoke('lab:clear-highlights'),
  labTestTitle: (data) => ipcRenderer.invoke('lab:test-title', data),
  labTestChapters: (data) => ipcRenderer.invoke('lab:test-chapters', data),
  labTestPages: (data) => ipcRenderer.invoke('lab:test-pages', data),
  labSaveRecipe: (data) => ipcRenderer.invoke('lab:save-recipe', data),
  labDetect: (url) => ipcRenderer.invoke('lab:detect', url),
  getDebugLog: () => ipcRenderer.invoke('debug:list'),
  clearDebugLog: () => ipcRenderer.invoke('debug:clear'),
  openDebugFolder: () => ipcRenderer.invoke('debug:open-folder'),
  rendererLog: (level, message, details = null) => ipcRenderer.send('debug:renderer', { level, message, details }),
  onEvent: (callback) => {
    const handler = (_event, payload) => callback(payload);
    ipcRenderer.on('app:event', handler);
    return () => ipcRenderer.removeListener('app:event', handler);
  }
});

// v1.1.2: Inject the renderer pagination layer defensively. Dynamic scripts
// execute in the normal renderer world, where app.js state and functions are
// available. The readyState fallback also works if DOMContentLoaded already ran.
function loadPaginationLayer() {
  if (document.querySelector('script[data-mw-pagination]')) return;
  const script = document.createElement('script');
  script.dataset.mwPagination = '1';
  script.src = new URL('pagination.js', document.baseURI).href;
  script.addEventListener('load', () => ipcRenderer.send('debug:renderer', { level: 'info', message: 'Pagination-Script geladen', details: { src: script.src } }));
  script.addEventListener('error', () => ipcRenderer.send('debug:renderer', { level: 'error', message: 'Pagination-Script konnte nicht geladen werden', details: { src: script.src } }));
  (document.body || document.head || document.documentElement).appendChild(script);
}

if (document.readyState === 'loading') window.addEventListener('DOMContentLoaded', loadPaginationLayer, { once: true });
else loadPaginationLayer();
