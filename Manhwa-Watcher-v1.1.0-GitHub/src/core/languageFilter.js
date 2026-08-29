const KNOWN = {
  en: ['en', 'eng', 'english', 'englisch'],
  de: ['de', 'deu', 'ger', 'german', 'deutsch', 'deutsche', 'deutscher'],
  fr: ['fr', 'fra', 'fre', 'french', 'français', 'francais'],
  es: ['es', 'spa', 'spanish', 'español', 'espanol'],
  pt: ['pt', 'por', 'portuguese', 'português', 'portugues'],
  it: ['it', 'ita', 'italian', 'italiano'],
  pl: ['pl', 'pol', 'polish', 'polski'],
  ru: ['ru', 'rus', 'russian', 'русский'],
  tr: ['tr', 'tur', 'turkish', 'türkçe', 'turkce'],
  id: ['id', 'ind', 'indonesian', 'bahasa indonesia'],
  vi: ['vi', 'vie', 'vietnamese', 'tiếng việt', 'tieng viet'],
  ko: ['ko', 'kor', 'korean', '한국어'],
  ja: ['ja', 'jpn', 'japanese', '日本語'],
  zh: ['zh', 'zho', 'chi', 'chinese', '中文'],
  th: ['th', 'tha', 'thai', 'ไทย'],
  ar: ['ar', 'ara', 'arabic', 'العربية']
};

const LABELS = { en: 'Englisch', de: 'Deutsch', fr: 'Französisch', es: 'Spanisch', pt: 'Portugiesisch', it: 'Italienisch', pl: 'Polnisch', ru: 'Russisch', tr: 'Türkisch', id: 'Indonesisch', vi: 'Vietnamesisch', ko: 'Koreanisch', ja: 'Japanisch', zh: 'Chinesisch', th: 'Thailändisch', ar: 'Arabisch' };

const aliasMap = new Map();
for (const [code, aliases] of Object.entries(KNOWN)) for (const alias of aliases) aliasMap.set(alias.toLowerCase(), code);

function normalizeLanguage(value) {
  if (value == null) return null;
  let raw = String(value).trim().toLowerCase();
  if (!raw) return null;
  raw = raw.replace(/_/g, '-');
  if (aliasMap.has(raw)) return aliasMap.get(raw);
  const first = raw.split('-')[0];
  if (aliasMap.has(first)) return aliasMap.get(first);
  return null;
}

function fromUrl(value) {
  try {
    const u = new URL(String(value || ''));
    for (const key of ['lang', 'language', 'locale', 'hl']) {
      const hit = normalizeLanguage(u.searchParams.get(key));
      if (hit) return { language: hit, source: `url:${key}` };
    }
    const parts = u.pathname.split('/').filter(Boolean);
    for (const part of parts) {
      if (part.length > 7) continue;
      const hit = normalizeLanguage(part);
      if (hit) return { language: hit, source: 'url:path' };
    }
  } catch {}
  return null;
}

function fromText(value) {
  const text = String(value || '').toLowerCase().replace(/[()[\]{}|,:;]+/g, ' ');
  if (!text.trim()) return null;
  for (const [code, aliases] of Object.entries(KNOWN)) {
    for (const alias of aliases) {
      if (alias.length <= 2) continue; // avoid accidental "de"/"en" inside normal titles
      const escaped = alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      if (new RegExp(`(^|\\s)${escaped}(?=\\s|$)`, 'i').test(text)) return { language: code, source: 'text' };
    }
  }
  return null;
}

function detectLanguage(input) {
  if (!input) return { language: null, source: 'unknown' };
  const objects = Array.isArray(input) ? input : [input];

  // Explicit metadata always wins.
  for (const item of objects) {
    if (item == null) continue;
    if (typeof item === 'string') {
      const direct = normalizeLanguage(item);
      if (direct) return { language: direct, source: 'explicit' };
      continue;
    }
    for (const key of ['language', 'lang', 'pageLanguage', 'locale', 'contentLanguage']) {
      const direct = normalizeLanguage(item[key]);
      if (direct) return { language: direct, source: key };
    }
  }

  // URLs are useful when sites separate locales by /en/, /de/ or ?lang=...
  for (const item of objects) {
    const values = typeof item === 'string' ? [item] : [item?.url, item?.seriesUrl, item?.chapterUrl];
    for (const value of values) {
      const hit = fromUrl(value);
      if (hit) return hit;
    }
  }

  // Finally accept explicit human-readable language labels/badges.
  for (const item of objects) {
    const values = typeof item === 'string' ? [item] : [item?.languageText, item?.languageLabel, item?.badgeText, item?.metaText, item?.reason];
    for (const value of values) {
      const hit = fromText(value);
      if (hit) return hit;
    }
  }
  return { language: null, source: 'unknown' };
}

function policy(settings = {}) {
  const enabled = settings.languageFilterEnabled !== false;
  const configured = Array.isArray(settings.allowedLanguages) ? settings.allowedLanguages : ['en', 'de'];
  const allowed = [...new Set(configured.map(normalizeLanguage).filter(Boolean))];
  return {
    enabled,
    allowed: allowed.length ? allowed : ['en', 'de'],
    allowUnknown: Boolean(settings.allowUnknownLanguage)
  };
}

function evaluateLanguage(input, settings = {}) {
  const p = policy(settings);
  const detection = detectLanguage(input);
  if (!p.enabled) return { ...detection, allowed: true, reason: 'filter-disabled', policy: p };
  if (!detection.language) return { ...detection, allowed: p.allowUnknown, reason: p.allowUnknown ? 'unknown-allowed' : 'unknown-blocked', policy: p };
  return { ...detection, allowed: p.allowed.includes(detection.language), reason: p.allowed.includes(detection.language) ? 'allowed-language' : 'blocked-language', policy: p };
}

function languageLabel(code) {
  return LABELS[normalizeLanguage(code)] || (code ? String(code).toUpperCase() : 'Unbekannt');
}

module.exports = { normalizeLanguage, detectLanguage, evaluateLanguage, languageLabel, policy };
