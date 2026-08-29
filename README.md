Manhwa Watcher v1.1.0

Manhwa Watcher is a portable Windows application for browsing manga/manhwa catalogs, managing a local library, checking for new chapters, and downloading supported content as CBZ files.

Use Manhwa Watcher only with websites and content for which automated downloading is permitted. You are responsible for complying with the terms of service and copyright rules of the sources you use.

Highlights

Browse complete manga/manhwa catalogs

Search and filter series

Download individual chapters, selected chapters, search results, or a complete catalog

Store chapters as CBZ

Generate ComicInfo.xml metadata

Detect already downloaded chapters

Scan for new chapters and download updates

Scheduled automatic update scans

Download queue with retry handling

English/German download language filtering

Series status filtering

Favorites and reading list

"What's New" dashboard for recently updated series

Saved websites / catalog sources

Portable SQLite library database

Library health checks and automatic repair

Backup and restore

Syncthing / Aniyomi phone sync

Connector laboratory for creating and testing website recipes

Generic automatic website detection

System Requirements

Windows 10 or Windows 11

64-bit x86/AMD64 system

Internet connection

Enough free disk space for your library

No separate Electron, Node.js, or Python installation is required for the portable Windows build.

Quick Start

Extract the ZIP file to a folder of your choice.

Start:

Manhwa Watcher.exe

Choose your download folder.

Add or select a website/catalog source.

Load the catalog.

Select a series.

Select one or more chapters and download them.

Manhwa Watcher stores its portable application data next to the executable in:

Manhwa-Watcher-Data\

Do not delete this folder if you want to keep your settings, database, download history, saved websites, and connectors.

Library Storage

Starting with v1.1.0, the primary library database is:

Manhwa-Watcher-Data\library.db

Manhwa Watcher now uses SQLite for its main persistent data.

If an older installation contains:

Manhwa-Watcher-Data\library.json

it is automatically imported into SQLite on first launch.

The old JSON file is not deleted.

This makes upgrading from older Manhwa Watcher versions safer and keeps existing library information compatible.

Download Structure

Each series gets its own directory.

Example:

D:\Manhwas\
├── Series A\
│   ├── Chapter 1.cbz
│   ├── Chapter 2.cbz
│   └── Chapter 3.cbz
│
└── Series B\
    ├── Chapter 1.cbz
    └── Chapter 2.cbz

Images inside a CBZ are stored in reading order:

001.webp
002.webp
003.webp
...

Incomplete downloads use a temporary file and are not exposed as completed CBZ files until the chapter has finished successfully.

ComicInfo.xml

Downloaded CBZ files can contain ComicInfo.xml metadata.

This improves compatibility with comic and manga library software that supports ComicInfo metadata.

The metadata can include information such as:

Series title

Chapter title/number

Language

Source information

Other available series metadata

Browsing a Catalog

The main interface follows a HakuNeko-style workflow:

Source -> Series -> Chapters

Sources

You can either:

Select a configured connector

Use a saved website

Enter a catalog URL manually

Series

After loading a catalog, Manhwa Watcher displays the detected series.

You can:

Search the catalog

Filter by series status

Show only favorites

Show only your reading list

Open a series to load its chapters

Chapters

When a series is selected, its chapters appear in the chapter list.

You can:

Download one chapter

Select multiple chapters

Select all chapters

Download all chapters

Hide already downloaded chapters

Already downloaded chapters are detected from both the library database and existing files on disk.

Saved Websites

Use the Websites section to save catalog websites permanently.

A saved website contains a name and catalog URL.

This allows you to open commonly used sources without entering the URL again every time.

Saved websites appear in the Sources area and are stored in the portable library data.

Full Catalog Download

The Download Entire Source function can process a complete loaded catalog.

Manhwa Watcher:

Goes through the detected series one by one

Loads their chapter lists

Checks which CBZ files already exist

Downloads only missing chapters

Skips completed files

Continues when an individual series/chapter fails

Large jobs support:

Pause

Resume

Cancel

Progress information

Existing-file detection

For large catalogs, leaving a reasonable request delay configured is recommended.

Search Result Download

Catalog search results can also be downloaded as a batch.

