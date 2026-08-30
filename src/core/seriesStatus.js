const DEFAULT_ALLOWED_STATUSES = ['ongoing', 'completed', 'hiatus', 'upcoming', 'unknown'];
const ALL_STATUSES = ['ongoing', 'completed', 'hiatus', 'upcoming', 'cancelled', 'dropped', 'unknown'];

function normalizeSeriesStatus(value) {
  const raw = String(value || '').trim().toLowerCase().replace(/[\s_-]+/g, ' ');
  if (!raw) return 'unknown';
  if (/\b(?:cancelled|canceled|discontinued)\b/.test(raw)) return 'cancelled';
  if (/\b(?:dropped|abandoned|abandon(?:ed)?)\b/.test(raw)) return 'dropped';
  if (/\b(?:hiatus|on hiatus|paused|pause)\b/.test(raw)) return 'hiatus';
  if (/\b(?:completed|complete|finished|ended)\b/.test(raw)) return 'completed';
  if (/\b(?:upcoming|not yet released|coming soon|announced|pre release|pre-release)\b/.test(raw)) return 'upcoming';
  if (/\b(?:ongoing|on going|publishing|releasing|active|serialization)\b/.test(raw)) return 'ongoing';
  return ALL_STATUSES.includes(raw) ? raw : 'unknown';
}

function seriesStatusLabel(value) {
  const status = normalizeSeriesStatus(value);
  return {
    ongoing: 'Ongoing',
    completed: 'Completed',
    hiatus: 'Hiatus',
    upcoming: 'Upcoming',
    cancelled: 'Cancelled',
    dropped: 'Dropped',
    unknown: 'Unbekannt'
  }[status] || 'Unbekannt';
}

function allowedStatuses(settings = {}) {
  const configured = Array.isArray(settings.allowedSeriesStatuses) ? settings.allowedSeriesStatuses.map(normalizeSeriesStatus) : DEFAULT_ALLOWED_STATUSES;
  const valid = [...new Set(configured.filter((item) => ALL_STATUSES.includes(item)))];
  return valid.length ? valid : DEFAULT_ALLOWED_STATUSES;
}

function isSeriesStatusAllowed(value, settings = {}) {
  if (settings.seriesStatusFilterEnabled === false) return true;
  return allowedStatuses(settings).includes(normalizeSeriesStatus(value));
}

module.exports = { ALL_STATUSES, DEFAULT_ALLOWED_STATUSES, normalizeSeriesStatus, seriesStatusLabel, allowedStatuses, isSeriesStatusAllowed };
