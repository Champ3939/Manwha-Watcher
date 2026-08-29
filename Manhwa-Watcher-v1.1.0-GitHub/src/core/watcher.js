const { evaluateLanguage, languageLabel } = require('./languageFilter');
const { normalizeSeriesStatus, seriesStatusLabel, isSeriesStatusAllowed } = require('./seriesStatus');
class Watcher {
  constructor({ store, connectors, downloader, phoneSync = null, onEvent = () => {} }) {
    this.store = store; this.connectors = connectors; this.downloader = downloader; this.phoneSync = phoneSync; this.onEvent = onEvent;
    this.timer = null; this.running = false;
  }

  configure() {
    this.stop();
    const settings = this.store.getSettings();
    if (!settings.autoCheck) return;
    const ms = Math.max(1, Number(settings.checkIntervalMinutes) || 30) * 60_000;
    this.timer = setInterval(() => this.checkAll().catch(() => {}), ms);
  }
  stop() { if (this.timer) clearInterval(this.timer); this.timer = null; }

  async checkSeries(seriesId, { autoDownload = true } = {}) {
    const series = this.store.getSeries(seriesId);
    if (!series) throw new Error('Serie nicht gefunden.');
    const connector = this.connectors.getById(series.connectorId);
    if (!connector) throw new Error(`Connector nicht verfügbar: ${series.connectorId}`);
    this.onEvent({ type: 'check-start', seriesId });
    try {
      const settings = this.store.getSettings();
      let info = null;
      try { info = await connector.getSeriesInfo(series.url); } catch {}
      const detectedStatus = normalizeSeriesStatus(info?.status || series.status);
      if (!isSeriesStatusAllowed(detectedStatus, settings)) {
        const updated = this.store.updateSeries(seriesId, { status: detectedStatus, lastCheckedAt: new Date().toISOString(), lastError: null });
        this.onEvent({ type: 'check-done', seriesId, newChapterCount: 0, skippedStatus: detectedStatus });
        return { series: updated, newChapters: [], skippedStatus: detectedStatus, skippedStatusLabel: seriesStatusLabel(detectedStatus) };
      }
      const remote = Array.isArray(info?.chapters) && info.chapters.length ? info.chapters : await connector.getChapters(series);
      const oldById = new Map((series.chapters || []).map((chapter) => [String(chapter.id), chapter]));
      const merged = remote.map((chapter) => {
        const old = oldById.get(String(chapter.id));
        return { ...chapter, downloaded: Boolean(old?.downloaded) };
      });
      const newChapters = merged.filter((chapter) => !oldById.has(String(chapter.id)));
      const updated = this.store.updateSeries(seriesId, { chapters: merged, status: detectedStatus, language: info?.language || series.language || null, lastCheckedAt: new Date().toISOString(), lastError: null });
      this.onEvent({ type: 'check-done', seriesId, newChapterCount: newChapters.length });
      if (autoDownload && updated.autoDownload && newChapters.length) {
        for (const chapter of newChapters) await this.download(seriesId, chapter.id);
      }
      return { series: this.store.getSeries(seriesId), newChapters };
    } catch (error) {
      this.store.updateSeries(seriesId, { lastCheckedAt: new Date().toISOString(), lastError: error.message });
      throw error;
    }
  }

  async download(seriesId, chapterId) {
    const series = this.store.getSeries(seriesId);
    if (!series) throw new Error('Serie nicht gefunden.');
    const chapter = (series.chapters || []).find((item) => String(item.id) === String(chapterId));
    if (!chapter) throw new Error('Kapitel nicht gefunden.');
    if (chapter.downloaded) return null;
    const connector = this.connectors.getById(series.connectorId);
    if (!connector) throw new Error(`Connector nicht verfügbar: ${series.connectorId}`);
    const settings = this.store.getSettings();
    let languageCheck = evaluateLanguage([chapter, series], settings);
    if (!languageCheck.allowed && !languageCheck.language && settings.languageFilterEnabled !== false) {
      try {
        const fresh = await connector.getSeriesInfo(series.url);
        languageCheck = evaluateLanguage([chapter, fresh, series], settings);
        if (fresh?.language && !series.language) this.store.updateSeries(seriesId, { language: fresh.language });
      } catch {}
    }
    if (!languageCheck.allowed) {
      const label = languageCheck.language ? languageLabel(languageCheck.language) : 'unbekannte Sprache';
      throw new Error(`Sprachfilter: ${label} wird nicht heruntergeladen. Erlaubt sind Englisch und Deutsch.`);
    }
    this.onEvent({ type: 'resolve-pages-start', seriesId, chapterId, chapterTitle: chapter.title, seriesTitle: series.title });
    const pages = await connector.getPages(series, chapter);
    this.onEvent({ type: 'resolve-pages-done', seriesId, chapterId, pageCount: pages.length, chapterTitle: chapter.title, seriesTitle: series.title });
    const download = await this.downloader.enqueue({ series, chapter, pages, root: settings.downloadRoot });
    const record = this.store.markDownloaded({ seriesTitle: series.title, seriesUrl: series.url, chapterId: chapter.id, chapterTitle: chapter.title, chapterUrl: chapter.url, folder: download.folder, file: download.file, format: download.format, pageCount: download.pageCount || pages.length });
    if (this.phoneSync) {
      try { await this.phoneSync.syncRecord(record); }
      catch (error) { this.onEvent({ type: 'phone-sync-file-error', title: series.title, chapterTitle: chapter.title, message: error.message }); }
    }
    const latest = this.store.getSeries(seriesId);
    const chapters = latest.chapters.map((item) => String(item.id) === String(chapterId) ? { ...item, downloaded: true } : item);
    this.store.updateSeries(seriesId, { chapters, lastError: null });
    return download;
  }

  async checkAll() {
    if (this.running) return { skipped: true };
    this.running = true;
    this.onEvent({ type: 'check-all-start' });
    try {
      for (const series of this.store.listSeries()) {
        try { await this.checkSeries(series.id); }
        catch (error) { this.onEvent({ type: 'check-error', seriesId: series.id, message: error.message }); }
      }
      return { skipped: false };
    } finally {
      this.running = false;
      this.onEvent({ type: 'check-all-done' });
    }
  }
}

module.exports = Watcher;
