import base64
import json
import os
import sys
import time
import urllib.parse
import urllib.request

from marionette_driver.addons import Addons
from marionette_driver.marionette import Marionette

MARIONETTE_PORT = int(os.environ.get('MARIONETTE_PORT', '2839'))
BASE = os.environ.get('BASE_URL', 'http://127.0.0.1:8799').rstrip('/')
EXT_XPI = os.environ['EXT_XPI']

client = None
EXT_BASE = ''
passed = []
failed = []


def connect():
    global client
    last = None
    deadline = time.time() + 30
    while time.time() < deadline:
        try:
            client = Marionette('127.0.0.1', port=MARIONETTE_PORT)
            client.start_session()
            return
        except Exception as error:  # noqa: BLE001 - retry until Firefox is ready
            last = error
            time.sleep(0.25)
    raise AssertionError(f'could not connect to Marionette: {last!r}')


def check(name, condition, detail=''):
    if condition:
        passed.append(name)
        print('PASS', name)
    else:
        failed.append((name, detail))
        print('FAIL', name, detail)


def wait_for(fn, timeout=10, interval=0.1):
    deadline = time.time() + timeout
    last = None
    while time.time() < deadline:
        try:
            value = fn()
            if value:
                return value
        except Exception as error:  # noqa: BLE001 - polling helper
            last = error
        time.sleep(interval)
    raise AssertionError(f'timed out: {last!r}')


def server_reset(payload=None):
    data = json.dumps(payload or {}).encode('utf-8')
    request = urllib.request.Request(BASE + '/__reset', data=data, method='POST')
    urllib.request.urlopen(request, timeout=10).read()


def server_state():
    with urllib.request.urlopen(BASE + '/__state', timeout=10) as response:
        return json.load(response)


def bookmark_by_url(url):
    target = url.rstrip('/')
    for bookmark in server_state()['bookmarks']:
        if bookmark['url'].rstrip('/') == target:
            return bookmark
    return None


def bridge_call(name, *args):
    return client.execute_async_script("""
        const all = Array.prototype.slice.call(arguments);
        const done = all.pop();
        const method = all.shift();
        const bridge = window.wrappedJSObject && window.wrappedJSObject.__ncTest;
        if (!bridge || typeof bridge[method] !== 'function') {
            done('no-bridge');
            return;
        }
        Promise.resolve(bridge[method](...all))
            .then((value) => done(value === undefined ? 'ok' : JSON.stringify(value)))
            .catch((error) => done('error:' + error.message));
    """, script_args=[name, *args])


def reset_tabs():
    client.set_context('chrome')
    client.execute_script("""
        const blank = gBrowser.addTab('about:blank', {
          triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal()
        });
        gBrowser.selectedTab = blank;
        for (const tab of Array.from(gBrowser.tabs)) {
            if (tab !== blank) gBrowser.removeTab(tab);
        }
    """)
    client.set_context('content')
    time.sleep(0.2)


def add_tab(url):
    client.set_context('chrome')
    client.execute_script("""
        const tab = gBrowser.addTab(arguments[0], {
          triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal()
        });
        gBrowser.selectedTab = tab;
    """, script_args=[url])
    client.set_context('content')


def switch_to(path):
    deadline = time.time() + 10
    while time.time() < deadline:
        for handle in reversed(client.window_handles):
            client.switch_to_window(handle)
            try:
                if urllib.parse.urlparse(client.get_url()).path.endswith(path):
                    return
            except Exception:  # noqa: BLE001 - window may be mid-navigation
                pass
        time.sleep(0.1)
    raise AssertionError('no tab ' + path)


def seed(settings, target='popup.html', extra=None):
    reset_tabs()
    encoded = urllib.parse.quote(json.dumps(settings))
    quoted_target = urllib.parse.quote(target, safe='')
    extra_query = ''
    if extra:
        extra_query = '&extra=' + urllib.parse.quote(json.dumps(extra))
    add_tab(f'{EXT_BASE}/test-seed.html?settings={encoded}&target={quoted_target}{extra_query}')
    switch_to('/' + target.split('?')[0])
    time.sleep(0.4)


def element(element_id):
    return client.find_element('id', element_id)


def value(element_id):
    return element(element_id).get_property('value')


def text(element_id):
    return element(element_id).text


def click(element_id):
    element(element_id).click()


def type_into(element_id, new_value):
    field = element(element_id)
    field.clear()
    field.send_keys(new_value)


def async_load_for_tab(url, title):
    return client.execute_async_script("""
        const done = arguments[arguments.length - 1];
        const bridge = window.wrappedJSObject?.__ncTest;
        if (!bridge) { done('no-bridge'); return; }
        bridge.loadForTab(arguments[0], arguments[1])
          .then((result) => done(result))
          .catch((error) => done('error:' + error.message));
    """, script_args=[url, title])


