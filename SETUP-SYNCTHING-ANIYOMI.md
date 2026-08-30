# Manhwa Watcher v1.0.2 + Syncthing + Aniyomi

## Ziel

Manhwa Watcher behält die vollständige Sammlung im normalen Downloadordner. Nur ausgewählte Serien werden zusätzlich in einen separaten PC-Sync-Ordner gespiegelt. Syncthing überträgt diesen Ordner auf Android direkt in Aniyomis `local`-Ordner.

Beispiel PC:

```text
D:\Manhwas\                         <- Master-Bibliothek
D:\Aniyomi-Sync\                    <- nur fürs Handy markierte Serien
  Serie A\
    Chapter 1.cbz
    Chapter 2.cbz
```

Beispiel Android:

```text
Aniyomi\
  local\
    Serie A\
      Chapter 1.cbz
      Chapter 2.cbz
```

## 1. Manhwa Watcher v0.9 einrichten

1. Manhwa Watcher v0.9 starten.
2. Oben auf **Handy-Sync** klicken.
3. **Ordner wählen** anklicken.
4. Einen eigenen Ordner anlegen, z. B. `D:\Aniyomi-Sync`.
5. Eine Serie im normalen Browser öffnen.
6. Rechts oben **📱 Sync** aktivieren.
7. Vorhandene CBZs dieser Serie werden in `D:\Aniyomi-Sync\Serienname\` gespiegelt.
8. Für weitere Serien wiederholen.
9. **Jetzt synchronisieren** gleicht alle markierten Serien manuell ab.

Neue Kapitel werden automatisch gespiegelt, sobald Manhwa Watcher sie fertig als CBZ gespeichert hat.

## 2. Syncthing auf Windows

1. Syncthing für Windows installieren/entpacken und einmal starten.
2. Weboberfläche öffnen (standardmäßig lokal über Port 8384).
3. **Add Folder / Ordner hinzufügen** wählen.
4. Pfad: `D:\Aniyomi-Sync`.
5. Einen eindeutigen Ordnernamen/ID vergeben, z. B. `aniyomi-local`.
6. Empfohlen: Ordner-Typ auf **Send Only / Nur senden** stellen.
7. Den Android-Syncthing-Client als Gerät hinzufügen und diesen Ordner mit ihm teilen.

## 3. Android / Syncthing

Die ursprüngliche offizielle Syncthing-Android-App wurde eingestellt. Verwende einen aktuell gepflegten Android-Client, der mit Syncthing kompatibel ist.

1. Android-Syncthing-Client installieren.
2. PC und Handy über ihre Geräte-IDs miteinander verbinden.
3. Die Freigabe `aniyomi-local` vom PC annehmen.
4. Als lokalen Zielpfad den `local`-Ordner innerhalb der in Aniyomi gewählten Speicherposition auswählen.
5. Empfohlen: Ordner-Typ auf **Receive Only / Nur empfangen** stellen.
6. Synchronisierung starten und warten, bis der Ordner aktuell ist.

## 4. Aniyomi

1. In Aniyomi unter Speicher/Storage eine Speicherposition festlegen.
2. Innerhalb dieser Position muss der Ordner `local` existieren.
3. Syncthing muss die Dateien genau dort ablegen:

```text
<ANIYOMI-SPEICHER>\local\Serienname\Chapter 1.cbz
```

4. In Aniyomi zu **Browse / Durchsuchen -> Sources / Quellen -> Local source** wechseln.
5. Die synchronisierten Serien sollten dort erscheinen.
6. Wenn neue CBZs übertragen wurden, die Kapitelliste der lokalen Serie in Aniyomi aktualisieren (Pull-to-refresh).

## Sicherheit der Daten

Die Master-Bibliothek von Manhwa Watcher bleibt vom Handy-Sync getrennt. Der Handy-Sync kopiert nur CBZs und löscht nichts aus dem normalen Downloadordner. Für Syncthing wird **Send Only** am PC und **Receive Only** am Handy empfohlen, damit versehentliche Änderungen auf dem Smartphone nicht in die PC-Sync-Quelle zurückgeschrieben werden.
