const fs = require('fs');
const { scanSeriesDownloads } = require('./downloadStatus');
const { evaluateLanguage, languageLabel } = require('./languageFilter');
const { normalizeSeriesStatus, seriesStatusLabel, isSeriesStatusAllowed } = require('./seriesStatus');

function normUrl(value) {
  try {
    const u = new URL(String(value || ''));
    u.hash = '';
    return u.href.replace(/\/$/, '');
  } catch {
    return String(value || '').trim().replace(/\/$/, '');
  }
}

function chapterNumber(chapter) {
  const direct = Number(chapter?.number);
  if (Number.isFinite(direct)) return direct;
  const text = `${chapter?.title || ''} ${chapter?.id || ''}`;
  const specific = text.match(/(?:chapter|chap(?:ter)?|ch\.?|episode|ep\.?)\s*#?[-:]?\s*(\d+(?:[.,]\d+)?)/i);
  if (specific) return Number(String(specific[1]).replace(',', '.'));
  const generic = String(chapter?.title || chapter?.id || '').match(/(?:^|\D)(\d+(?:[.,]\d+)?)(?:\D|$)/);
  return generic ? Number(String(generic[1]).replace(',', '.')) : null;
}

function chapterKey(chapter) {
  if (chapter?.url) return `url:${normUrl(chapter.url)}`;
  return `id:${String(chapter?.id ?? '')}`;
}

function recordMatchesChapter(record, chapter) {
  if (!record || !chapter) return false;
  if (String(record.chapterId ?? '') && String(record.chapterId ?? '') === String(chapter.id ?? '')) return true;
  return Boolean(record.chapterUrl && chapter.url && normUrl(record.chapterUrl) === normUrl(chapter.url));
}

function existingRecordUsable(record) {
  if (!record) return false;
  if (record.file) {
    try { return fs.statSync(record.file).isFile(); } catch {}
  }
  if (record.folder) {
    try { return fs.statSync(record.folder).isDirectory(); } catch {}
  }
  return false;
}

class UpdateScanner {
  constructor({ store, connectors, downloader, phoneSync = null, onEvent = () => {}, logger = null }) {
    this.store = store;
    this.connectors = connectors;
    this.downloader = downloader;
    this.phoneSync = phoneSync;
    this.onEvent = onEvent;
    this.logger = logger;
    this.running = false;
  }

  collectSeries() {
    const map = new Map();
    for (const watched of this.store.listSeries()) {
      if (!watched?.url) continue;
      const key = normUrl(watched.url);
      map.set(key, {
        url: watched.url,
        title: watched.title || watched.url,
        connectorId: watched.connectorId || null,
        watched,
        history: []
      });
    }
    for (const record of this.store.listDownloads({ limit: 5000 })) {
      if (!record?.seriesUrl) continue;
      const key = normUrl(record.seriesUrl);
      const item = map.get(key) || {
        url: record.seriesUrl,
        title: record.seriesTitle || record.seriesUrl,
        connectorId: null,
        watched: null,
        history: []
      };
      item.history.push(record);
      if (!item.title && record.seriesTitle) item.title = record.seriesTitle;
      map.set(key, item);
    }
    return [...map.values()].filter((item) => item.watched || item.history.length);
  }

  determineNewChapters(item, remoteChapters, diskMatches) {
    const history = item.history?.length ? item.history : this.store.findDownloadsForSeries(item.url);
    const downloaded = new Set();
    const matchedNumbers = [];

    for (const chapter of remoteChapters) {
      const historyMatch = history.find((record) => recordMatchesChapter(record, chapter));
      const diskMatch = diskMatches.get(String(chapter.id)) || null;
      if (historyMatch || diskMatch) {
        downloaded.add(chapterKey(chapter));
        const number = chapterNumber(chapter);
        if (Number.isFinite(number)) matchedNumbers.push(number);
      }
    }

    // Preserve historical knowledge even if the user moved/deleted an older file.
    for (const record of history) {
      const number = chapterNumber({ id: record.chapterId, title: record.chapterTitle });
      if (Number.isFinite(number)) matchedNumbers.push(number);
    }

    const watchedKnown = new Set((item.watched?.chapters || []).map(chapterKey));
    const candidates = [];
    const reasons = [];

    // For watched series, chapters not present on the previous check are updates.
    if (item.watched && watchedKnown.size) {
      for (const chapter of remoteChapters) {
        const key = chapterKey(chapter);
        if (!watchedKnown.has(key) && !downloaded.has(key)) candidates.push(chapter);
      }
      reasons.push('watch-baseline');
    }

    // For series known only through downloads, everything newer than the newest
    // already downloaded chapter counts as an update. This intentionally avoids
    // backfilling old holes in a partially downloaded series.
    const maxDownloaded = matchedNumbers.length ? Math.max(...matchedNumbers) : null;
    if (Number.isFinite(maxDownloaded)) {
      for (const chapter of remoteChapters) {
        const key = chapterKey(chapter);
        if (downloaded.has(key)) continue;
        const number = chapterNumber(chapter);
        if (Number.isFinite(number) && number > maxDownloaded) candidates.push(chapter);
      }
      reasons.push(`latest-number:${maxDownloaded}`);
    }

    // If numeric chapter data is unavailable, use the connector order only when
    // we can locate at least one downloaded chapter and infer the newer direction.
    if (!Number.isFinite(maxDownloaded) && downloaded.size && remoteChapters.length > 1) {
      const indices = remoteChapters.map((chapter, index) => downloaded.has(chapterKey(chapter)) ? index : -1).filter((index) => index >= 0);
      if (indices.length) {
        const finite = remoteChapters.map((chapter, index) => ({ index, number: chapterNumber(chapter) })).filter((x) => Number.isFinite(x.number));
        let ascending = true;
        if (finite.length >= 2) ascending = finite[0].number <= finite[finite.length - 1].number;
        if (ascending) {
          const boundary = Math.max(...indices);
          for (let i = boundary + 1; i < remoteChapters.length; i += 1) if (!downloaded.has(chapterKey(remoteChapters[i]))) candidates.push(remoteChapters[i]);
        } else {
          const boundary = Math.min(...indices);
          for (let i = 0; i < boundary; i += 1) if (!downloaded.has(chapterKey(remoteChapters[i]))) candidates.push(remoteChapters[i]);
        }
        reasons.push(`order-fallback:${ascending ? 'asc' : 'desc'}`);
      }
    }

    const unique = new Map();
    for (const chapter of candidates) unique.set(chapterKey(chapter), chapter);
    const result = [...unique.values()];
    result.sort((a, b) => {
      const an = chapterNumber(a); const bn = chapterNumber(b);
      if (Number.isFinite(an) && Number.isFinite(bn)) return an - bn;
      return String(a.title || a.id).localeCompare(String(b.title || b.id), undefined, { numeric: true });
    });
    return { candidates: result, downloaded, maxDownloaded, reasons };
  }

  async scanAndUpdate() {
    if (this.running) return { skipped: true, reason: 'already-running' };
    this.running = true;
    const tracked = this.collectSeries();
    const summary = {
      skipped: false,
      totalSeries: tracked.length,
      checkedSeries: 0,
      updatedSeries: 0,
      newChapters: 0,
      downloadedChapters: 0,
      skippedLanguageSeries: 0,
      skippedLanguageChapters: 0,
      skippedStatusSeries: 0,
      errors: 0,
      series: []
    };
    this.onEvent({ type: 'update-scan-start', totalSeries: tracked.length });
    this.logger?.info('Update-Scan gestartet', { series: tracked.length });

    try {
      for (let index = 0; index < tracked.length; index += 1) {
        const item = tracked[index];
        const row = { title: item.title, url: item.url, newChapters: 0, downloaded: 0, errors: [], status: 'checking' };
        summary.series.push(row);
        this.onEvent({ type: 'update-series-start', current: index + 1, total: tracked.length, title: item.title, url: item.url });
        try {
          const connector = (item.connectorId && this.connectors.getById(item.connectorId)) || this.connectors.getForUrl(item.url);
          if (!connector) throw new Error('Kein Connector für diese Serie verfügbar.');
          const info = await connector.getSeriesInfo(item.url);
          const settings = this.store.getSettings();
          const seriesStatus = normalizeSeriesStatus(info.status || item.watched?.status);
          row.seriesStatus = seriesStatus;
          if (!isSeriesStatusAllowed(seriesStatus, settings)) {
            const localTitle = item.watched?.title || item.history?.[0]?.seriesTitle || item.title || info.title;
            row.title = localTitle;
            row.status = 'status-skip';
            row.statusReason = `${seriesStatusLabel(seriesStatus)} ist im Statusfilter ausgeblendet`;
            summary.checkedSeries += 1;
            summary.skippedStatusSeries += 1;
            if (item.watched) {
              try { this.store.updateSeries(item.watched.id, { status: seriesStatus, lastCheckedAt: new Date().toISOString(), lastError: null }); } catch {}
            }
            this.logger?.info('Update-Scan: Serie durch Statusfilter übersprungen', { title: localTitle, url: item.url, status: seriesStatus });
            this.onEvent({ type: 'update-series-done', current: index + 1, total: tracked.length, ...row });
            continue;
          }
          const seriesLanguage = evaluateLanguage([info, item.watched, item.history?.[0]], settings);
          if (!seriesLanguage.allowed) {
            const localTitle = item.watched?.title || item.history?.[0]?.seriesTitle || item.title || info.title;
            row.title = localTitle;
            row.status = 'language-skip';
            row.language = seriesLanguage.language || null;
            row.languageReason = seriesLanguage.language ? `${languageLabel(seriesLanguage.language)} ist nicht freigegeben` : 'Sprache konnte nicht sicher erkannt werden';
            summary.checkedSeries += 1;
            summary.skippedLanguageSeries += 1;
            if (item.watched) {
              try { this.store.updateSeries(item.watched.id, { language: info.language || item.watched.language || null, status: seriesStatus, lastCheckedAt: new Date().toISOString(), lastError: null }); } catch {}
            }
            this.logger?.info('Update-Scan: Serie durch Sprachfilter übersprungen', { title: localTitle, url: item.url, language: seriesLanguage.language, reason: seriesLanguage.reason });
            this.onEvent({ type: 'update-series-done', current: index + 1, total: tracked.length, ...row });
            continue;
          }
          let remoteChapters = Array.isArray(info?.chapters) ? info.chapters : [];
          remoteChapters = remoteChapters.filter((chapter) => {
            const chapterLanguage = evaluateLanguage([chapter, info], settings);
            if (chapterLanguage.allowed) return true;
            summary.skippedLanguageChapters += 1;
            return false;
          });
          if (!remoteChapters.length) throw new Error('Keine Kapitel in den freigegebenen Sprachen gefunden.');

          const localTitle = item.watched?.title || item.history?.[0]?.seriesTitle || item.title || info.title;
          row.title = localTitle;
          const disk = scanSeriesDownloads(this.store.getSettings().downloadRoot, localTitle, remoteChapters);
          const detection = this.determineNewChapters(item, remoteChapters, disk.matches);
          row.newChapters = detection.candidates.length;
          summary.newChapters += row.newChapters;
          summary.checkedSeries += 1;
          if (row.newChapters) summary.updatedSeries += 1;

          const jobSeries = {
            ...info,
            id: item.watched?.id || `update:${connector.id}:${item.url}`,
            title: localTitle,
            url: info.url || item.url,
            connectorId: connector.id
          };

          for (const chapter of detection.candidates) {
            try {
              this.onEvent({ type: 'update-chapter-start', title: localTitle, chapterTitle: chapter.title, current: row.downloaded + 1, total: detection.candidates.length });
              const pages = await connector.getPages(jobSeries, chapter);
              if (!Array.isArray(pages) || !pages.length) throw new Error('Keine Reader-Seiten erkannt.');
              const download = await this.downloader.enqueue({ series: jobSeries, chapter, pages, root: this.store.getSettings().downloadRoot });
              const record = this.store.markDownloaded({
                seriesTitle: localTitle,
                seriesUrl: item.url,
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
                catch (error) { this.logger?.error('Handy-Sync nach Update-Download fehlgeschlagen', { title: localTitle, chapter: chapter.title, message: error.message }); }
              }
              row.downloaded += 1;
              summary.downloadedChapters += 1;
              this.onEvent({ type: 'update-chapter-done', title: localTitle, chapterTitle: chapter.title, downloaded: row.downloaded, total: detection.candidates.length });
            } catch (error) {
              const message = String(error?.message || error || 'Unbekannter Fehler');
              row.errors.push(`${chapter.title}: ${message}`);
              summary.errors += 1;
              this.logger?.error('Update-Kapitel fehlgeschlagen', { title: localTitle, chapter: chapter.title, message });
              this.onEvent({ type: 'update-chapter-error', title: localTitle, chapterTitle: chapter.title, message });
            }
          }

          if (item.watched) {
            const history = this.store.findDownloadsForSeries(item.url);
            const refreshedDisk = scanSeriesDownloads(this.store.getSettings().downloadRoot, localTitle, remoteChapters);
            const chapters = remoteChapters.map((chapter) => ({
              ...chapter,
              downloaded: Boolean(
                refreshedDisk.matches.get(String(chapter.id)) ||
                history.some((record) => recordMatchesChapter(record, chapter))
              )
            }));
            this.store.updateSeries(item.watched.id, {
              title: localTitle,
              url: item.url,
              connectorId: connector.id,
              language: info.language || item.watched.language || null,
              status: seriesStatus,
              chapters,
              lastCheckedAt: new Date().toISOString(),
              lastError: row.errors.length ? row.errors[0] : null
            });
          }

          row.status = row.errors.length ? 'partial' : (row.newChapters ? 'updated' : 'current');
          this.logger?.info('Serie auf Updates geprüft', {
            title: localTitle,
            remoteChapters: remoteChapters.length,
            newChapters: row.newChapters,
            downloaded: row.downloaded,
            reasons: detection.reasons
          });
        } catch (error) {
          const message = String(error?.message || error || 'Unbekannter Fehler');
          row.status = 'error';
          row.errors.push(message);
          summary.errors += 1;
          if (item.watched) {
            try { this.store.updateSeries(item.watched.id, { lastCheckedAt: new Date().toISOString(), lastError: message }); } catch {}
          }
          this.logger?.error('Update-Scan für Serie fehlgeschlagen', { title: item.title, url: item.url, message });
        }
        this.onEvent({ type: 'update-series-done', current: index + 1, total: tracked.length, ...row });
      }
      try {
        const news = this.store.recordUpdateSummary?.(summary);
        summary.news = news || null;
      } catch (error) {
        this.logger?.error('Neuheiten-Dashboard konnte nicht aktualisiert werden', { message: String(error?.message || error) });
      }
      this.onEvent({ type: 'update-scan-done', summary });
      this.logger?.info('Update-Scan beendet', summary);
      return summary;
    } finally {
      this.running = false;
    }
  }
}

module.exports = { UpdateScanner, chapterNumber, normUrl };
