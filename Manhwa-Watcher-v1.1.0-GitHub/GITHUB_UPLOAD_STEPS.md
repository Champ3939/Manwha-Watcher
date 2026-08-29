# GitHub Upload – Kurz-Anleitung

## 1. Repository erstellen

Auf GitHub ein neues Repository anlegen, z. B. **Manhwa-Watcher**.

Empfehlung:

- Public oder Private nach Wunsch
- README **nicht** automatisch erzeugen (ist bereits enthalten)
-  **nicht** automatisch erzeugen
- License **nicht** automatisch erzeugen (MIT-Lizenz ist bereits enthalten)

## 2. Repository-Inhalt hochladen

Den **Inhalt** dieser GitHub-ZIP entpacken und in das Repository übernehmen.

Mit Git über PowerShell/CMD:

```bash
git init
git add .
git commit -m "Release v1.1.0"
git branch -M main
git remote add origin <DEINE-REPOSITORY-URL>
git push -u origin main
```

Vor `git add .` prüfen, dass **kein** `Manhwa-Watcher-Data`-Ordner im Repository liegt.

## 3. GitHub Release erstellen

Unter **Releases -> Draft a new release**:

- Tag: `v1.1.0`
- Titel: `Manhwa Watcher v1.1.0`
- Beschreibung: Inhalt aus `RELEASE_NOTES_v1.1.0.md`
- Release Asset: `Manhwa-Watcher-v1.1.0-Windows-x64.zip`

SHA-256 des bereitgestellten Windows-Builds:

```text
cf8ef1ecf4da92fb129b5dc1a73bc77b668491272b6c18d697feb23e0a999401  Manhwa-Watcher-v1.1.0-Windows-x64.zip
```

## 4. Nicht ins Repository hochladen

- `Manhwa-Watcher-Data/`
- `library.db` / `library.json`
- heruntergeladene CBZ-Dateien
- Logs
- Backups
- lokale Sync-Ordner
- Cookies/Tokens/Zugangsdaten

Die mitgelieferte `.gitignore` deckt diese typischen Fälle ab.
