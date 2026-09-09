# Manhwa Watcher v1.2.5

## Toomics catalog hotfix

- Uses `/de/webtoon/ranking` as the Toomics catalog.
- Accepts only `/webtoon/episode/toon/<id>` as real Toomics series links.
- Filters navigation entries such as Genres, My Library, New and Search from the series list.
- Normalizes Toomics title URL variants before deduplication.
- Recognizes German Toomics status hints such as `Ende`, `Abgeschlossen`, `Aktualisiert` and `Fol+`.
