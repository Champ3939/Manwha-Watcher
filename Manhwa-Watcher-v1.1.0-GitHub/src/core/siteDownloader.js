const fs = require('fs');
const { scanSeriesDownloads } = require('./downloadStatus');
const { evaluateLanguage, languageLabel } = require('./languageFilter');
const { normalizeSeriesStatus, seriesStatusLabel, isSeriesStatusAllowed } = require('./seriesStatus');

function sameUrl(a, b) {
  try {
    const ua = new URL(String(a || '')); const ub = new URL(String(b || ''));
    ua.hash = ''; ub.hash = '';
    return ua.href.replace(/\/$/, '') === ub.href.replace(/\/$/, '');
  } catch { return String(a || '').replace(/\/$/, '') === String(b || '').replace(/\/$/, ''); }
}

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

class SiteDownloader {
  constructor({ store, connectors, browserService, downloader, phoneSync = null, logger, onEvent = () => {} }) {
    this.store = store;
    this.connectors = connectors;
    this.browserService = browserService;
    this.downloader = downloader;
    this.phoneSync = phoneSync;
    this.logger = logger;
    this.onEvent = onEvent;
    this.running = false;
    this.paused = false;
    this.cancelRequested = false;
    this.current = null;
  }

  status() {
    return {
      running: this.running,
      paused: this.paused,
      cancelRequested: this.cancelRequested,
      current: this.current ? { ...this.current } : null
    };
  }

  pause() {
    if (!this.running) return this.status();
    this.paused = true;
    this.onEvent({ type: 'site-download-paused' });
    return this.status();
  }

  resume() {
    if (!this.running) return this.status();
    this.paused = false;
    this.onEvent({ type: 'site-download-resumed' });
    return this.status();
  }

  cancel() {
    if (!this.running) return this.status();
    this.cancelRequested = true;
    this.paused = false;
    this.onEvent({ type: 'site-download-cancel-requested' });
    return this.status();
  }

  async waitIfPaused() {
    while (this.paused && !this.cancelRequested) await sleep(250);
  }

  isExistingDownload(record) {
    if (!record) return false;
    if (record.file) {
      try { return fs.statSync(record.file).isFile() && fs.statSync(record.file).size > 22; } catch { return false; }
    }
    if (record.folder) {
      try { return fs.statSync(record.folder).isDirectory(); } catch { return false; }
    }
    return false;
  }

