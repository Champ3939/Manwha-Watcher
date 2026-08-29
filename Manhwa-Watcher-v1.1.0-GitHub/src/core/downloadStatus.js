const fs = require('fs');
const path = require('path');

function safeName(value) {
  return String(value)
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, '_')
    .replace(/[. ]+$/g, '')
    .trim() || 'untitled';
}

function normalizedName(value) {
  return safeName(value)
    .normalize('NFKD')
    .toLowerCase()
    .replace(/\.(cbz|zip)$/i, '')
    .replace(/[^a-z0-9]+/g, '');
}

function usableFile(file) {
  try { return fs.statSync(file).isFile() && fs.statSync(file).size > 22; } catch { return false; }
}

function usableFolder(folder) {
  try { return fs.statSync(folder).isDirectory(); } catch { return false; }
}

function scanSeriesDownloads(downloadRoot, seriesTitle, chapters = []) {
  const seriesFolder = path.join(String(downloadRoot || ''), safeName(seriesTitle));
  const result = new Map();
  if (!usableFolder(seriesFolder)) return { seriesFolder, matches: result };

  let entries = [];
  try { entries = fs.readdirSync(seriesFolder, { withFileTypes: true }); } catch { return { seriesFolder, matches: result }; }
  const cbzByKey = new Map();
  const folderByKey = new Map();
  for (const entry of entries) {
    const full = path.join(seriesFolder, entry.name);
    if (entry.isFile() && /\.cbz$/i.test(entry.name) && usableFile(full)) cbzByKey.set(normalizedName(entry.name), full);
    if (entry.isDirectory()) folderByKey.set(normalizedName(entry.name), full);
  }

  for (const chapter of chapters || []) {
    const id = String(chapter?.id ?? '');
    if (!id) continue;
    const title = String(chapter?.title || `Chapter ${id}`).trim();
    const exactCbz = path.join(seriesFolder, `${safeName(title)}.cbz`);
    const exactFolder = path.join(seriesFolder, safeName(title));
    let match = null;
    if (usableFile(exactCbz)) match = { format: 'cbz', file: exactCbz, folder: seriesFolder, detectedFromDisk: true };
    else {
      const key = normalizedName(title);
      const cbz = cbzByKey.get(key);
      if (cbz) match = { format: 'cbz', file: cbz, folder: seriesFolder, detectedFromDisk: true };
      else if (usableFolder(exactFolder)) match = { format: 'folder', file: '', folder: exactFolder, detectedFromDisk: true };
      else {
        const folder = folderByKey.get(key);
        if (folder) match = { format: 'folder', file: '', folder, detectedFromDisk: true };
      }
    }
    if (match) result.set(id, match);
  }
  return { seriesFolder, matches: result };
}

module.exports = { safeName, normalizedName, scanSeriesDownloads };
