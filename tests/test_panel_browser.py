"""Optional real-browser smoke test. Fixtures are synthetic, not live traffic."""
from pathlib import Path
import os, time
from playwright.sync_api import sync_playwright, expect
from test_admin import AdminIntegration

AdminIntegration.setUpClass()
try:
    test=AdminIntegration('test_01_auth_and_public_shell')
    test.create('player_demo',connections=2,quota_bytes=10*1073741824)
    (test.root/'status.txt').write_text(f'KANKI_STATUS_V1 {int(time.time())} 123\naccount player_demo 536870912 268435456 10737418240\nsession player_demo-d1 player_demo 1 10.66.0.2 {int(time.time())}\n')
    with sync_playwright() as p:
        browser=p.chromium.launch(executable_path=os.environ.get('CHROMIUM','/usr/bin/chromium'),args=['--no-sandbox'])
        page=browser.new_page(viewport={'width':1440,'height':1000},device_scale_factor=1)
        errors=[];page.on('pageerror',lambda e:errors.append(str(e)))
        page.goto(f'http://127.0.0.1:{test.http.server_port}')
        page.locator('#admin-token').fill(test.token);page.locator('#login-form button').click()
        page.locator('#dashboard').wait_for(state='visible');expect(page.locator('#active-users')).to_have_text('1')
        assert page.locator('#online-users').inner_text()=='1'
        out=Path(__file__).resolve().parents[1]/'artifacts';out.mkdir(exist_ok=True)
        page.screenshot(path=str(out/'panel-desktop-demo.png'),full_page=True)
        page.locator('[data-tab=users]').click();page.locator('#user-form [name=name]').fill('browser_player')
        page.locator('#user-form button').click();page.locator('#user-rows').get_by_text('browser_player',exact=True).wait_for()
        page.locator('#search').fill('browser_player');assert page.locator('#user-rows tr').count()==1
        page.locator('#user-rows').get_by_role('button',name='ویرایش',exact=True).click()
        page.locator('#edit-dialog').wait_for(state='visible');page.locator('#edit-connections').fill('3');page.locator('#edit-form button').first.click()
        expect(page.locator('#user-rows')).to_contain_text('0 / 3')
        page.set_viewport_size({'width':390,'height':844});page.screenshot(path=str(out/'panel-mobile-demo.png'),full_page=True)
        assert page.evaluate('document.documentElement.scrollWidth <= innerWidth'),'Page overflows on mobile'
        page.locator('#logout').click();page.locator('#login').wait_for(state='visible');assert not page.locator('#user-rows').inner_text()
        assert not errors,errors
        browser.close();print('PASS: browser login, real API create/edit, search, desktop/mobile layout, logout, no JS errors')
finally:AdminIntegration.tearDownClass()
