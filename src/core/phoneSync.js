const fs = require('fs');
const path = require('path');

function normUrl(value) {
  try {
    const u = new URL(String(value || ''));
    u.hash = '';
    return u.href.replace(/\/$/, '');
  } catch {
    return String(value || '').trim().replace(/\/$/, '');
  }
}

function safeName(value) {
  return String(value || '')
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, '_')
    .replace(/[. ]+$/g, '')
    .trim() || 'untitled';
}

async function statSafe(file) {
  try { return await fs.promises.stat(file); } catch { return null; }
}

class PhoneSync {
  constructor({ store, logger = null, onEvent = () => {} }) {
    this.store = store;
    this.logger = logger;
    this.onEvent = onEvent;
    this.running = false;
  }

  status() {
    const settings = this.store.getSettings();
    const targets = this.store.listSyncSeries();
    return {
      root: String(settings.syncRoot || ''),
      targetCount: targets.length,
      targets,
      running: this.running
    };
  }

  isSeriesEnabled(seriesUrl) {
    return this.store.isSeriesSynced(seriesUrl);
  }

  async setSeriesEnabled({ url, title, enabled }) {
    const target = this.store.setSeriesSync({ seriesUrl: url, title, enabled });
    if (enabled) {
      this.onEvent({ type: 'phone-sync-series-enabled', title: target?.title || title, url });
      const settings = this.store.getSettings();
      if (settings.syncRoot) await this.syncSeries(url);
    } else {
      this.onEvent({ type: 'phone-sync-series-disabled', title: title || target?.title || '', url });
    }
    return { ...this.status(), enabled: this.isSeriesEnabled(url) };
  }

  async ensureRoot() {
    const root = String(this.store.getSettings().syncRoot || '').trim();
    if (!root) throw new Error('Noch kein Handy-Sync-Ordner ausgewählt.');
    await fs.promises.mkdir(root, { recursive: true });
    // Helpful for Android gallery scanners when this directory is mapped to Aniyomi/local.
    try { await fs.promises.writeFile(path.join(root, '.nomedia'), '', { flag: 'a' }); } catch {}
    return root;
  }

  async copyCbz(source, destination) {
    if (path.resolve(source) === path.resolve(destination)) return { copied: false, skipped: true, destination, sameFile: true };
    const sourceStat = await statSafe(source);
    if (!sourceStat?.isFile()) throw new Error(`CBZ-Datei nicht gefunden: ${source}`);
    const targetStat = await statSafe(destination);
    if (targetStat?.isFile() && targetStat.size === sourceStat.size) return { copied: false, skipped: true, destination };

    await fs.promises.mkdir(path.dirname(destination), { recursive: true });
    const temp = `${destination}.sync-part`;
    try {
      await fs.promises.copyFile(source, temp);
      const copiedStat = await fs.promises.stat(temp);
      if (copiedStat.size !== sourceStat.size) throw new Error('Die kopierte Datei hat eine unerwartete Größe.');
      try { await fs.promises.unlink(destination); } catch {}
      await fs.promises.rename(temp, destination);
    } catch (error) {
      try { await fs.promises.unlink(temp); } catch {}
      throw error;
    }
    return { copied: true, skipped: false, destination };
  }

  async syncRecord(record) {
    if (!record?.seriesUrl || !this.isSeriesEnabled(record.seriesUrl)) return { skipped: true, reason: 'series-not-enabled' };
    if (!record.file || String(record.format || '').toLowerCase() !== 'cbz') return { skipped: true, reason: 'not-cbz' };
    const root = await this.ensureRoot();
    const target = this.store.getSyncSeries(record.seriesUrl);
    const seriesTitle = target?.title || record.seriesTitle || 'Unbenannte Serie';
    const destination = path.join(root, safeName(seriesTitle), path.basename(record.file));
    this.onEvent({ type: 'phone-sync-file-start', title: seriesTitle, chapterTitle: record.chapterTitle, source: record.file, destination });
    try {
      const result = await this.copyCbz(record.file, destination);
      this.logger?.info('Handy-Sync: CBZ gespiegelt', { title: seriesTitle, chapter: record.chapterTitle, source: record.file, destination, copied: result.copied });
      this.onEvent({ type: 'phone-sync-file-done', title: seriesTitle, chapterTitle: record.chapterTitle, destination, copied: result.copied });
      return result;
    } catch (error) {
      const message = String(error?.message || error || 'Unbekannter Sync-Fehler');
      this.logger?.error('Handy-Sync: CBZ konnte nicht gespiegelt werden', { title: seriesTitle, chapter: record.chapterTitle, source: record.file, destination, message });
      this.onEvent({ type: 'phone-sync-file-error', title: seriesTitle, chapterTitle: record.chapterTitle, message });
      throw error;
    }
  }

