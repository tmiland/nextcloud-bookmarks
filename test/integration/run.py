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

    click('tab-search')
    type_into('search-terms', 'Example')
    click('search-button')
    wait_for(lambda: 'Example Domain' in text('search-results'))
    check('popup search works', 'Example Domain' in text('search-results'))

    seed(settings, 'options.html')
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
