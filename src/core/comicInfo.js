function xmlEscape(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function firstNumber(value) {
  const text = String(value ?? '');
  const specific = text.match(/(?:chapter|chap(?:ter)?|ch\.?|episode|ep\.?)\s*#?[-:]?\s*(\d+(?:[.,]\d+)?)/i);
  if (specific) return specific[1].replace(',', '.');
  const generic = text.match(/(?:^|\D)(\d+(?:[.,]\d+)?)(?:\D|$)/);
  return generic ? generic[1].replace(',', '.') : '';
}

function normalizeLanguage(value) {
  const raw = String(value || '').trim().toLowerCase().replace('_', '-');
  if (!raw) return '';
  const map = {
    english: 'en', german: 'de', deutsch: 'de', englisch: 'en',
    korean: 'ko', koreanisch: 'ko', japanese: 'ja', japanisch: 'ja',
    chinese: 'zh', chinesisch: 'zh', spanish: 'es', französisch: 'fr', french: 'fr',
    portuguese: 'pt', portugiesisch: 'pt'
  };
  if (map[raw]) return map[raw];
  const short = raw.split('-')[0];
  return /^[a-z]{2,3}$/.test(short) ? short : '';
}

function statusText(value) {
  const raw = String(value || '').trim().toLowerCase();
  const map = {
    ongoing: 'Ongoing', completed: 'Completed', hiatus: 'Hiatus', upcoming: 'Upcoming',
    cancelled: 'Cancelled', canceled: 'Cancelled', dropped: 'Dropped', unknown: 'Unknown'
  };
  return map[raw] || (value ? String(value) : 'Unknown');
}

function buildComicInfoXml({ series = {}, chapter = {}, pageCount = 0, generator = 'Manhwa Watcher v1.0.2' } = {}) {
  const number = firstNumber(chapter.number ?? chapter.title ?? chapter.id);
  const language = normalizeLanguage(chapter.language || series.language);
  const source = chapter.url || series.url || '';
  const summary = String(series.summary || series.description || '').trim();
  const notes = [
    `Downloaded by ${generator}`,
    source ? `Source: ${source}` : '',
    series.status ? `Series status: ${statusText(series.status)}` : ''
  ].filter(Boolean).join('\n');

  const fields = [
    ['Title', chapter.title || (number ? `Chapter ${number}` : 'Chapter')],
    ['Series', series.title || 'Untitled Series'],
    number ? ['Number', number] : null,
    summary ? ['Summary', summary] : null,
    ['Notes', notes],
    source ? ['Web', source] : null,
    language ? ['LanguageISO', language] : null,
    ['PageCount', String(Math.max(0, Number(pageCount) || 0))],
    ['Manga', 'Yes']
  ].filter(Boolean);

  const body = fields.map(([key, value]) => `  <${key}>${xmlEscape(value)}</${key}>`).join('\n');
  return `<?xml version="1.0" encoding="utf-8"?>\n<ComicInfo xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">\n${body}\n</ComicInfo>\n`;
}

module.exports = { buildComicInfoXml, xmlEscape, firstNumber, normalizeLanguage };