This makes it possible to search for a group of titles and download the matching series without downloading the complete catalog.

Language Filter

Manhwa Watcher can restrict automatic downloads by detected language.

The default configuration allows:

EN  English
DE  German

Other detected languages are skipped.

There is also an option to allow:

?  Unknown language

Keep Unknown language disabled if you only want clearly detected English and German releases.

Language filtering applies to automated/batch download paths such as catalog downloads and update processing.

Language detection depends on the information exposed by each website. Some websites do not provide reliable language metadata.

Series Status Filter

Catalog entries can be filtered by status.

Supported categories include:

Ongoing

Completed

Hiatus

Upcoming

Cancelled

Dropped

Unknown

The Check Status function can inspect series pages and update detected status information.

A status debug view is also available for troubleshooting detection.

Favorites

Open a series and use:

☆ Favorite

Favorites are stored in the SQLite library.

You can enable the Favorites filter above the series list to display only favorite titles.

Reading List

Open a series and use:

📖 Reading List

The Reading List is separate from Favorites.

Use the Reading List filter to display only titles you have added to it.

Update Scan

The Scan for Updates button checks known/downloaded/watched series for new chapters.

The update scanner compares the current chapter list against your local library and existing downloads.

When new chapters are found, Manhwa Watcher can download the missing newer chapters.

The scan is designed to update your collection rather than blindly redownload existing CBZ files.

Automatic Update Scans

Automatic update scans can be enabled in the main interface.

Available options include:

Enable automatic updates

Configure an interval in hours

Run an update scan when Manhwa Watcher starts

This is useful when Manhwa Watcher runs regularly on a PC that stores your library.

What's New Dashboard

v1.1.0 includes a What's New dashboard.

It shows series where the latest update scan found new chapters.

A counter in the application header indicates how many updated series are currently listed.

This provides a quick way to see what changed without browsing the full library.

Downloads and Queue

The Downloads view shows downloaded chapter information.

The Queue view provides information about queued download work.

Download processing includes retry/error handling and visible progress states.

Existing CBZ files are detected and normally skipped rather than downloaded again.

Library Tools

The Library section provides tools for inspecting the local collection.

v1.1.0 includes functionality for:

Storage overview

Library health checks

CBZ integrity checks

Detecting inconsistencies

Repairing library metadata/state

Automatic library repair where possible

These tools are useful after moving files manually, restoring a backup, or upgrading from an older version.

Backup and Restore

v1.1.0 uses the newer backup format.

A backup can include:

library.db SQLite database

A readable JSON compatibility snapshot

Connector recipes

Older v1.0.x JSON backups can still be restored.

After restoring older data, Manhwa Watcher automatically migrates it to SQLite.

Keeping occasional backups is strongly recommended if you have a large library.

Phone Sync: Syncthing + Aniyomi

Manhwa Watcher can mirror selected series to a separate phone-sync folder.

The idea is:

Manhwa Watcher library
        |
        v
PC Sync Folder
        |
        v
Syncthing
        |
        v
Android / Aniyomi local folder

PC

In Phone Sync:

Choose a dedicated sync folder, for example:

D:\Aniyomi-Sync

Open a series.

Enable:

📱 Sync

Existing CBZ files for that series are copied to the sync folder.

Future downloaded chapters for synced series are copied automatically.

Your main library remains separate.

Example:

D:\Manhwas\Series A\Chapter 10.cbz

is mirrored to:

D:\Aniyomi-Sync\Series A\Chapter 10.cbz

Syncthing

Recommended configuration:

PC folder type

Send Only

Android folder type

Receive Only

Share the PC sync folder with your Android device.

Aniyomi

On Android, configure the Syncthing destination as Aniyomi's local manga directory:

<ANIYOMI STORAGE>\local\

The final layout should look like:

local\
└── Series A\
    ├── Chapter 1.cbz
    ├── Chapter 2.cbz
    └── Chapter 3.cbz

Open Aniyomi's Local source and refresh the series/chapter list after new files arrive.

Connector System

Manhwa Watcher supports multiple ways of understanding websites.

Recipe Connectors

Recipe connectors describe a website using selectors and rules.

