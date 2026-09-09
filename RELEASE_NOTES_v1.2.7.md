# Manhwa Watcher v1.2.7

## Toomics runtime fix

- Removes the nested Toomics regex that caused Electron executeJavaScript to fail at runtime.
- Parses Toomics episode routes in the main process instead of inside the renderer script.
- Keeps Toomics episode detection for /webtoon/detail/code/<code>/ep/<episode>/toon/<toonId>.
- Adds a BrowserSession-backed cover fallback for Toomics cover images that require cookies/referer.
- Keeps the v1.2.6 lazy-cover detection, v1.2.5 catalog fixes and v1.2.4 mixed-chapter protection.
