# Manhwa Watcher v1.1.2 – Pagination Hotfix

v1.1.2 fixes the pagination introduced in v1.1.1.

## Fixed

- Rows outside the current page are now reliably hidden with `display: none` instead of the HTML `hidden` attribute. The existing row CSS used `display: flex`, which could override `hidden` and leave all entries visible.
- Pagination now watches the Sources, Series, and Chapters lists for DOM changes and reapplies itself automatically after searches, filters, catalog loads, chapter loads, and status updates.
- Pagination script loading is more defensive and logs successful initialization to the debug log.

## Behavior

- 50 entries per page by default.
- Selectable page sizes: 25 / 50 / 100 / 200.
- First / previous / next / last navigation.
- Direct page-number input.
- Search and filters continue to work across the complete loaded catalog.
- Chapter selections survive page changes.

No database migration is required. Existing `Manhwa-Watcher-Data` from v1.1.0/v1.1.1 remains compatible.
