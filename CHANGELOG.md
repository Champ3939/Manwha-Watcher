# Changelog

## v1.1.2 – Pagination Hotfix

- Fix: Seitenfremde Quellen, Serien und Kapitel werden jetzt zuverlässig per `display: none` ausgeblendet.
- Fix: Die bisherigen `.source-row`/`.title-row`-Regeln mit `display: flex` konnten das HTML-Attribut `hidden` überschreiben und dadurch weiterhin alle Einträge anzeigen.
- Fix: Pagination beobachtet die drei Listen jetzt per `MutationObserver` und wird nach Suche, Filterung, Katalog- und Kapitel-Reload automatisch erneut angewendet.
- Fix: robusteres Laden des Pagination-Renderers mit Debug-Log.
- Getestet mit 120 Einträgen: 50 pro Seite, korrekter Seitenwechsel sowie 25/50/100/200 Einträge pro Seite.

## v1.1.1 – Pagination UX

- Pagination für Quellen, Serien und Kapitel im HakuNeko-Browser.
- Standardmäßig 50 Einträge pro Seite; 25/50/100/200 sind direkt auswählbar.
- Navigation zur ersten, vorherigen, nächsten und letzten Seite.
- Direkte Eingabe einer Seitennummer.
- Suche und Filter arbeiten weiterhin über den vollständigen geladenen Katalog, nicht nur über die aktuelle Seite.
- Suche, Status-/Favoriten-/Leselistenfilter und Serienwechsel setzen die jeweilige Ansicht sinnvoll auf Seite 1 zurück.
- Kapitel-Auswahl bleibt beim Seitenwechsel erhalten.
- „Alle“ bei Kapiteln wählt alle aktuell gefilterten Kapitel und nicht nur die sichtbare Seite.
- Gewählte Seitengröße wird lokal gespeichert.

## v1.1.0 – Feature Freeze

- SQLite (`Manhwa-Watcher-Data/library.db`) ist jetzt die primäre Datenhaltung.
- Vorhandene `library.json` wird beim ersten Start automatisch und verlustfrei in SQLite importiert.
- Favoriten und Leseliste für beliebige Katalogserien.
- Serienliste kann auf `★ Favoriten` oder `📖 Leseliste` gefiltert werden.
- Neuheiten-Dashboard zeigt nur Serien, bei denen der letzte Update-Scan neue Kapitel gefunden hat.
- Neuheiten-Zähler direkt im Header.
- Backup v2 enthält `library.db`, einen lesbaren JSON-Kompatibilitäts-Snapshot und Connectoren.
- Alte v1.0.x-JSON-Backups können weiterhin wiederhergestellt werden und werden danach automatisch nach SQLite migriert.
- Bestehende Funktionen aus v1.0.2 bleiben erhalten: CBZ/ComicInfo, Queue, Auto-Updates, Status-/Sprachfilter, Komplett-/Such-Downloads, Bibliotheksprüfung und -reparatur, Handy-Sync.
- Mit v1.1.0 beginnt der Feature-Freeze: danach primär Bugfixes und Stabilitätsverbesserungen.
