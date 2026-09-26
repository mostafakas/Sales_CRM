"""Username sign-in, password service (reset / forgot / welcome), recovery email, per-employee balance & remote quota, monitor views."""
import sys, json, os; sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from harness import App, seed_payload, BASE

SVC = 'https://script.google.com/macros/s/TEST/exec'
extra = {'settings/public': {'loginDomain': 'almaster.tech', 'authServiceUrl': SVC}, 'settings/migration': {'done': True}}
p = seed_payload(extra)
p['fs']['employees_private/emp1@almaster.tech']['contactEmail'] = 'sara@outlook.com'
p['fs']['balances/emp1@almaster.tech_2026'] = {'email': 'emp1@almaster.tech', 'year': 2026, 'types': {'annual': {'entitled': 21, 'used': 5, 'adjust': 0}}}

a = App(); pg = a.page
calls = []
def svc(route):
    body = json.loads(route.request.post_data or '{}'); calls.append(body)
    act = body.get('action')
    res = {'ping': {'ok': True, 'configured': True, 'firebase': True, 'mailQuota': 97},
           'reset': {'ok': True, 'password': 'Abcd-Efgh#42', 'emailed': 'sa•••@outlook.com'},
           'forgot': {'ok': True}, 'welcome': {'ok': True, 'emailed': 'ne•••@outlook.com'}}.get(act, {'ok': False, 'error': 'unknown-action'})
    route.fulfill(status=200, body=json.dumps(res), headers={'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*'})
a.ctx.route('https://script.google.com/**', svc)
ok = lambda c, m: print(('OK ' if c else 'FAIL ') + m)

a.seed(p)
# 1) sign in with the bare username
pg.goto(BASE + '/index.html'); pg.wait_for_timeout(500)
pg.fill('#email', 'Emp1'); pg.fill('#password', 'Passw0rd!'); pg.click('#login-btn')
pg.wait_for_url('**/app.html**', timeout=8000); pg.wait_for_selector('#splash', state='detached', timeout=8000)
ok('app.html' in pg.url, 'username-only sign-in')

# 2) recovery email from profile
a.go('#/profile'); pg.wait_for_timeout(600)
ok(pg.input_value('#rec-form input') == 'sara@outlook.com', 'profile shows recovery email')
pg.fill('#rec-form input', 'sara.m@outlook.com'); pg.click('#rec-form button'); pg.wait_for_timeout(600)
ok(a.db('employees_private/emp1@almaster.tech').get('contactEmail') == 'sara.m@outlook.com', 'employee saved own recovery email')

# 3) forgot password from sign-in page
pg.evaluate("() => localStorage.removeItem('mockauth_current')")
pg.goto(BASE + '/index.html'); pg.wait_for_timeout(500)
pg.click('#forgot-link'); pg.fill('#reset-email', 'emp2'); pg.click('#reset-btn'); pg.wait_for_timeout(700)
f = [c for c in calls if c.get('action') == 'forgot']
ok(f and f[-1].get('username') == 'emp2@almaster.tech' and 'idToken' not in f[-1], 'forgot → service with full username, no token')
ok(pg.locator('#reset-msg').is_visible(), 'neutral reset message shown')

# 4) HR: reset password, balance & remote quota
a.login('hr@almaster.tech'); a.go('#/employees'); pg.wait_for_timeout(500)
pg.locator('[data-action=edit][data-email="emp1@almaster.tech"]').click(); pg.wait_for_timeout(700)
ok(pg.locator('.modal input[name=contactEmail]').input_value() == 'sara.m@outlook.com', 'editor shows recovery email')
pg.click('.modal #et [data-p=leave]'); pg.wait_for_timeout(200)
rem = pg.locator('.modal tr[data-lt=annual] [data-rem]')
ok(rem.input_value() == '16', f'remaining shown = 16 ({rem.input_value()})')
pg.fill('.modal input[name=remoteQuota]', '6')
rem.fill('18')
pg.click('.modal #save'); pg.wait_for_timeout(500)
ok(pg.locator('.modal #ee').is_visible(), 'balance change requires a reason')
pg.fill('.modal input[name=balNote]', 'رصيد افتتاحي'); pg.click('.modal #save'); pg.wait_for_timeout(1200)
b = a.db('balances/emp1@almaster.tech_2026')['types']['annual']
ok(b['entitled'] + b['adjust'] - b['used'] == 18, f'annual remaining now 18 ({b})')
ok(a.db('users/emp1@almaster.tech').get('remoteQuota') == 6, 'remote quota saved = 6')
led = [v for k, v in a.db().items() if k.startswith('balance_ledger/')]
ok(any(l.get('reason') == 'رصيد افتتاحي' and l.get('delta') == 2 for l in led), 'ledger entry with reason')

