# Manhwa Watcher v1.2.6

## Toomics covers and chapters hotfix

- Tries all lazy-load image sources instead of discarding real covers after a placeholder.
- Adds a Toomics-specific episode fallback for `/webtoon/detail/code/<code>/ep/<episode>/toon/<toonId>` routes.
- Detects Toomics episode URLs embedded in rendered HTML, data attributes or onclick markup.
- Keeps all v1.2.5 catalog/status fixes and the v1.2.4 mixed-chapter protection.
