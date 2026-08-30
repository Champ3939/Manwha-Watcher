# Changelog

## v1.2.3 – Layout Fix

- Fix: Die Aktionsbuttons im Kopf der Kapitelspalte laufen nicht mehr über den rechten Rand.
- Favorit, Leseliste, Online-Bibliothek, Beobachten, Handy-Sync und Connector brechen bei wenig Platz sauber in eine zweite Zeile um.
- Die Buttons wurden in dieser Leiste leicht kompakter gemacht, ohne Funktionen zu entfernen.

## v1.2.2 – Chapter Read Status

- Online-Bibliothek speichert jetzt nicht nur das zuletzt gelesene Kapitel, sondern alle gelesenen Kapitel pro Serie.
- Gelesene Kapitel werden in der Kapitelliste mit `✓ GELESEN` und einer grünen Markierung angezeigt.
- Der Serienkopf zeigt `Gelesen: X/Y`.
- Ein Klick auf `Lesen` markiert das Kapitel automatisch als gelesen.
- `✓ Gelesen` kann angeklickt werden, um ein Kapitel wieder als ungelesen zu markieren.
- Bestehender v1.2.1-Fortschritt (`Zuletzt gelesen`) wird rückwärtskompatibel als gelesen erkannt.
- Keine zusätzliche CBZ-/Bildspeicherung; der Lesestatus liegt nur in SQLite.

## v1.2.1 – Online Reader & Progress Fix

- Fix: Kapitel werden vor jedem Online-Lesen frisch aus der Serienseite aufgelöst; stale Reader-URLs werden nicht wiederverwendet.
- Fix: Der integrierte Reader startet für jedes Kapitel in einem frischen Browserfenster und blockiert unerwartete Navigationen auf andere Titel.
- Fix: Nach erfolgreichem Öffnen wird der Lesefortschritt zuverlässig in der Online-Bibliothek gespeichert.
- Verbesserung: Falls „Lesen“ vor „☁ Merken“ benutzt wird, wird die Serie automatisch leichtgewichtig in der Online-Bibliothek gespeichert.
- Verbesserung: „Zuletzt gelesen: …“ wird zusätzlich direkt bei der geöffneten Serie angezeigt.

## v1.2.0 – Online Library

- Neue Online-Bibliothek: Serien können gespeichert werden, ohne Kapitel/CBZ-Dateien herunterzuladen.
- Gespeichert werden nur Titel, Cover, Quelle, URL, Sprache/Status und Lesefortschritt.
- Globale Online-Bibliotheksansicht über alle Quellen mit Suche und 10 Titeln pro Seite.
- „☁ Merken“ direkt bei einer geöffneten Serie.
- „Lesen“ bei jedem Kapitel öffnet die Reader-Seite live im integrierten Chromium-Browser.
- Zuletzt gelesene Kapitel werden pro gespeicherter Online-Serie gemerkt; „Weiterlesen“ öffnet sie direkt wieder.
- Online-Bibliothek ist Bestandteil von Backup/Restore.
- Normale CBZ-Downloads, Handy-Sync und Offline-Bibliothek bleiben unverändert nutzbar.

## v1.1.3 – Compact Pagination

- Standard page size changed from 50 to 10 entries.
- Page-size choices are now 10 / 25 / 50 / 100.
- Sources column uses a compact pager so controls fit cleanly in the narrow column.
- Previous v1.1.1/v1.1.2 page-size preference is intentionally reset once, so v1.1.3 starts at 10 entries.

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
