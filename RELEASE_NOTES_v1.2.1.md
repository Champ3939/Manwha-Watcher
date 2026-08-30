# Manhwa Watcher v1.2.1 – Online Reader & Progress Fix

This maintenance release fixes the first Online Library reader issues found in v1.2.0.

- Chapters are re-resolved from the series page before every online read.
- Every chapter opens in a fresh integrated reader window.
- Unexpected redirects to unrelated titles are blocked instead of being shown.
- Reading progress is saved only after the correct chapter has opened successfully.
- Using **Lesen** automatically creates the lightweight Online Library entry when needed.
- The currently opened series also shows **Zuletzt gelesen** when progress exists.

No CBZ is created by the online reader. Existing v1.2.0 SQLite data remains compatible.
