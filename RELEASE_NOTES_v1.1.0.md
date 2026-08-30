# Manhwa Watcher v1.1.0 – Feature Freeze

v1.1.0 markiert den vorläufigen Abschluss des geplanten Funktionsumfangs. Ab diesem Stand liegt der Fokus auf Bugfixes, Stabilität und Webseiten-Kompatibilität.

## Neu

- SQLite als primäre Datenhaltung (`Manhwa-Watcher-Data/library.db`)
- automatische Migration vorhandener `library.json`
- Favoriten
- Leseliste
- Neuheiten-Dashboard mit Zähler
- SQLite-fähiges Backup/Restore
- Kompatibilität mit älteren v1.0.x-JSON-Backups

## Bereits enthalten

- CBZ + `ComicInfo.xml`
- Download-Queue / Retry
- manuelle und geplante Update-Scans
- Sprach- und Statusfilter
- Suchtreffer- und Katalog-Batchdownloads
- Bibliotheksprüfung und automatische Reparatur
- Speicherübersicht
- Syncthing/Anyomi-Sync
- gespeicherte Webseiten
- Connector-/Auto-Detect-System

## Upgrade von v1.0.x

Den vorhandenen Ordner `Manhwa-Watcher-Data` neben die neue EXE übernehmen. Beim ersten Start importiert v1.1.0 eine vorhandene `library.json` automatisch nach SQLite. Die alte JSON-Datei wird dabei nicht gelöscht.

Vor einem Upgrade ist ein Backup über die eingebaute Backup-Funktion empfohlen.
