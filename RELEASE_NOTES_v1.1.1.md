# Manhwa Watcher v1.1.1 – Pagination UX

v1.1.1 improves navigation in large catalogs and long chapter lists without changing the existing download engine.

## New

- Pagination for **Sources**, **Series**, and **Chapters**.
- Default page size: **50** entries.
- Selectable page sizes: **25 / 50 / 100 / 200**.
- First, previous, next, and last page buttons.
- Direct page-number input.
- Page-size preference is stored locally.

## Search & filters

Search and filters continue to work across the **entire loaded catalog**, not only the currently visible page.

Changing a search/filter resets the affected list to page 1 so results cannot appear to be missing.

## Chapter selection

Chapter selections are preserved while switching pages.

The **Alle** button selects all chapters matching the current chapter search / "Nur offen" filter, not only the entries visible on the current page.

## Compatibility

No database migration is required. Existing `Manhwa-Watcher-Data`, downloads, saved websites, connectors, favorites, reading list, phone sync, and SQLite data remain compatible with v1.1.0.