def main():
    global EXT_BASE
    connect()
    addon_id = Addons(client).install(EXT_XPI, temp=True)
    time.sleep(1)

    client.set_context('chrome')
    uuid = client.execute_script("""
        const id = arguments[0];
        const raw = Services.prefs.getCharPref('extensions.webextensions.uuids');
        return JSON.parse(raw)[id] || null;
    """, script_args=[addon_id])
    client.set_context('content')
    if not uuid:
        raise AssertionError('could not resolve the extension UUID')
    EXT_BASE = f'moz-extension://{uuid}'

    settings = {
        'serverUrl': BASE,
        'username': 'test',
        'password': 'secret',
        'searchMainTab': False
    }

    server_reset()
    seed(settings, 'popup.html')
    try:
        wait_for(lambda: client.execute_script('return !!window.wrappedJSObject?.__ncTest'))
    except AssertionError:
        print('DEBUG url:', client.get_url())
        print('DEBUG title:', client.title)
        print('DEBUG body:', client.find_element('tag name', 'body').text[:600])
        print('DEBUG scripts:', client.execute_script('return [...document.scripts].map((s) => s.src)'))
        print('DEBUG window keys:', client.execute_script("return Object.keys(window).filter((k) => k.includes('nc')).join(',')"))
        print('DEBUG global keys:', client.execute_script("return Object.keys(globalThis).filter((k) => k.includes('nc')).join(',')"))
        print('DEBUG module has bridge:', client.execute_async_script("""
            const done = arguments[arguments.length - 1];
            fetch(document.scripts[0].src)
              .then((r) => r.text())
              .then((t) => done(t.includes('__ncTest')))
              .catch((e) => done(String(e)));
        """))
        raise
    async_load_for_tab('https://example.com/', 'Example Domain')
    wait_for(lambda: value('bookmark-id') == '1')
    check('popup finds an existing bookmark', value('bookmark-id') == '1')
    check('popup keeps the stored title', value('bookmark-title') == 'Example Domain')
    check('popup shows Update', text('save-bookmark') == 'Update')
    check('popup shows saved status', element('bookmark-status').is_displayed())

    async_load_for_tab('https://example.com/#section', 'Section')
    wait_for(lambda: value('bookmark-id') == '1')
    check('lookup matches a saved URL with a fragment', value('bookmark-title') == 'Example Domain')

    async_load_for_tab('https://example.com/?utm_source=newsletter', 'Tracking')
    wait_for(lambda: value('bookmark-id') == '1')
    check('lookup matches through tracking parameters', value('bookmark-title') == 'Example Domain')

    click('tab-search')
    type_into('search-terms', 'Example')
    click('search-button')
    wait_for(lambda: 'Example Domain' in text('search-results'))
    check('popup search works', 'Example Domain' in text('search-results'))

    # Quick save: open a page in another tab, ask the background to save it,
    # then exercise the injected toast and undo.
    test_page_url = BASE + '/test-page'
    add_tab(test_page_url)
    switch_to('/popup.html')
    result = client.execute_async_script("""
        const done = arguments[arguments.length - 1];
        window.wrappedJSObject.__ncTest.quickSaveTest(arguments[0])
          .then((value) => done(JSON.stringify(value)))
          .catch((error) => done('error:' + error.message));
    """, script_args=[test_page_url])
    check('quick save returns saved', '"status":"saved"' in result, result)
    if '"status":"saved"' not in result:
        client.set_context('chrome')
        print('DEBUG console:', client.execute_script("""
            return JSON.stringify(Services.console.getMessageArray().slice(-20).map((entry) => ({
              message: entry.message || '',
              error: entry.errorMessage || '',
              source: entry.sourceName || '',
              line: entry.lineNumber || 0
            })));
        """))
        client.set_context('content')
    quick = [b for b in server_state()['bookmarks'] if b['url'] == test_page_url]
    check('quick save created the bookmark', len(quick) == 1, quick)

    switch_to('/test-page')
    wait_for(lambda: client.execute_script("return !!document.getElementById('nextcloud-bookmarks-toast')"))
    check('quick save shows the toast', True)

    switch_to('/popup.html')
    undo = bridge_call('sendMessage', {
        'type': 'undo-quick-save',
        'id': quick[0]['id'],
        'account': f'{BASE}|test'
    })
    check('undo returns ok', '"ok":true' in undo, undo)
    wait_for(lambda: not [b for b in server_state()['bookmarks'] if b['url'].rstrip('/') == test_page_url.rstrip('/')])
    check('undo deletes the bookmark', True)

    switch_to('/popup.html')
    result = client.execute_async_script("""
        const done = arguments[arguments.length - 1];
        window.wrappedJSObject.__ncTest.quickSaveTest(arguments[0])
          .then((value) => done(JSON.stringify(value)))
          .catch((error) => done('error:' + error.message));
    """, script_args=[test_page_url])
    check('quick save works again after undo', '"status":"saved"' in result, result)
    switch_to('/test-page')
    wait_for(lambda: client.execute_script("return !!document.getElementById('nextcloud-bookmarks-toast')"))
    client.execute_script("document.getElementById('nextcloud-bookmarks-toast')?.remove(); return true;")

    switch_to('/popup.html')
    result = client.execute_async_script("""
        const done = arguments[arguments.length - 1];
        window.wrappedJSObject.__ncTest.quickSaveTest(arguments[0])
          .then((value) => done(JSON.stringify(value)))
          .catch((error) => done('error:' + error.message));
    """, script_args=[test_page_url])
    check('quick save does not duplicate', '"status":"exists"' in result, result)

    # Multi-folder save, including a shared folder.
    server_reset()
    seed(settings, 'popup.html')
    wait_for(lambda: client.execute_script('return !!window.wrappedJSObject?.__ncTest'))
    async_load_for_tab('https://multi.example/', 'Multi Example')
    wait_for(lambda: value('bookmark-url') == 'https://multi.example/')
    client.execute_script("document.getElementById('folder-picker').open = true;")
    client.execute_script("document.querySelector('#folder-options input[value=\"-1\"]').click();")
    client.execute_script("document.querySelector('#folder-options input[value=\"10\"]').click();")
    client.execute_script("document.querySelector('#folder-options input[value=\"13\"]').click();")
    type_into('bookmark-tags', 'alpha, beta')
    click('save-bookmark')
    wait_for(lambda: 'Bookmark saved' in text('notification'))
    multi = bookmark_by_url('https://multi.example/')
    check('multi-folder save stores both folders', multi and sorted(multi['folders']) == [10, 13], multi)

    # Advanced server search: paging, sorting, filters, and folder scoping.
    custom = []
    for index in range(1, 36):
        custom.append({
            'id': index,
            'url': f'https://site-{index:02d}.example/',
            'title': f'Site {index:02d}',
            'description': '',
            'tags': [] if index % 5 == 0 else ['bulk'],
            'folders': [10] if index % 2 == 0 else [-1],
            'lastmodified': 1700000000 + index,
            'clickcount': index,
            'available': True
        })
    server_reset({'bookmarks': custom})
    seed(settings, 'popup.html')
    wait_for(lambda: client.execute_script('return !!window.wrappedJSObject?.__ncTest'))
    bridge_call('clearIndex')
    click('tab-search')
    click('search-button')
    wait_for(lambda: client.execute_script("return document.querySelectorAll('#search-results .result').length") == 30)
    check('server search limits the first page', True)
    check('load more is visible', element('load-more').is_displayed())
    click('load-more')
    wait_for(lambda: client.execute_script("return document.querySelectorAll('#search-results .result').length") == 35)
    check('load more appends the next page', True)

    client.execute_script("document.getElementById('search-sort').value = 'title';")
    click('search-button')
    wait_for(lambda: client.execute_script("return document.querySelector('#search-results .result-title').textContent") == 'Site 01')
    check('server search sorts by title', True)

    client.execute_script("document.getElementById('search-filter').value = 'untagged';")
    click('search-button')
    wait_for(lambda: client.execute_script("return document.querySelectorAll('#search-results .result').length") == 7)
    check('untagged filter works', True)

    client.execute_script("""
        document.getElementById('search-filter').value = 'all';
        document.getElementById('search-folder').value = '10';
    """)
    click('search-button')
    wait_for(lambda: client.execute_script("return document.querySelectorAll('#search-results .result').length") == 17)
    check('folder filter works', True)

    # Edit a bookmark from the search results.
    server_reset()
    seed(settings, 'popup.html')
    wait_for(lambda: client.execute_script('return !!window.wrappedJSObject?.__ncTest'))
    bridge_call('clearIndex')
    click('tab-search')
    type_into('search-terms', 'Example')
    click('search-button')
    wait_for(lambda: 'Example Domain' in text('search-results'))
    client.find_element('css selector', '#bookmark-1 .result-edit').click()
    wait_for(lambda: value('bookmark-id') == '1')
    check('search edit loads the bookmark', value('bookmark-title') == 'Example Domain')
    type_into('bookmark-title', 'Example updated')
    click('save-bookmark')
    wait_for(lambda: 'Bookmark updated' in text('notification'))
    check('search edit updates the server', bookmark_by_url('https://example.com/')['title'] == 'Example updated')

    # Quick save rejects restricted pages instead of throwing.
    result = bridge_call('sendMessage', {
        'type': 'test-quick-save',
        'tab': {'url': 'about:config', 'title': 'Restricted'}
    })
    check('quick save rejects restricted URLs', '"status":"unsupported"' in result, result)

    # Options: create and rename folders.
    server_reset()
    seed(settings, 'options.html')
    wait_for(lambda: 'Work' in text('folder-list'))
    type_into('new-folder-options-title', 'Integration Folder')
    client.execute_script("document.getElementById('new-folder-options-parent').value = '10';")
    click('create-folder-options')
    wait_for(lambda: any(folder['title'] == 'Integration Folder' for folder in server_state()['folders']))
    created_folder = next(folder for folder in server_state()['folders'] if folder['title'] == 'Integration Folder')
    check('options creates a folder', created_folder['parent_folder'] == 10, created_folder)

    client.execute_script("""
        const row = [...document.querySelectorAll('#folder-list .folder-row')]
          .find((entry) => entry.textContent.includes('Work'));
        row.querySelector('button').click();
    """)
    wait_for(lambda: element('rename-folder-10').is_displayed())
    type_into('rename-folder-10', 'Renamed Work')
    client.execute_script("""
        const row = [...document.querySelectorAll('#folder-list .folder-row')]
          .find((entry) => entry.querySelector('input'));
        [...row.querySelectorAll('button')].find((button) => button.textContent === 'Save').click();
    """)
    wait_for(lambda: any(folder['id'] == 10 and folder['title'] == 'Renamed Work' for folder in server_state()['folders']))
    check('options renames a folder', True)

    # Import a real Firefox bookmark tree into Nextcloud.
    reset_tabs()
    add_tab(f'{EXT_BASE}/test-bookmarks.html')
    switch_to('/test-bookmarks.html')
    click('seed')
    wait_for(lambda: text('status').startswith('seeded:'))
    firefox_folder = text('status').split(':', 1)[1]
    check('firefox bookmarks seeded', bool(firefox_folder), firefox_folder)

    seed(settings, 'options.html')
    wait_for(lambda: client.execute_script('return !!window.wrappedJSObject?.__ncTest'))
    wait_for(lambda: bridge_call('setSelect', 'firefox-folder', firefox_folder) == 'true')
    wait_for(lambda: bridge_call('setSelect', 'import-folder', '10') == 'true')
    click('preview-import')
    try:
        wait_for(lambda: '2 new' in text('import-status'))
    except AssertionError:
        print('DEBUG import-status:', text('import-status'))
        print('DEBUG firefox-folder:', value('firefox-folder'))
        print('DEBUG import-folder:', value('import-folder'))
        print('DEBUG requests:', server_state()['requests'][-6:])
        raise
    check('import preview sees the new bookmarks', '1 new folders' in text('import-status'), text('import-status'))
    click('start-import')
    wait_for(lambda: 'Imported 2' in text('import-status'), timeout=10)
    check('import completes with folder recreation', True)

    state = server_state()
    nested = next((folder for folder in state['folders'] if folder['title'] == 'Nested' and folder['parent_folder'] == 10), None)
    one = bookmark_by_url('https://firefox-one.example/')
    two = bookmark_by_url('https://firefox-two.example/')
    check('import creates the nested folder', nested is not None, nested)
    check('import puts the direct bookmark in the destination', one and one['folders'] == [10], one)
    check('import puts the nested bookmark in the new folder', two and nested and two['folders'] == [nested['id']], two)
    check('import does not duplicate an existing URL', len([b for b in state['bookmarks'] if b['url'].rstrip('/') == 'https://example.com']) == 1)

    # 401 keeps the popup alive and explains the problem.
    seed({**settings, 'password': 'wrong'}, 'popup.html')
    wait_for(lambda: client.execute_script('return !!window.wrappedJSObject?.__ncTest'))
    bridge_call('setForm', 'https://unauthorized.example/', 'Unauthorized')
    wait_for(lambda: value('bookmark-url') == 'https://unauthorized.example/')
    click('save-bookmark')
    wait_for(lambda: 'Authentication failed' in text('notification'))
    check('401 shows a useful error', True)
    check('popup stays alive after 401', element('save-bookmark').is_displayed())

    seed(settings, 'options.html')
    wait_for(lambda: value('server-url') == BASE)
    wait_for(lambda: value('server-url') == BASE)
    check('options loads the server URL', value('server-url') == BASE)
    check('options loads the username', value('username') == 'test')
    check('options version is visible', text('extension-version').startswith('v'))

    print(f'\nSUMMARY {len(passed)} passed, {len(failed)} failed')
    if failed:
        for name, detail in failed:
            print('FAILED:', name, detail)
        return 1
    return 0


try:
    raise SystemExit(main())
finally:
    if client is not None:
        try:
            client.delete_session()
        except Exception:  # noqa: BLE001 - best effort cleanup
            pass
