const fs = require('fs');
const path = require('path');
const { buildComicInfoXml } = require('./comicInfo');
const { parseChapterNumber, safeName } = require('./libraryHealth');
const { evaluateLanguage, languageLabel } = require('./languageFilter');
const { normalizeSeriesStatus, seriesStatusLabel, isSeriesStatusAllowed } = require('./seriesStatus');

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let crc = 0xFFFFFFFF;
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xFF] ^ (crc >>> 8);
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

function dosDateTime(date = new Date()) {
  const year = Math.max(1980, Math.min(2107, date.getFullYear()));
  return {
    dosTime: ((date.getHours() & 0x1F) << 11) | ((date.getMinutes() & 0x3F) << 5) | (Math.floor(date.getSeconds() / 2) & 0x1F),
    dosDate: (((year - 1980) & 0x7F) << 9) | (((date.getMonth() + 1) & 0x0F) << 5) | (date.getDate() & 0x1F)
  };
}

function normPath(value) {
  try { return path.resolve(String(value || '')).toLowerCase(); }
  catch { return String(value || '').toLowerCase(); }
}

function normUrl(value) {
  try { const u = new URL(String(value || '')); u.hash = ''; return u.href.replace(/\/$/, ''); }
  catch { return String(value || '').trim().replace(/\/$/, ''); }
}

function hostFor(value) {
  try { return new URL(String(value || '')).hostname.toLowerCase().replace(/^www\./, ''); }
  catch { return ''; }
}

function chapterMatches(record, chapter) {
  if (!record || !chapter) return false;
  if (record.chapterId && String(record.chapterId) === String(chapter.id)) return true;
  if (record.chapterUrl && chapter.url && normUrl(record.chapterUrl) === normUrl(chapter.url)) return true;
  if (record.chapterTitle && String(record.chapterTitle).trim() === String(chapter.title || '').trim()) return true;
  const a = parseChapterNumber(record.chapterTitle || record.chapterId);
  const b = parseChapterNumber(chapter.title || chapter.id);
  return Number.isFinite(a) && Number.isFinite(b) && a === b;
}

function copyRangeSync(inputFd, outputFd, length) {
  const chunk = Buffer.allocUnsafe(4 * 1024 * 1024);
  let position = 0;
  while (position < length) {
    const wanted = Math.min(chunk.length, length - position);
    const read = fs.readSync(inputFd, chunk, 0, wanted, position);
    if (!read) throw new Error('CBZ konnte beim Reparieren nicht vollständig gelesen werden.');
    fs.writeSync(outputFd, chunk, 0, read, position);
    position += read;
  }
}

