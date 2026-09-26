"""Admin changes usernames: another employee (data re-keyed, references re-pointed) and their own account (signed out, prefilled)."""
import sys, json, os, time; sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from harness import App, seed_payload, BASE, ts

SVC = 'https://script.google.com/macros/s/TEST/exec'
now = int(time.time() * 1000)
p = seed_payload({'settings/public': {'loginDomain': 'almaster.tech', 'authServiceUrl': SVC}, 'settings/migration': {'done': True}})
fs = p['fs']
fs['attendance_days/emp1@almaster.tech_2026-09-20'] = {'email': 'emp1@almaster.tech', 'date': '2026-09-20', 'leaderEmail': 'leader@almaster.tech', 'checkInMs': now - 86400000 * 6, 'workMs': 28800000, 'closed': True}
fs['schedules/emp1@almaster.tech_2026-09'] = {'email': 'emp1@almaster.tech', 'month': '2026-09', 'leaderEmail': 'leader@almaster.tech', 'days': {'2026-09-29': {'mode': 'leave', 'leaderType': 'annual'}}}
fs['balances/emp1@almaster.tech_2026'] = {'email': 'emp1@almaster.tech', 'year': 2026, 'types': {'annual': {'entitled': 21, 'used': 3, 'adjust': 0}}}
fs['requests/rq1'] = {'email': 'emp1@almaster.tech', 'name': 'سارة', 'leaderEmail': 'leader@almaster.tech', 'type': 'leave', 'status': 'approved', 'createdMs': now}
fs['payroll_items/2026-08_emp1@almaster.tech'] = {'email': 'emp1@almaster.tech', 'month': '2026-08', 'net': 11000, 'published': True}
fs['logs/l1'] = {'user': 'emp1@almaster.tech', 'leaderEmail': 'leader@almaster.tech', 'dayKey': '2026-09-20', 'timestamp': ts(now)}
fs['requests/rq2'] = {'email': 'emp2@almaster.tech', 'leaderEmail': 'leader@almaster.tech', 'type': 'remote', 'status': 'pending_leader', 'createdMs': now}

a = App(); pg = a.page
calls = []
def svc(route):
    body = json.loads(route.request.post_data or '{}'); calls.append(body)
    route.fulfill(status=200, body=json.dumps({'ok': True}), headers={'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*'})
a.ctx.route('https://script.google.com/**', svc)
ok = lambda c, m: print(('OK ' if c else 'FAIL ') + m)
a.seed(p)

# 1) rename the leader (so references in other people's records move too)
a.login('admin@almaster.tech'); a.go('#/employees'); pg.wait_for_timeout(500)
pg.locator('[data-action=edit][data-email="leader@almaster.tech"]').click(); pg.wait_for_timeout(700)
pg.click('.modal #et [data-p=access]'); pg.fill('.modal #rn-to', 'karim.hassan@outlook.com'); pg.click('.modal #rn'); pg.wait_for_timeout(300)
pg.locator('.modal-root .modal').last.locator('[data-yes]').click(); pg.wait_for_timeout(2000)
db = a.db()
acts = [c['action'] for c in calls]
ok(acts[-2:] == ['renameCheck', 'rename'] and calls[-1]['from'] == 'leader@almaster.tech' and calls[-1]['to'] == 'karim.hassan@outlook.com', f'service called check → rename {acts}')
nu = db.get('users/karim.hassan@outlook.com') or {}
ok(nu.get('role') == 'leader' and nu.get('renamedFrom') == 'leader@almaster.tech', 'new profile created with role')
ok(db['users/emp1@almaster.tech']['leaderEmail'] == 'karim.hassan@outlook.com' and db['users/emp2@almaster.tech']['leaderEmail'] == 'karim.hassan@outlook.com', 'team re-pointed to new username')
ok(db['requests/rq2']['leaderEmail'] == 'karim.hassan@outlook.com', 'pending approvals follow the leader')
ok(db['attendance_days/emp1@almaster.tech_2026-09-20']['leaderEmail'] == 'karim.hassan@outlook.com' and db['schedules/emp1@almaster.tech_2026-09']['leaderEmail'] == 'karim.hassan@outlook.com', 'team attendance & schedules re-pointed')
ok(db['logs/l1']['leaderEmail'] == 'karim.hassan@outlook.com', 'logs re-pointed')
ok(db.get('employees_private/leader@almaster.tech') is None and (db.get('employees_private/karim.hassan@outlook.com') or {}).get('email') == 'karim.hassan@outlook.com', 'private data moved')
ok(any(v.get('action') == 'user.rename' for k, v in db.items() if k.startswith('audit_log/')), 'rename audited')
# simulate the service removing the old profile
pg.evaluate("""() => { const fs = JSON.parse(localStorage.getItem('mockfs')); delete fs['users/leader@almaster.tech']; localStorage.setItem('mockfs', JSON.stringify(fs)); }""")

# 2) rename an employee with history
pg.reload(); pg.wait_for_selector('#splash', state='detached', timeout=8000); a.go('#/employees'); pg.wait_for_timeout(500)
pg.locator('[data-action=edit][data-email="emp1@almaster.tech"]').click(); pg.wait_for_timeout(700)
pg.click('.modal #et [data-p=access]'); pg.fill('.modal #rn-to', 'sara.mahmoud@outlook.com'); pg.click('.modal #rn'); pg.wait_for_timeout(300)
pg.locator('.modal-root .modal').last.locator('[data-yes]').click(); pg.wait_for_timeout(2000)
db = a.db(); T = 'sara.mahmoud@outlook.com'
ok(db.get(f'attendance_days/{T}_2026-09-20', {}).get('workMs') == 28800000 and 'attendance_days/emp1@almaster.tech_2026-09-20' not in db, 'attendance re-keyed')
ok(db.get(f'schedules/{T}_2026-09', {}).get('email') == T and db.get(f'balances/{T}_2026', {}).get('types', {}).get('annual', {}).get('used') == 3, 'schedule & balance re-keyed')
ok(db['requests/rq1']['email'] == T and db.get(f'payroll_items/2026-08_{T}', {}).get('net') == 11000, 'requests & payslips moved')
ok(db['logs/l1']['user'] == T, 'activity log moved')

# 3) admin renames their own account → signed out with the new name prefilled
pg.locator('[data-action=edit][data-email="admin@almaster.tech"]').click(); pg.wait_for_timeout(700)
pg.click('.modal #et [data-p=access]'); pg.fill('.modal #rn-to', 'almaster.hr@outlook.com'); pg.click('.modal #rn'); pg.wait_for_timeout(300)
pg.locator('.modal-root .modal').last.locator('[data-yes]').click(); pg.wait_for_timeout(2500)
ok('index.html' in pg.url, 'self-rename signs out')
ok(pg.input_value('#email') == 'almaster.hr@outlook.com', 'new username prefilled')
ok('الجديد' in pg.locator('#reason').inner_text(), 'explains the new username')
ok((a.db('users/almaster.hr@outlook.com') or {}).get('role') == 'admin', 'admin role kept on new account')
a.dump_errors('flow5')
a.close()
