# Nextcloud Bookmarks

[![Version](https://img.shields.io/github/manifest-json/v/tmiland/nextcloud-bookmarks?filename=extension%2Fmanifest.json&label=version)](https://github.com/tmiland/nextcloud-bookmarks)
[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)
[![Firefox 142+](https://img.shields.io/badge/Firefox-142%2B-orange?logo=firefoxbrowser&logoColor=white)](https://www.mozilla.org/firefox/)
[![Manifest V3](https://img.shields.io/badge/Manifest-V3-blue)](https://extensionworkshop.com/documentation/develop/manifest-v3-migration-guide/)
[![Sponsor @tmiland](https://img.shields.io/badge/Sponsor-%40tmiland-ea4aaa?logo=githubsponsors&logoColor=white)](https://github.com/sponsors/tmiland)

An unofficial Firefox client for the [Nextcloud Bookmarks](https://github.com/nextcloud/bookmarks)
app: quick-save the current page, search and organize your bookmarks, and import
Firefox bookmarks manually.

> **Unofficial. Not affiliated with Nextcloud.** Nextcloud and Nextcloud
> Bookmarks are separate open-source projects. This extension is an independent
> client for the public Bookmarks REST API.

**Status:** v0.2.0 · Firefox MV3 · AMO submission not yet made.

## Screenshots

| Bookmark popup | Search results |
| --- | --- |
| <img src="docs/screenshots/popup.png" alt="Bookmark popup with folders, tags, and note" width="360"> | <img src="docs/screenshots/search.png" alt="Search results with tags, edit, open, and delete actions" width="360"> |

<p align="center">
  <img src="docs/screenshots/options.png" alt="Settings, folder management, and manual Firefox bookmark import" width="720">
  <br>
  <sub>Settings, folder management, and the manual Firefox → Nextcloud import.</sub>
</p>

## Features

- **One-action quick save** from the keyboard (`Alt+Shift+S`) or the page
  context menu, using your last-used folder. A toast offers **Undo**; restricted
  pages fall back to a notification and toolbar badge.
- Save the current page with a title, note, tags, and **one or more Nextcloud
  folders** (including shared folders you can write to).
- **Current-page detection**: if the page is already saved, load the stored
  title, note, tags, and folders, and offer **Update** or **Delete** instead of
  creating a duplicate.
- **Folder picker** from your Nextcloud folder tree, with last-used folder
  memory and inline **new folder** creation. Settings can create and rename
  folders; deleting folders stays in Nextcloud.
- **Tag autocomplete** from the tags already present in Nextcloud.
- Search by text, by one or more tags, with AND/OR matching, sorting, folder
  scoping, and filters for untagged, broken, and duplicated bookmarks.
- **Edit any result** in the form, open it in the Nextcloud web app, or delete
  it with an inline confirmation. Results support **Load more** paging.
- **Local-first reads**: folders, tags, and an account-scoped bookmark index are
  cached locally. Search is instant from the index and falls back to cached
  results when the server is unreachable.
- **Manual one-way import** of Firefox bookmarks with an option to recreate the
  Firefox folder tree in Nextcloud. Import runs concurrently, skips duplicate
  URLs, reports progress, and can be resumed or discarded after a cancel.
- Nextcloud **app password** support, including two-factor authentication.
- Optional per-server host access: the extension requests access only to the
  Nextcloud origin you configure.
- English and Norwegian Bokmål UI. Follows the active Firefox light/dark theme
  using Firefox’s design colors.

It does **not** run automatic or two-way synchronization, and writes require the
server. Offline mode is read-only search from the local index.

## Install

### Temporary (development)

1. Open Firefox → `about:debugging#/runtime/this-firefox`.
2. Click **Load Temporary Add-on…**.
3. Select `extension/manifest.json` from this repository.
4. Open the toolbar icon → **Settings**.
5. Enter your Nextcloud base URL, username, and app password, then **Save**.
6. Allow access to your Nextcloud server when Firefox asks.

### AMO

The add-on has not been submitted to AMO yet. AMO-listed builds update through
AMO automatically; the manifest intentionally has **no `update_url`**.

## Setup

1. Install the **Bookmarks** app in your Nextcloud instance.
2. In Nextcloud, open **Settings → Security → App passwords** and create a
   dedicated password for this extension. Do not use your main account
   password, especially if two-factor authentication is enabled.
3. In the extension settings, enter:
   - **Server URL** — the Nextcloud base URL, for example
     `https://cloud.example.com` or `https://cloud.example.com/nextcloud`.
     Remote servers must use HTTPS; `http://localhost` and `http://127.0.0.1`
     are allowed for local testing.
   - **Username** — your Nextcloud username.
   - **App password** — the password created in step 2.
4. Click **Save settings** and allow access to the configured server.
5. Open the toolbar icon. The current page’s URL and title are filled in
   automatically.

### Keyboard shortcuts

- `Alt+Shift+S` — save the current page to the last-used folder.
- `Alt+Shift+B` — open the popup.

You can change both shortcuts in Firefox’s **Manage Extension Shortcuts** page.

## Permissions and privacy

- `storage` — stores the server URL, username, app password, UI preference,
  folder/tag cache, last-used folder, and resumable import state locally in
  Firefox.
- `activeTab` — reads the current tab’s URL and title after you open the popup,
  press the quick-save shortcut, or use the context menu.
- `menus` — adds the **Save page to Nextcloud** context-menu items.
- `scripting` — injects the small quick-save toast into the active page after a
  user action. It does not read page content.
- `notifications` — shows a fallback notification when the toast cannot be
  injected, such as on a restricted page.
- Optional host access — requested only for the Nextcloud origin you configure.
- Optional `bookmarks` — requested only when you open the Firefox import
  section; it reads the Firefox bookmark tree for preview/import.

The extension sends data only to the Nextcloud server you configure:

- authentication information with every API request;
- the current page URL/title and the bookmark title, note, tags, and folders you
  enter;
- search terms, tags, sort/filter parameters, and folder IDs;
- the Firefox bookmarks you explicitly preview/import (URL, title, and folder
  names), only after you grant the optional `bookmarks` permission.

There is no telemetry, analytics, remote logging, or third-party service. The app
password is stored locally in Firefox’s extension storage; use a revocable app
password. The local bookmark index lives in IndexedDB and is scoped to the
server/username pair. See [privacy_policy.md](privacy_policy.md).

## How it works

The extension uses the Nextcloud Bookmarks **REST API v2**:

```text
GET    /index.php/apps/bookmarks/public/rest/v2/bookmark?url={url}
GET    /index.php/apps/bookmarks/public/rest/v2/bookmark
POST   /index.php/apps/bookmarks/public/rest/v2/bookmark
PUT    /index.php/apps/bookmarks/public/rest/v2/bookmark/{id}
DELETE /index.php/apps/bookmarks/public/rest/v2/bookmark/{id}
GET    /index.php/apps/bookmarks/public/rest/v2/folder
POST   /index.php/apps/bookmarks/public/rest/v2/folder
PUT    /index.php/apps/bookmarks/public/rest/v2/folder/{id}
GET    /index.php/apps/bookmarks/public/rest/v2/tag
```

Requests use HTTP Basic auth. Create and update requests send tags as top-level
`tags[]` and folders as `folders[]`. The Firefox import is a manual, one-way
POST loop; it does not run in the background and never deletes or edits Firefox
bookmarks.

## Development

```sh
# Unit and DOM tests
npm test

# Real Firefox integration tests (mock Nextcloud + headless Marionette)
npm run test:integration

# AMO lint and packaging
npm run lint
npm run build
```

The integration runner needs Python 3, `marionette-driver`, Firefox, `zip`, and
`curl`. Install the Python dependency with:

```sh
python3 -m pip install -r test/integration/requirements.txt
```

The build packages only the `extension/` directory via `web-ext-config.cjs`.

Main files:

- `extension/src/popup.mjs` — popup UI, quick save interactions, search,
  folder picker, and local index/search.
- `extension/src/options.mjs` — settings, folder management, and the manual
  Firefox import.
- `extension/src/background.mjs` — quick-save command, context menus, toast,
  and undo.
- `extension/src/api.mjs` — Nextcloud REST client.
- `extension/src/store.mjs` / `sync.mjs` — IndexedDB bookmark index.
- `extension/src/search.mjs` — local filtering, sorting, and paging.
- `extension/src/import.mjs` — tree-aware import planning and resumable runner.
- `extension/src/settings.mjs` / `cache.mjs` / `folders.mjs` — shared helpers.
- `extension/manifest.json` — Firefox MV3 manifest.

## Limitations

- Firefox only.
- No automatic or two-way synchronization. The Firefox import is manual and
  one-way (Firefox → Nextcloud).
- Offline mode is read-only: searches use the cached index, but creates,
  updates, and deletes need the server.
- Shared folders are shown and can be preserved, but the server decides whether
  you may write to them.
- Import preserves the Firefox folder tree by default. Empty Firefox folders
  are not created because the import is bookmark-driven.
- Large imports run with five concurrent requests and can be resumed after a
  cancel or a closed settings tab.
- Remote Nextcloud servers must use HTTPS. A self-signed certificate must be
  trusted by Firefox.

## Troubleshooting

- **“Authentication failed”** — use a Nextcloud app password, not your main
  password. Check the username and server URL.
- **“Access to your Nextcloud server is required”** — open **Settings** and
  grant server access for the configured origin.
- **“Bookmarks API not found”** — install/enable the Nextcloud Bookmarks app and
  check that the server URL is the Nextcloud base URL.
- **Tags are missing** — this client sends the top-level `tags[]` parameter
  required by Bookmarks 3.x.
- **Quick save does nothing** — check the shortcut in Firefox’s extension
  shortcuts page, and make sure the page is not restricted (`about:`,
  `addons.mozilla.org`, PDF viewer, and similar pages cannot be scripted).
- **Search shows cached results** — the server was unreachable, so the last
  local index is shown. Reconnect and use **Refresh index**.
- **Import says “0 new”** — every URL in the selected Firefox folder already
  exists in Nextcloud, or the folder is empty. Duplicates are skipped by URL.
- **“Allow bookmarks access”** — the import needs the optional Firefox
  `bookmarks` permission. It is requested only when you click that button.

## Contributing

Issues and pull requests are welcome. Please keep changes focused, run
`npm test` and `npm run test:integration`, and describe the Firefox and Nextcloud
Bookmarks versions you tested.

## Support

If this extension saves you time, you can support development via
[GitHub Sponsors](https://github.com/sponsors/tmiland).

Bug reports and feature requests:
[GitHub Issues](https://github.com/tmiland/nextcloud-bookmarks/issues).

## AI assistance

This release was built with **DeepSeek V4.1 Flash** in OpenCode, with direction,
testing, and review from the maintainer. Review the source before deploying it.

## License

MIT — see [LICENSE](LICENSE). This is an unofficial project, not affiliated with
Nextcloud.
