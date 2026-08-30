# Manhwa-Watcher-Data

This directory is used by Manhwa Watcher for portable runtime data next to the executable.

Typical local contents include `library.db`, settings, logs, connector recipes, reading progress and other user-specific state. Those files are intentionally ignored by Git and must not be committed.

Keeping only this README and `.gitignore` in the repository makes sure the expected folder exists after cloning without publishing personal library data.
