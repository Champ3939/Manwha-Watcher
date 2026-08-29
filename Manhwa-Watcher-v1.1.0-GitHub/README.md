# Manhwa Watcher

**Manhwa Watcher v1.1.0** ist eine portable Electron-Anwendung für Windows, die lokale Manga-/Manhwa-Bibliotheken verwaltet, Kapitel als CBZ speichert und neue Kapitel für unterstützte bzw. vom Nutzer konfigurierte Quellen erkennen kann.

> **Feature Freeze:** Mit v1.1.0 ist der geplante Funktionsumfang vorerst abgeschlossen. Neue Releases sollen sich primär auf Bugfixes, Stabilität und Webseiten-Kompatibilität konzentrieren.

## Highlights

- Katalogbrowser mit Suche sowie Sprach- und Statusfiltern
- Einzel-, Suchtreffer- und kompletter Katalogdownload
- CBZ-Ausgabe mit `ComicInfo.xml`
- Download-Queue mit Fortschritt und Retry
- manuelle und geplante Update-Scans
- Neuheiten-Dashboard
- Favoriten und Leseliste
- gespeicherte Webseiten/Quellen
- Connector-System mit generischer Auto-Erkennung und Connector-Labor
- Bibliotheks-/Speicherübersicht
- CBZ-Integritätsprüfung und automatische Reparatur sicher erkennbarer Probleme
- SQLite-Datenhaltung mit Migration älterer `library.json`-Daten
- Backup & Restore
- Syncthing-/Aniyomi-Handy-Sync

## Voraussetzungen

Für den fertigen Windows-Build sind keine separaten Node.js- oder Electron-Installationen notwendig.

Zum Entwickeln/Builden:

- Node.js 22 oder neuer empfohlen
- npm
- Windows für den Windows-Portable-Build

## Entwicklung starten

```bash
git clone <DEINE-GITHUB-REPOSITORY-URL>
cd Manhwa-Watcher
npm install
npm start
```

Syntax-/Quellcheck:

```bash
npm run check
```

Portable Windows-Version bauen:

```bash
npm run dist
```

Das Build-Ergebnis wird von `electron-builder` im Ordner `dist/` erzeugt.

## Lokale Daten

Die portable Anwendung legt ihre Laufzeitdaten neben der EXE unter folgendem Ordner ab:

```text
Manhwa-Watcher-Data/
├── library.db
├── library.json        # ggf. alter/Kompatibilitäts-Stand
├── Connectors/
└── Logs/
```

Diese Daten können private Informationen wie lokale Pfade, gespeicherte Quellen, Downloadhistorie und Einstellungen enthalten. **Der Ordner `Manhwa-Watcher-Data` gehört nicht ins Git-Repository.** Die mitgelieferte `.gitignore` schließt ihn aus.

## Downloadstruktur

Standardmäßig werden Kapitel als einzelne CBZ-Dateien pro Serie gespeichert:

```text
Manhwas/
└── Beispiel-Serie/
    ├── Chapter 1.cbz
    ├── Chapter 2.cbz
    └── Chapter 3.cbz
```

Neue CBZ-Dateien enthalten zusätzlich `ComicInfo.xml`, sofern die benötigten Metadaten verfügbar sind.

## Anyomi / Syncthing

Eine ausführliche Einrichtung für den Handy-Sync befindet sich in:

[`SETUP-SYNCTHING-ANIYOMI.md`](SETUP-SYNCTHING-ANIYOMI.md)

Kurz gesagt:

```text
Manhwa Watcher -> Sync-Ordner -> Syncthing -> Android/Anyomi local
```

## Releases auf GitHub

Empfohlene Aufteilung:

- **Repository:** nur Quellcode, Dokumentation und Konfigurationsbeispiele
- **GitHub Releases:** fertige Windows-ZIP/Portable-Builds als Release Asset

Die große Windows-Build-ZIP sollte nicht direkt in Git committed werden.

## Datenschutz

Manhwa Watcher arbeitet lokal. Repository und Release sollten keine persönlichen Laufzeitdaten enthalten. Prüfe vor einem öffentlichen Upload insbesondere, dass folgende Inhalte nicht committed wurden:

- `Manhwa-Watcher-Data/`
- `library.db` / `library.json`
- Logs
- lokale Connector-Konfigurationen mit privaten Daten
- heruntergeladene `.cbz`
- Backups
- lokale Sync-Ordner

## Rechtlicher Hinweis

Manhwa Watcher ist ein allgemeines Verwaltungs- und Download-Werkzeug. Verwende automatisierte Downloads nur für Inhalte und Quellen, bei denen du dazu berechtigt bist und bei denen die jeweilige Nutzung zulässig ist. Das Projekt ist nicht mit den durch Nutzer konfigurierten Webseiten oder deren Betreibern verbunden.

## Projektstruktur

```text
Manhwa-Watcher/
├── .github/
├── src/
│   ├── connectors/
│   ├── core/
│   └── renderer/
├── .gitignore
├── CHANGELOG.md
├── CONTRIBUTING.md
├── LICENSE
├── README.md
├── RELEASE_NOTES_v1.1.0.md
├── SECURITY.md
├── SETUP-SYNCTHING-ANIYOMI.md
├── example-manifest.json
└── package.json
```

## Lizenz

MIT – siehe [`LICENSE`](LICENSE).