They are stored in the connector directory inside the portable data folder.

Automatic Detection

If there is no dedicated connector, Manhwa Watcher can attempt generic detection for:

Catalog entries

Series pages

Chapter links

Reader images

Automatic detection is convenient but may not work on every website.

Connector Laboratory

The Connector Laboratory is intended for creating and troubleshooting website recipes.

It includes tools for:

Loading a page in the embedded Chromium browser

Showing/hiding the browser

Restarting the browser

Opening DevTools

Clearing site data

Analyzing the DOM

Picking elements directly from the page

Testing title selectors

Testing chapter selectors

Testing page/image selectors

Highlighting matched elements

Saving recipe connectors

The normal browsing interface should be used for everyday downloads. The Connector Laboratory is primarily a setup/debugging tool.

Embedded Browser and Network Handling

Manhwa Watcher includes an Electron/Chromium browser engine for websites that require JavaScript rendering.

The application can maintain browser cookies/session state and use alternative request paths when normal renderer navigation fails.

Some websites may still change their layout, API, anti-bot behavior, or access rules and therefore require connector updates.

Portable Data

Manhwa Watcher is designed to remain portable.

Typical layout:

Manhwa-Watcher-v1.1.0-Windows-x64\
├── Manhwa Watcher.exe
├── Manhwa-Watcher-Data\
│   ├── library.db
│   ├── library.json        (may exist after migration)
│   ├── Connectors\
│   ├── Logs\
│   └── ...
└── ...

To move Manhwa Watcher to another drive or PC, copy the application directory together with Manhwa-Watcher-Data.

Your actual manga library may be stored elsewhere.

Upgrading From an Older Version

Recommended procedure:

Close the old Manhwa Watcher version.

Keep a backup of:

Manhwa-Watcher-Data

Extract the new version.

Copy your existing Manhwa-Watcher-Data folder next to the new executable.

Start Manhwa Watcher.

Allow the application to perform any required migration.

For v1.1.0, an existing library.json is automatically imported into library.db.

Troubleshooting

A catalog loads only some series

Reload the full catalog. Websites using pagination, infinite scrolling, or dynamically loaded entries may require additional detection work.

A series opens but no chapters are found

The website layout may have changed or automatic detection may not recognize its chapter links.

Try a dedicated recipe connector or use the Connector Laboratory.

A download does not start

Check:

The chapter status shown in the UI

The Debug Log

Whether the website requires a browser session

Whether the language/status filter is excluding the entry

Whether the CBZ already exists

ERR_BLOCKED_BY_CLIENT

Manhwa Watcher contains alternative reader/network handling for cases where Chromium blocks a navigation internally.

If a current source still fails, check the Debug Log for the final HTTP or parsing error.

A downloaded chapter is not shown as downloaded

Open/reload the series. Manhwa Watcher can reconcile existing CBZ files with its library state.

The Library repair tools can also be used for inconsistencies.

Syncthing is connected but Aniyomi shows nothing

Verify that the Android destination is directly:

<ANIYOMI STORAGE>\local

and not an extra nested folder such as:

<ANIYOMI STORAGE>\local\Aniyomi-Sync

Then refresh Aniyomi's Local source.

Logs

Debug information is stored in the portable data directory.

Typical location:

Manhwa-Watcher-Data\Logs\

Use the Debug Log button in the application when troubleshooting website detection or download errors.

Version 1.1.0

v1.1.0 is the planned feature-freeze release.

Major changes include:

SQLite as the primary data store

Automatic migration from library.json

Favorites

Reading List

What's New dashboard

What's New counter

Backup v2 with SQLite + JSON snapshot + connectors

Compatibility with older v1.0.x backups

Existing v1.0.2 functionality remains available, including:

CBZ downloads

ComicInfo metadata

Download queue

Scheduled updates

Status and language filters

Full catalog / search-result downloads

Library health and repair tools

Phone sync

Future releases after v1.1.0 are intended to focus primarily on bug fixes, website compatibility, and stability.

License

Manhwa Watcher is distributed under the MIT License.

Third-party components such as Electron/Chromium are distributed under their respective licenses included with the application.