  async start({ url, items = null } = {}) {
    if (this.running) return { skipped: true, reason: 'already-running', ...this.status() };
    const target = String(url || '').trim();
    if (!/^https?:\/\//i.test(target)) throw new Error('Bitte eine gültige Webseiten-/Katalog-URL angeben.');

    this.running = true;
    this.paused = false;
    this.cancelRequested = false;
    this.current = null;

    const summary = {
      requestedUrl: target,
      totalSeries: 0,
      checkedSeries: 0,
      completedSeries: 0,
      skippedSeries: 0,
      skippedLanguageSeries: 0,
      skippedLanguageChapters: 0,
      skippedStatusSeries: 0,
      totalChapters: 0,
      alreadyDownloaded: 0,
      downloadedChapters: 0,
      failedChapters: 0,
      errors: 0,
      canceled: false,
      series: []
    };

    try {
      let catalogItems = Array.isArray(items) && items.length
        ? items.map((item) => ({ title: String(item.title || '').trim(), url: String(item.url || '').trim(), cover: item.cover || null, status: normalizeSeriesStatus(item.status) })).filter((item) => item.url)
        : null;
      if (!catalogItems?.length) {
        this.onEvent({ type: 'site-download-catalog-start', url: target });
        const catalog = await this.browserService.discoverSeries({ url: target, settleMs: 600, limit: 20000, maxPages: 120, force: false });
        catalogItems = catalog.items || [];
      }
      // Deduplicate catalog entries by normalized URL.
      const deduped = [];
      const seen = new Set();
      for (const item of catalogItems) {
        let key = String(item.url || '').trim().replace(/\/$/, '');
        if (!key || seen.has(key)) continue;
        seen.add(key); deduped.push(item);
      }
      catalogItems = deduped;
      summary.totalSeries = catalogItems.length;
      this.onEvent({ type: 'site-download-start', url: target, totalSeries: summary.totalSeries });
      this.logger?.info('Kompletter Katalog-Download gestartet', { url: target, totalSeries: summary.totalSeries });

      const settings = this.store.getSettings();
      for (let index = 0; index < catalogItems.length; index += 1) {
        await this.waitIfPaused();
        if (this.cancelRequested) { summary.canceled = true; break; }

        const catalogItem = catalogItems[index];
        const row = { title: catalogItem.title || catalogItem.url, url: catalogItem.url, language: catalogItem.language || null, seriesStatus: normalizeSeriesStatus(catalogItem.status), chapters: 0, missing: 0, downloaded: 0, skipped: 0, languageSkipped: 0, failed: 0, status: 'checking', errors: [] };
        summary.series.push(row);
        this.current = { seriesIndex: index + 1, totalSeries: summary.totalSeries, title: row.title, url: row.url, chapterIndex: 0, totalChapters: 0 };
        this.onEvent({ type: 'site-series-start', current: index + 1, total: summary.totalSeries, title: row.title, url: row.url });

        try {
          if (!isSeriesStatusAllowed(row.seriesStatus, settings)) {
            row.status = 'status-skip';
            row.statusReason = `${seriesStatusLabel(row.seriesStatus)} ist im Statusfilter ausgeblendet`;
            summary.skippedSeries += 1;
            summary.skippedStatusSeries += 1;
            summary.checkedSeries += 1;
            this.logger?.info('Kompletter Katalog: Serie durch Statusfilter übersprungen', { title: row.title, url: row.url, status: row.seriesStatus });
            this.onEvent({ type: 'site-series-status-skip', current: index + 1, total: summary.totalSeries, title: row.title, url: row.url, status: row.seriesStatus, reason: row.statusReason });
            continue;
          }
          const connector = this.connectors.getForUrl(catalogItem.url);
          if (!connector) throw new Error(`Kein Connector für ${catalogItem.url}`);
          const info = await connector.getSeriesInfo(catalogItem.url);
          row.title = info.title || row.title;
          row.seriesStatus = normalizeSeriesStatus(info.status || row.seriesStatus);
          if (!isSeriesStatusAllowed(row.seriesStatus, settings)) {
            row.status = 'status-skip';
            row.statusReason = `${seriesStatusLabel(row.seriesStatus)} ist im Statusfilter ausgeblendet`;
            summary.skippedSeries += 1;
            summary.skippedStatusSeries += 1;
            summary.checkedSeries += 1;
            this.logger?.info('Kompletter Katalog: Serie nach Detailprüfung durch Statusfilter übersprungen', { title: row.title, url: row.url, status: row.seriesStatus });
            this.onEvent({ type: 'site-series-status-skip', current: index + 1, total: summary.totalSeries, title: row.title, url: row.url, status: row.seriesStatus, reason: row.statusReason });
            continue;
          }
          const seriesLanguage = evaluateLanguage([info, catalogItem], settings);
          row.language = seriesLanguage.language || null;
          if (!seriesLanguage.allowed) {
            row.status = 'language-skip';
            row.languageReason = seriesLanguage.language ? `${languageLabel(seriesLanguage.language)} ist nicht freigegeben` : 'Sprache konnte nicht sicher erkannt werden';
            summary.skippedSeries += 1;
            summary.skippedLanguageSeries += 1;
            summary.checkedSeries += 1;
            this.logger?.info('Kompletter Katalog: Serie durch Sprachfilter übersprungen', { title: row.title, url: row.url, language: seriesLanguage.language, reason: seriesLanguage.reason });
            this.onEvent({ type: 'site-series-language-skip', current: index + 1, total: summary.totalSeries, title: row.title, url: row.url, language: seriesLanguage.language, reason: row.languageReason });
            continue;
          }
          const chapters = Array.isArray(info.chapters) ? info.chapters : [];
          row.chapters = chapters.length;
          summary.totalChapters += chapters.length;

          const history = this.store.findDownloadsForSeries(info.url || catalogItem.url);
          const disk = scanSeriesDownloads(settings.downloadRoot, info.title, chapters);
          const missing = [];
          for (const chapter of chapters) {
            const chapterLanguage = evaluateLanguage([chapter, info], settings);
            if (!chapterLanguage.allowed) {
              row.languageSkipped += 1;
              summary.skippedLanguageChapters += 1;
              continue;
            }
            const record = history.find((item) => String(item.chapterId) === String(chapter.id) || (item.chapterUrl && chapter.url && sameUrl(item.chapterUrl, chapter.url)));
            const onDisk = disk.matches.get(String(chapter.id));
            if (onDisk || this.isExistingDownload(record)) {
              row.skipped += 1;
              summary.alreadyDownloaded += 1;
              continue;
            }
            missing.push(chapter);
          }
          row.missing = missing.length;
          this.current.totalChapters = missing.length;
          this.onEvent({ type: 'site-series-ready', current: index + 1, total: summary.totalSeries, title: row.title, url: row.url, chapters: chapters.length, missing: missing.length, existing: row.skipped });

          if (!missing.length) {
            row.status = 'complete';
            summary.skippedSeries += 1;
            summary.checkedSeries += 1;
            this.onEvent({ type: 'site-series-done', current: index + 1, total: summary.totalSeries, ...row });
            continue;
          }

          const jobSeries = { ...info, id: `site:${connector.id}:${info.url || catalogItem.url}` };
          for (let chapterIndex = 0; chapterIndex < missing.length; chapterIndex += 1) {
            await this.waitIfPaused();
            if (this.cancelRequested) { summary.canceled = true; break; }
            const chapter = missing[chapterIndex];
            this.current.chapterIndex = chapterIndex + 1;
            this.current.chapterTitle = chapter.title;
            this.onEvent({ type: 'site-chapter-start', seriesCurrent: index + 1, seriesTotal: summary.totalSeries, title: row.title, chapterCurrent: chapterIndex + 1, chapterTotal: missing.length, chapterTitle: chapter.title, chapterId: chapter.id });
            try {
              const pages = await connector.getPages(jobSeries, chapter);
              if (!Array.isArray(pages) || !pages.length) throw new Error('Keine Reader-Seiten erkannt.');
              const download = await this.downloader.enqueue({ series: jobSeries, chapter, pages, root: settings.downloadRoot, bulk: true });
              const record = this.store.markDownloaded({
                seriesTitle: info.title,
                seriesUrl: info.url || catalogItem.url,
                chapterId: chapter.id,
                chapterTitle: chapter.title,
                chapterUrl: chapter.url,
                folder: download.folder,
                file: download.file,
                format: download.format,
                pageCount: download.pageCount || pages.length
              });
              if (this.phoneSync) {
                try { await this.phoneSync.syncRecord(record); }
                catch (error) { this.logger?.error('Handy-Sync nach Katalog-Download fehlgeschlagen', { title: row.title, chapter: chapter.title, message: error.message }); }
              }
              row.downloaded += 1;
              summary.downloadedChapters += 1;
              this.onEvent({ type: 'site-chapter-done', title: row.title, chapterTitle: chapter.title, downloaded: row.downloaded, total: missing.length, file: download.file });
            } catch (error) {
              const message = String(error?.message || error || 'Unbekannter Downloadfehler');
              row.failed += 1;
              row.errors.push({ chapter: chapter.title, message });
              summary.failedChapters += 1;
              summary.errors += 1;
              this.logger?.error('Kompletter Katalog: Kapitel fehlgeschlagen', { title: row.title, chapter: chapter.title, message });
              this.onEvent({ type: 'site-chapter-error', title: row.title, chapterTitle: chapter.title, message });
            }
          }

          row.status = this.cancelRequested ? 'canceled' : (row.failed ? 'partial' : 'complete');
          summary.checkedSeries += 1;
          if (!this.cancelRequested) summary.completedSeries += 1;
          this.onEvent({ type: 'site-series-done', current: index + 1, total: summary.totalSeries, ...row });
          if (this.cancelRequested) { summary.canceled = true; break; }
        } catch (error) {
          const message = String(error?.message || error || 'Unbekannter Serienfehler');
          row.status = 'error'; row.errors.push({ message });
          summary.checkedSeries += 1; summary.errors += 1;
          this.logger?.error('Kompletter Katalog: Serie fehlgeschlagen', { title: row.title, url: row.url, message });
          this.onEvent({ type: 'site-series-error', current: index + 1, total: summary.totalSeries, title: row.title, url: row.url, message });
        }
      }

      this.onEvent({ type: 'site-download-done', ...summary });
      this.logger?.info('Kompletter Katalog-Download beendet', {
        url: target,
        totalSeries: summary.totalSeries,
        checkedSeries: summary.checkedSeries,
        downloadedChapters: summary.downloadedChapters,
        alreadyDownloaded: summary.alreadyDownloaded,
        failedChapters: summary.failedChapters,
        canceled: summary.canceled
      });
      return summary;
    } finally {
      this.running = false;
      this.paused = false;
      this.cancelRequested = false;
      this.current = null;
    }
  }
}

module.exports = { SiteDownloader };