  async collectSeriesFiles(target) {
    const files = new Map();
    const history = this.store.findDownloadsForSeries(target.seriesUrl);
    for (const record of history) {
      if (!record?.file || String(record.format || '').toLowerCase() !== 'cbz') continue;
      const stat = await statSafe(record.file);
      if (stat?.isFile()) files.set(path.resolve(record.file), { file: record.file, chapterTitle: record.chapterTitle || path.basename(record.file, '.cbz') });
    }

    // Also detect CBZs directly in the normal download tree, so older/missing
    // history records do not prevent a phone sync.
    const downloadRoot = String(this.store.getSettings().downloadRoot || '').trim();
    if (downloadRoot) {
      const seriesFolder = path.join(downloadRoot, safeName(target.title));
      try {
        const entries = await fs.promises.readdir(seriesFolder, { withFileTypes: true });
        for (const entry of entries) {
          if (!entry.isFile() || !/\.cbz$/i.test(entry.name)) continue;
          const file = path.join(seriesFolder, entry.name);
          files.set(path.resolve(file), { file, chapterTitle: path.basename(entry.name, '.cbz') });
        }
      } catch {}
    }
    return [...files.values()].sort((a, b) => a.file.localeCompare(b.file, undefined, { numeric: true }));
  }

  async syncSeries(seriesUrl) {
    const target = this.store.getSyncSeries(seriesUrl);
    if (!target) return { skipped: true, reason: 'series-not-enabled', copied: 0, existing: 0, errors: [] };
    const root = await this.ensureRoot();
    const files = await this.collectSeriesFiles(target);
    const summary = { title: target.title, url: target.seriesUrl, total: files.length, copied: 0, existing: 0, errors: [] };
    this.onEvent({ type: 'phone-sync-series-start', title: target.title, url: target.seriesUrl, total: files.length });
    for (let index = 0; index < files.length; index += 1) {
      const entry = files[index];
      const destination = path.join(root, safeName(target.title), path.basename(entry.file));
      try {
        const result = await this.copyCbz(entry.file, destination);
        if (result.copied) summary.copied += 1; else summary.existing += 1;
        this.onEvent({ type: 'phone-sync-series-progress', title: target.title, current: index + 1, total: files.length, chapterTitle: entry.chapterTitle, copied: summary.copied, existing: summary.existing });
      } catch (error) {
        summary.errors.push({ file: entry.file, message: String(error?.message || error) });
      }
    }
    this.onEvent({ type: 'phone-sync-series-done', ...summary });
    this.logger?.info('Handy-Sync: Serie synchronisiert', summary);
    return summary;
  }

  async syncAll() {
    if (this.running) return { skipped: true, reason: 'already-running', ...this.status() };
    this.running = true;
    const targets = this.store.listSyncSeries();
    const summary = { skipped: false, totalSeries: targets.length, checkedSeries: 0, copied: 0, existing: 0, errors: 0, series: [] };
    this.onEvent({ type: 'phone-sync-start', totalSeries: targets.length });
    try {
      await this.ensureRoot();
      for (let index = 0; index < targets.length; index += 1) {
        const target = targets[index];
        this.onEvent({ type: 'phone-sync-all-series-start', current: index + 1, total: targets.length, title: target.title, url: target.seriesUrl });
        try {
          const row = await this.syncSeries(target.seriesUrl);
          summary.series.push(row);
          summary.checkedSeries += 1;
          summary.copied += row.copied || 0;
          summary.existing += row.existing || 0;
          summary.errors += row.errors?.length || 0;
        } catch (error) {
          summary.checkedSeries += 1;
          summary.errors += 1;
          summary.series.push({ title: target.title, url: target.seriesUrl, copied: 0, existing: 0, errors: [{ message: String(error?.message || error) }] });
        }
      }
      this.onEvent({ type: 'phone-sync-done', ...summary });
      this.logger?.info('Handy-Sync abgeschlossen', summary);
      return summary;
    } finally {
      this.running = false;
    }
  }
}

module.exports = { PhoneSync, safeName, normUrl };
