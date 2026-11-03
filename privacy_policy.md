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
- the last Nextcloud folder you selected.

The password is stored locally in Firefox’s extension storage. Use a dedicated,
revocable Nextcloud app password rather than your main account password.

## Data sent to your Nextcloud server

When you use the extension, it sends the following to the server you configured:

- **Authentication information** — username and app password with every API
  request, using HTTP Basic auth.
- **Bookmark information** — the current page URL/title and the title, note,
  tags, and folder you enter when saving a bookmark.
- **Browsing activity** — the URL and title of the active tab, read only after
  you open the popup, so the bookmark form can be prefilled and checked against
  your saved bookmarks.
- **Search terms** — the text and tags you enter when searching your bookmarks.

This data is sent to your own Nextcloud server and is not received by the
extension’s developer or any third party. The extension does not read or modify
pages you visit; host access is limited to the Nextcloud origin you approve.

## Firefox bookmark import

If you grant the optional Firefox `bookmarks` permission and use the import
section, the extension reads the selected Firefox folder’s bookmark URLs and
titles and sends them to your Nextcloud server as new bookmarks. It does not
modify or delete Firefox bookmarks. The permission is requested only when you
click **Allow bookmarks access**, and you can revoke it at any time.

## Permissions

- `storage` — save settings locally.
- `activeTab` — read the current tab’s URL/title after you open the popup.
- Optional host access — requested only for the Nextcloud origin you configure.
- Optional `bookmarks` — requested only for the manual Firefox import.

You can revoke host access or bookmark access at any time in Firefox’s extension
settings. Without host access, the extension cannot reach your Nextcloud server.

## Contact

Bug reports and privacy questions:
[GitHub Issues](https://github.com/tmiland/nextcloud-bookmarks/issues).