function readZip32Central(file) {
  const stat = fs.statSync(file);
  if (!stat.isFile() || stat.size < 22) throw new Error('CBZ ist leer oder zu klein.');
  const fd = fs.openSync(file, 'r');
  try {
    const tailLength = Math.min(stat.size, 66000);
    const tail = Buffer.alloc(tailLength);
    fs.readSync(fd, tail, 0, tailLength, stat.size - tailLength);
    let eocd = -1;
    for (let i = tail.length - 22; i >= 0; i -= 1) {
      if (tail.readUInt32LE(i) === 0x06054B50) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error('ZIP-Endverzeichnis fehlt.');
    const entries = tail.readUInt16LE(eocd + 10);
    const centralSize = tail.readUInt32LE(eocd + 12);
    const centralOffset = tail.readUInt32LE(eocd + 16);
    if (entries === 0xFFFF || centralSize === 0xFFFFFFFF || centralOffset === 0xFFFFFFFF) throw new Error('ZIP64-CBZ kann noch nicht automatisch mit Metadaten repariert werden.');
    if (centralOffset + centralSize > stat.size) throw new Error('ZIP-Zentralverzeichnis ist beschädigt.');
    const central = Buffer.alloc(centralSize);
    fs.readSync(fd, central, 0, centralSize, centralOffset);
    let cursor = 0;
    let parsed = 0;
    let hasComicInfo = false;
    while (cursor + 46 <= central.length && parsed < entries) {
      if (central.readUInt32LE(cursor) !== 0x02014B50) throw new Error('ZIP-Zentralverzeichnis ist beschädigt.');
      const nameLength = central.readUInt16LE(cursor + 28);
      const extraLength = central.readUInt16LE(cursor + 30);
      const commentLength = central.readUInt16LE(cursor + 32);
      const nameStart = cursor + 46;
      const nameEnd = nameStart + nameLength;
      if (nameEnd > central.length) throw new Error('ZIP-Dateiname ist abgeschnitten.');
      const filename = central.subarray(nameStart, nameEnd).toString('utf8');
      if (/^(?:.*\/)?ComicInfo\.xml$/i.test(filename)) hasComicInfo = true;
      cursor = nameEnd + extraLength + commentLength;
      parsed += 1;
    }
    if (parsed !== entries) throw new Error('ZIP-Zentralverzeichnis konnte nicht vollständig gelesen werden.');
    return { stat, entries, centralSize, centralOffset, central, hasComicInfo };
  } finally { fs.closeSync(fd); }
}

function addComicInfoToCbz(file, xml) {
  const zip = readZip32Central(file);
  if (zip.hasComicInfo) return { changed: false, reason: 'already-present' };
  if (zip.entries >= 0xFFFF) throw new Error('Zu viele ZIP-Einträge für ZIP32.');
  const data = Buffer.isBuffer(xml) ? xml : Buffer.from(String(xml || ''), 'utf8');
  const name = Buffer.from('ComicInfo.xml', 'utf8');
  const crc = crc32(data);
  const { dosTime, dosDate } = dosDateTime();
  const localOffset = zip.centralOffset;
  if (localOffset > 0xFFFFFFFF || data.length > 0xFFFFFFFF) throw new Error('CBZ ist zu groß für ZIP32-Metadatenreparatur.');

  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034B50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(0x0800, 6);
  local.writeUInt16LE(0, 8);
  local.writeUInt16LE(dosTime, 10);
  local.writeUInt16LE(dosDate, 12);
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(data.length, 18);
  local.writeUInt32LE(data.length, 22);
  local.writeUInt16LE(name.length, 26);
  local.writeUInt16LE(0, 28);

  const entry = Buffer.alloc(46);
  entry.writeUInt32LE(0x02014B50, 0);
  entry.writeUInt16LE(20, 4);
  entry.writeUInt16LE(20, 6);
  entry.writeUInt16LE(0x0800, 8);
  entry.writeUInt16LE(0, 10);
  entry.writeUInt16LE(dosTime, 12);
  entry.writeUInt16LE(dosDate, 14);
  entry.writeUInt32LE(crc, 16);
  entry.writeUInt32LE(data.length, 20);
  entry.writeUInt32LE(data.length, 24);
  entry.writeUInt16LE(name.length, 28);
  entry.writeUInt16LE(0, 30);
  entry.writeUInt16LE(0, 32);
  entry.writeUInt16LE(0, 34);
  entry.writeUInt16LE(0, 36);
  entry.writeUInt32LE(0, 38);
  entry.writeUInt32LE(localOffset, 42);

  const newCentralOffset = localOffset + local.length + name.length + data.length;
  const newCentralSize = zip.central.length + entry.length + name.length;
  if (newCentralOffset > 0xFFFFFFFF || newCentralSize > 0xFFFFFFFF) throw new Error('CBZ ist zu groß für ZIP32-Metadatenreparatur.');
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054B50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(zip.entries + 1, 8);
  end.writeUInt16LE(zip.entries + 1, 10);
  end.writeUInt32LE(newCentralSize, 12);
  end.writeUInt32LE(newCentralOffset, 16);
  end.writeUInt16LE(0, 20);

  const temp = `${file}.repair-part`;
  const backup = `${file}.repair-backup`;
  try { fs.rmSync(temp, { force: true }); } catch {}
  try { fs.rmSync(backup, { force: true }); } catch {}
  const inFd = fs.openSync(file, 'r');
  const outFd = fs.openSync(temp, 'w');
  try {
    copyRangeSync(inFd, outFd, zip.centralOffset);
    let pos = zip.centralOffset;
    for (const buffer of [local, name, data, zip.central, entry, name, end]) {
      fs.writeSync(outFd, buffer, 0, buffer.length, pos);
      pos += buffer.length;
    }
  } finally {
    fs.closeSync(inFd);
    fs.closeSync(outFd);
  }
  try {
    fs.renameSync(file, backup);
    try {
      fs.renameSync(temp, file);
      fs.rmSync(backup, { force: true });
    } catch (error) {
      try { fs.rmSync(file, { force: true }); } catch {}
      try { fs.renameSync(backup, file); } catch {}
      throw error;
    }
  } finally {
    try { fs.rmSync(temp, { force: true }); } catch {}
    try { fs.rmSync(backup, { force: true }); } catch {}
  }
  return { changed: true };
}

class LibraryRepair {
  constructor({ store, connectors, downloader, phoneSync = null, logger = null, onEvent = () => {} }) {
    this.store = store;
    this.connectors = connectors;
    this.downloader = downloader;
    this.phoneSync = phoneSync;
    this.logger = logger;
    this.onEvent = onEvent;
    this.running = false;
  }

  status() { return { running: this.running }; }

  downloads() { return this.store.listDownloads({ limit: 5000 }); }

  findRecordForFile(file) {
    const key = normPath(file);
    return this.downloads().find((item) => item.file && normPath(item.file) === key) || null;
  }

  findSeriesRecords(problem) {
    const folderKey = normPath(problem?.folder || '');
    const title = String(problem?.seriesTitle || '').trim().toLowerCase();
    return this.downloads().filter((record) => {
      if (record.file && folderKey && normPath(path.dirname(record.file)) === folderKey) return true;
      if (record.folder && folderKey && normPath(record.folder) === folderKey) return true;
      return title && String(record.seriesTitle || '').trim().toLowerCase() === title;
    });
  }

  preferAutoDetect(url) {
    const host = hostFor(url);
    if (!host) return false;
    const settings = this.store.getSettings();
    const list = Array.isArray(settings.connectorAutoDetectDomains) ? settings.connectorAutoDetectDomains.map(String) : [];
    if (list.some((item) => hostFor(item) === host || String(item).toLowerCase() === host)) return false;
    this.store.setSettings({ connectorAutoDetectDomains: [...list, host] });
    this.logger?.warn('Connector-Autoreparatur: Auto-Detect wird künftig bevorzugt', { host });
    this.onEvent({ type: 'library-auto-repair-connector-fallback', domain: host });
    return true;
  }

  connectorCandidates(url) {
    const list = [this.connectors.getForUrl(url), this.connectors.getPrimaryForUrl?.(url), this.connectors.getAutoDetect?.()].filter(Boolean);
    const seen = new Set();
    return list.filter((connector) => !seen.has(connector.id) && seen.add(connector.id));
  }

  async resolveDownload(url, matcher) {
    let lastError = null;
    const primary = this.connectors.getPrimaryForUrl?.(url) || null;
    for (const connector of this.connectorCandidates(url)) {
      try {
        const info = await connector.getSeriesInfo(url);
        const chapter = (info.chapters || []).find(matcher);
        if (!chapter) throw new Error('Das benötigte Kapitel wurde auf der Quelle nicht gefunden.');
        const series = { ...info, id: `repair:${connector.id}:${url}` };
        const settings = this.store.getSettings();
        const status = normalizeSeriesStatus(info.status);
        if (!isSeriesStatusAllowed(status, settings)) throw new Error(`Statusfilter: ${seriesStatusLabel(status)} ist ausgeblendet.`);
        const lang = evaluateLanguage([chapter, info], settings);
        if (!lang.allowed) throw new Error(`Sprachfilter: ${lang.language ? languageLabel(lang.language) : 'unbekannte Sprache'} ist nicht erlaubt.`);
        const pages = await connector.getPages(series, chapter);
        if (!Array.isArray(pages) || !pages.length) throw new Error('Keine Reader-Seiten erkannt.');
        if (connector.type === 'auto-detect' && primary && primary.id !== connector.id) this.preferAutoDetect(url);
        return { connector, info, series, chapter, pages };
      } catch (error) {
        lastError = error;
        this.logger?.warn('Bibliotheks-Autoreparatur: Connector-Versuch fehlgeschlagen', { url, connector: connector.id, message: error.message });
      }
    }
    throw lastError || new Error('Kein Connector konnte die Serie reparieren.');
  }

  async downloadResolved(resolved, originalRecord = null) {
    const settings = this.store.getSettings();
    const download = await this.downloader.enqueue({ series: resolved.series, chapter: resolved.chapter, pages: resolved.pages, root: settings.downloadRoot });
    const saved = this.store.markDownloaded({
      ...(originalRecord || {}),
      seriesTitle: resolved.info.title || originalRecord?.seriesTitle,
      seriesUrl: resolved.info.url || resolved.series.url,
      chapterId: resolved.chapter.id,
      chapterTitle: resolved.chapter.title,
      chapterUrl: resolved.chapter.url,
      folder: download.folder,
      file: download.file,
      format: download.format,
      pageCount: download.pageCount || resolved.pages.length,
      downloadedAt: new Date().toISOString()
    });
    if (this.phoneSync) {
      try { await this.phoneSync.syncRecord(saved); }
      catch (error) { this.logger?.error('Handy-Sync nach Autoreparatur fehlgeschlagen', { file: saved.file, message: error.message }); }
    }
    return saved;
  }

  async repairCorrupt(problem) {
    const record = this.findRecordForFile(problem.file);
    if (!record?.seriesUrl) throw new Error('Kein Downloadverlauf mit Serien-URL gefunden.');
    const resolved = await this.resolveDownload(record.seriesUrl, (chapter) => chapterMatches(record, chapter));
    await this.downloadResolved(resolved, record);
    return { action: 'redownload', file: problem.file, title: `${record.seriesTitle} – ${record.chapterTitle}` };
  }

  async repairPartial(problem) {
    const file = String(problem.file || '');
    if (!file) throw new Error('Keine .part-Datei angegeben.');
    const finalFile = file.replace(/\.part$/i, '');
    const finalExists = fs.existsSync(finalFile);
    const record = this.downloads().find((item) => item.file && normPath(item.file) === normPath(finalFile));
    fs.rmSync(file, { force: true });
    if (!finalExists && record?.seriesUrl) {
      const resolved = await this.resolveDownload(record.seriesUrl, (chapter) => chapterMatches(record, chapter));
      await this.downloadResolved(resolved, record);
      return { action: 'partial-redownload', file, title: `${record.seriesTitle} – ${record.chapterTitle}` };
    }
    return { action: 'partial-delete', file, title: path.basename(file) };
  }

  async repairMetadata(problem) {
    const record = this.findRecordForFile(problem.file);
    const seriesTitle = record?.seriesTitle || problem.seriesTitle || path.basename(path.dirname(problem.file));
    const chapterTitle = record?.chapterTitle || path.basename(problem.file, path.extname(problem.file));
    const cachedStatus = record?.seriesUrl ? this.store.getSeriesStatus(record.seriesUrl, { maxAgeMs: 0 }) : null;
    const xml = buildComicInfoXml({
      series: { title: seriesTitle, url: record?.seriesUrl || '', status: cachedStatus?.status || 'unknown' },
      chapter: { id: record?.chapterId || '', title: chapterTitle, url: record?.chapterUrl || '' },
      pageCount: Number(record?.pageCount || problem.imageCount || 0),
      generator: 'Manhwa Watcher v1.0.2'
    });
    const result = addComicInfoToCbz(problem.file, xml);
    if (result.changed && record && this.phoneSync) {
      try { await this.phoneSync.syncRecord(record); } catch (error) { this.logger?.error('Handy-Sync nach ComicInfo-Reparatur fehlgeschlagen', { file: problem.file, message: error.message }); }
    }
    return { action: result.changed ? 'metadata-added' : 'metadata-existing', file: problem.file, title: `${seriesTitle} – ${chapterTitle}` };
  }

  async repairMissing(problem) {
    const records = this.findSeriesRecords(problem);
    const record = records.find((item) => item.seriesUrl) || null;
    if (!record?.seriesUrl) throw new Error('Für diese Serie ist keine Quell-URL im Downloadverlauf vorhanden.');
    const fixed = [];
    const notFound = [];
    for (const number of Array.isArray(problem.missing) ? problem.missing : []) {
      try {
        const resolved = await this.resolveDownload(record.seriesUrl, (chapter) => parseChapterNumber(chapter.title || chapter.id) === Number(number));
        await this.downloadResolved(resolved, null);
        fixed.push(number);
      } catch (error) {
        notFound.push({ number, message: error.message });
      }
    }
    if (!fixed.length) throw new Error(notFound[0]?.message || 'Keine fehlenden Kapitel konnten automatisch gefunden werden.');
    return { action: 'missing-downloaded', title: problem.seriesTitle, fixed, notFound };
  }

  async repair(scanResult) {
    if (this.running) throw new Error('Eine automatische Reparatur läuft bereits.');
    const problems = Array.isArray(scanResult?.library?.problems) ? scanResult.library.problems : [];
    this.running = true;
    const beforeFallbacks = new Set((Array.isArray(this.store.getSettings().connectorAutoDetectDomains) ? this.store.getSettings().connectorAutoDetectDomains : []).map(String));
    const summary = { total: problems.length, checked: 0, fixed: 0, failed: 0, skipped: 0, connectorFallbacks: 0, results: [] };
    this.onEvent({ type: 'library-auto-repair-start', total: problems.length });
    this.logger?.info('Automatische Bibliotheksreparatur gestartet', { problems: problems.length });
    try {
      for (let index = 0; index < problems.length; index += 1) {
        const problem = problems[index];
        this.onEvent({ type: 'library-auto-repair-progress', current: index + 1, total: problems.length, problem });
        try {
          let result;
          if (problem.type === 'corrupt') result = await this.repairCorrupt(problem);
          else if (problem.type === 'partial') result = await this.repairPartial(problem);
          else if (problem.type === 'metadata') result = await this.repairMetadata(problem);
          else if (problem.type === 'missing') result = await this.repairMissing(problem);
          else { summary.skipped += 1; result = { action: 'skipped', title: problem.seriesTitle || problem.file || problem.type }; }
          if (result.action !== 'skipped') summary.fixed += 1;
          summary.results.push({ ok: true, type: problem.type, ...result });
          this.onEvent({ type: 'library-auto-repair-item-done', problem, result });
        } catch (error) {
          summary.failed += 1;
          summary.results.push({ ok: false, type: problem.type, title: problem.seriesTitle || problem.file || problem.type, message: String(error?.message || error) });
          this.onEvent({ type: 'library-auto-repair-item-error', problem, message: String(error?.message || error) });
          this.logger?.error('Automatische Reparatur eines Problems fehlgeschlagen', { type: problem.type, file: problem.file, series: problem.seriesTitle, message: error.message });
        }
        summary.checked += 1;
      }
      const settings = this.store.getSettings();
      const afterFallbacks = new Set((Array.isArray(settings.connectorAutoDetectDomains) ? settings.connectorAutoDetectDomains : []).map(String));
      summary.connectorFallbacks = [...afterFallbacks].filter((item) => !beforeFallbacks.has(item)).length;
      this.onEvent({ type: 'library-auto-repair-done', summary });
      this.logger?.info('Automatische Bibliotheksreparatur beendet', summary);
      return summary;
    } finally {
      this.running = false;
    }
  }
}

module.exports = { LibraryRepair, addComicInfoToCbz, readZip32Central };
