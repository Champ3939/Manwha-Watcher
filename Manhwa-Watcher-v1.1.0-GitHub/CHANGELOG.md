# Changelog

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
