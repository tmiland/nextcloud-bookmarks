# AMO listing — Nextcloud Bookmarks 0.2.0

This file is the source for the AMO listing and the reviewer notes. It is not
packaged with the extension.

## Listing

- **Name:** Nextcloud Bookmarks
- **Slug:** `nextcloud-bookmarks`
- **Summary:** Unofficial Firefox client for Nextcloud Bookmarks: quick-save,
  search, organize, and import.
- **Category:** Bookmarks
- **License:** MIT
- **Homepage:** `https://github.com/tmiland/nextcloud-bookmarks`
- **Support:** `https://github.com/tmiland/nextcloud-bookmarks/issues`
- **Default locale:** `en-US`
- **Privacy policy:** `https://github.com/tmiland/nextcloud-bookmarks/blob/main/privacy_policy.md`

### Description

Unofficial Firefox client for the Nextcloud Bookmarks app. Save the current page
with a title, note, tags, and one or more Nextcloud folders; use `Alt+Shift+S` or
the page context menu for one-action quick save with Undo. The extension detects
when a page is already saved and offers Update or Delete instead of creating a
duplicate. Search by text or tags with AND/OR matching, sort results, scope by
folder, filter untagged/broken/duplicate bookmarks, page through results, and
edit or open any result.

Folders, tags, and an account-scoped bookmark index are cached locally, so the
popup opens quickly and read-only search keeps working when the server is
unreachable. The extension can create and rename folders, and it can import
Firefox bookmarks while recreating the Firefox folder tree. Imports run
concurrently, skip duplicate URLs, and can be resumed after a cancel.

Use a revocable Nextcloud app password, including with two-factor
authentication. Host access is requested only for the Nextcloud server you
configure; Firefox bookmarks access is optional and requested only when you use
the import. No telemetry or third-party services; data goes only to your own
Nextcloud server. The UI is available in English and Norwegian Bokmål.

This is an independent, unofficial project and is not affiliated with
Nextcloud.

## Permission justifications

- `storage` — persist settings, folder/tag caches, the last-used folder, and a
  resumable import job locally.
- `activeTab` — read the active tab URL/title only after the user opens the
  popup, presses `Alt+Shift+S`, or chooses a context-menu item.
- `menus` — provide “Save page to Nextcloud” and “Save with details…” context
  menu items.
- `scripting` — inject the quick-save toast with the Undo button into the active
  tab after the user invokes quick save. It does not read page content.
- `notifications` — show save feedback when the active page cannot be scripted
  (for example `about:` pages).
- Optional host permission `https://*/*`, `http://localhost/*`,
  `http://127.0.0.1/*` — requested per configured Nextcloud origin at settings
  save time. Persistent access is limited to the approved origin.
- Optional `bookmarks` — read the Firefox bookmark tree only for the manual
  one-way import, after the user clicks “Allow bookmarks access”.

## Data collection declaration

- `authenticationInfo` — Basic auth against the user’s Nextcloud server.
- `bookmarksInfo` — bookmark fields read from/written to Nextcloud.
- `browsingActivity` — active tab URL/title at the moment the user invokes save.
- `searchTerms` — search text and tags entered by the user.

No data is sent anywhere except the Nextcloud server configured by the user.

## Reviewer test plan

A Nextcloud instance with the **Bookmarks** app installed is required.

1. Install the add-on, open Settings, and enter the Nextcloud base URL, username,
   and an app password. Grant host access.
2. Open any web page, press `Alt+Shift+S`. Confirm the bookmark is created and
   the toast appears; click Undo and confirm it is removed.
3. Open the popup, pick two folders (one shared if available), add tags and a
   note, save, then reopen the popup on the same page and confirm Update/Delete
   are offered.
4. Open Find, search by text and tag, change sort/filter/folder, use Load more,
   edit a result, and open it in Nextcloud.
5. In Settings, create a folder and rename it. Deleting folders is intentionally
   left to Nextcloud.
6. Grant bookmarks access, choose a Firefox folder, preview, enable “Recreate
   folder structure”, and import. Cancel mid-import and confirm Resume/Discard
   appears. Re-importing the same folder should skip duplicate URLs.
7. Revoke host access and confirm the popup asks for access instead of failing
   silently. Use a wrong password and confirm the 401 message.

## Trademark note

The add-on name uses “Nextcloud” descriptively, matching the upstream app name.
The listing and README state that this is unofficial and unaffiliated. If AMO
asks for a change, the fallback name is **Bookmarks for Nextcloud**; that is a
product/identity decision for the maintainer.

## Release checklist

- [ ] Decide the GitHub owner/repo (`tmiland` vs `tmiland-lab`) and create it.
- [ ] Decide the AMO account and add `WEB_EXT_API_KEY`/`WEB_EXT_API_SECRET` as
  repository secrets.
- [ ] Confirm the add-on name and trademark position.
- [ ] Run `npm test`, `npm run lint`, `npm run build`, and
  `npm run test:integration` on the release commit.
- [ ] Install `web-ext-artifacts/nextcloud_bookmarks-0.2.0.zip` in a fresh
  Firefox profile and complete the reviewer test plan once by hand.
- [ ] Tag `v0.2.0`; the release workflow builds and optionally signs it.
- [ ] Submit/complete the AMO listing with this metadata and the screenshots.
