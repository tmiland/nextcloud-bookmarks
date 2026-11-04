# Privacy Policy

Nextcloud Bookmarks (the Firefox extension in this repository) communicates
**only** with the Nextcloud server URL you configure. There is no telemetry,
analytics, remote logging, tracking, or third-party service.

This is an unofficial project and is not affiliated with Nextcloud.

## Data stored locally

Firefox extension storage (`browser.storage.local`) contains:

- the Nextcloud server URL;
- your Nextcloud username;
- the Nextcloud app password you enter;
- whether the Bookmark or Search tab is shown first;
- the last Nextcloud folder you selected;
- cached folder and tag lists, keyed by server and username;
- a resumable Firefox-import job, if one is in progress.

The extension also keeps an account-scoped bookmark index in IndexedDB so search
can work instantly and read-only from cache when the server is unreachable. It
contains the bookmark fields returned by your server (URL, title, description,
tags, folders, timestamps, and availability). It is not sent anywhere.

The password is stored locally in Firefox’s extension storage. Use a dedicated,
revocable Nextcloud app password rather than your main account password.

## Data sent to your Nextcloud server

When you use the extension, it sends the following to the server you configured:

- **Authentication information** — username and app password with every API
  request, using HTTP Basic auth.
- **Bookmark information** — the current page URL/title and the title, note,
  tags, and folders you enter when saving a bookmark.
- **Browsing activity** — the URL and title of the active tab, read only after
  you open the popup, press the quick-save shortcut, or use the context menu.
- **Search terms** — the text, tags, sort/filter parameters, and folder scope you
  enter when searching your bookmarks.
- **Folder changes** — the folder titles and parent folders you create or rename
  in the extension.

This data is sent to your own Nextcloud server and is not received by the
extension’s developer or any third party. The extension does not read page
content; host access is limited to the Nextcloud origin you approve.

## Quick save and page access

Quick save uses Firefox’s `activeTab` permission, granted only when you invoke
the extension with its shortcut or context menu. The extension reads the active
tab’s URL and title to create the bookmark. After a successful save it injects a
small Shadow-DOM toast with an Undo button into that tab using the `scripting`
permission. The toast reads no page content and is removed automatically. On
restricted pages, where injection is not allowed, the extension shows a system
notification instead.

## Firefox bookmark import

If you grant the optional Firefox `bookmarks` permission and use the import
section, the extension reads the selected Firefox folder tree (bookmark URLs,
titles, and folder names) and sends the selected bookmarks to your Nextcloud
server. With folder recreation enabled, it also creates matching Nextcloud
folders. It does not modify or delete Firefox bookmarks. The permission is
requested only when you click **Allow bookmarks access**, and you can revoke it
at any time.

## Permissions

- `storage` — save settings, caches, and the resumable import state locally.
- `activeTab` — read the current tab’s URL/title after you invoke the extension.
- `menus` — add the quick-save context-menu items.
- `scripting` — inject the quick-save toast into the active page after a user
  action.
- `notifications` — show fallback save feedback on restricted pages.
- Optional host access — requested only for the Nextcloud origin you configure.
- Optional `bookmarks` — requested only for the manual Firefox import.

You can revoke host access or bookmark access at any time in Firefox’s extension
settings. Without host access, the extension cannot reach your Nextcloud server.

## Contact

Bug reports and privacy questions:
[GitHub Issues](https://github.com/tmiland/nextcloud-bookmarks/issues).
