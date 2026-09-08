# Manhwa Watcher v1.2.4

This release fixes chapter lists that could include chapters from unrelated series when a website mixed recommendation/latest-chapter blocks into a series page.

## Fixed

- Auto-detected chapter links are grouped by URL/path family.
- The group that best matches the opened series URL/title is preferred.
- Cross-domain chapter links are ignored during auto-detection.
- Ambiguous page structures fall back to the previous unfiltered result instead of hiding valid chapters aggressively.

## Compatibility

No database migration is required. Existing `Manhwa-Watcher-Data`, online-library entries, read status, downloads, saved websites, connectors and Syncthing/Anyomi configuration remain compatible.