pg.locator('[data-action=edit][data-email="emp1@almaster.tech"]').click(); pg.wait_for_timeout(700)
pg.click('.modal #et [data-p=access]'); pg.click('.modal #rp'); pg.wait_for_timeout(300)
pg.locator('.modal-root .modal').last.locator('.btn-primary, .btn-danger').last.click(); pg.wait_for_timeout(900)
r = [c for c in calls if c.get('action') == 'reset']
ok(r and r[-1]['target'] == 'emp1@almaster.tech' and r[-1].get('notify') is True and r[-1].get('idToken'), 'reset → service with token + notify')
ok(pg.locator('text=Abcd-Efgh#42').count() > 0, 'temporary password shown to HR')
ok(any(v.get('action') == 'user.password_reset' for k, v in a.db().items() if k.startswith('audit_log/')), 'reset audited')
pg.keyboard.press('Escape'); pg.keyboard.press('Escape'); pg.wait_for_timeout(300)
a.shot('f4-editor')

# 5) own profile editor is locked for HR (balance/recovery)
pg.locator('[data-action=edit][data-email="hr@almaster.tech"]').click(); pg.wait_for_timeout(700)
ok(pg.locator('.modal #rp').count() == 0, 'no reset button on own account')
ok(pg.locator('.modal input[name=contactEmail]').is_disabled(), 'own recovery email locked in editor')
pg.keyboard.press('Escape')

# 6) new employee with bare username + welcome email
pg.click('#add'); pg.wait_for_timeout(600)
pg.fill('.modal input[name=name]', 'نادر سالم'); pg.fill('.modal input[name=email]', 'nader')
ok('nader@almaster.tech' in pg.locator('#uhint').inner_text(), 'username hint shows full sign-in name')
pg.fill('.modal input[name=contactEmail]', 'nader@outlook.com')
pg.click('.modal #save'); pg.wait_for_timeout(1500)
ok(a.db('users/nader@almaster.tech') is not None and a.db('users/nader@almaster.tech').get('mustChangePassword') is True, 'new user created as nader@almaster.tech')
ok(a.db('employees_private/nader@almaster.tech').get('contactEmail') == 'nader@outlook.com', 'recovery email stored privately')
pg.click('#mailc'); pg.wait_for_timeout(800)
w = [c for c in calls if c.get('action') == 'welcome']
ok(w and w[-1]['target'] == 'nader@almaster.tech' and len(w[-1]['password']) >= 8, 'welcome email requested')
pg.keyboard.press('Escape')

# 7) settings: test connection
a.login('admin@almaster.tech'); a.go('#/settings'); pg.wait_for_timeout(500)
pg.click('#st [data-p=system]'); pg.wait_for_timeout(900)
pg.click('#svc-test'); pg.wait_for_timeout(800)
ok('97' in pg.locator('#svc-out').inner_text(), 'service test shows mail quota')
a.shot('f4-settings', True)

# 8) forced logout after reset + reason on sign-in page
a.login('emp2@almaster.tech'); pg.wait_for_timeout(500)
pg.evaluate("""() => { const fs = JSON.parse(localStorage.getItem('mockfs')); fs['users/emp2@almaster.tech'].sessionId = 'reset_1'; localStorage.setItem('mockfs', JSON.stringify(fs)); window.dispatchEvent(new StorageEvent('storage', { key: 'mockfs' })); }""")
pg.wait_for_timeout(800)
if 'index.html' not in pg.url:
    pg.reload()
pg.wait_for_url('**/index.html**', timeout=8000); pg.wait_for_timeout(600)
print('REASON:', pg.url, pg.locator('#reason').inner_text()); ok('index.html' in pg.url and 'مؤقتة' in pg.locator('#reason').inner_text(), 'reset signs the user out with a clear reason')

errs = a.dump_errors('flow4')
a.close()
