"""Browser smoke with real cluster API; display data are test fixtures."""
import os,time
from pathlib import Path
from playwright.sync_api import sync_playwright,expect
from test_admin import AdminIntegration
os.environ['KANKI_CLUSTER']='1';AdminIntegration.setUpClass()
try:
    api=AdminIntegration('test_01_auth_and_public_shell');api.create('cluster_player',connections=2,quota_bytes=8192)
    with sync_playwright() as p:
        browser=p.chromium.launch(executable_path=os.environ.get('CHROMIUM','/usr/bin/chromium'),args=['--no-sandbox'])
        page=browser.new_page(viewport={'width':1440,'height':1000});errors=[];page.on('pageerror',lambda e:errors.append(str(e)))
        page.goto(f'http://127.0.0.1:{api.http.server_port}');page.locator('#admin-token').fill(api.token);page.locator('#login-form button').click()
        expect(page.locator('#core-state')).to_have_text('0 / 0 نود آنلاین')
        page.locator('[data-tab=servers]').click();page.locator('#server-form [name=name]').fill('Browser Node');page.locator('#server-form [name=host]').fill('node.example.test');page.locator('#server-form button').click()
        page.locator('#node-credential').wait_for(state='visible');credential=page.locator('#node-token').input_value();assert len(credential)>32
        page.locator('#close-credential').click();assert not page.locator('#node-token').input_value()
        expect(page.locator('#server-cards')).to_contain_text('Browser Node')
        page.locator('[data-tab=users]').click();page.get_by_role('button',name='دستگاه‌ها',exact=True).click();page.locator('#device-dialog').wait_for(state='visible')
        nid=api.request('GET','/api/nodes')[1][0]['id'];page.locator('#device-rows select').first.select_option(nid)
        page.locator('#device-rows button').first.click();expect(page.locator('#device-rows')).to_contain_text('زمان مجاز انتقال:')
        page.locator('#close-devices').click();page.locator('[data-tab=servers]').click()
        page.screenshot(path=str(Path(__file__).resolve().parents[1]/'artifacts/panel-cluster-demo.png'),full_page=True)
        page.set_viewport_size({'width':390,'height':844});assert page.evaluate('document.documentElement.scrollWidth <= innerWidth')
        page.locator('#logout').click();assert not page.locator('#node-token').input_value();assert not errors,errors
        browser.close();print('PASS: cluster node creation, one-time token clearing, slot assignment, responsive layout, no JS errors')
finally:AdminIntegration.tearDownClass();os.environ.pop('KANKI_CLUSTER',None)
