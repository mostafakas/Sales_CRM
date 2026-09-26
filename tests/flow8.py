"""A project without published composite indexes: every screen must still load."""
import sys, os, time; sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from harness import App, seed_payload
p = seed_payload({'settings/migration': {'done': True}})
now = int(time.time() * 1000)
d = time.strftime('%Y-%m-%d', time.localtime(now / 1000 - 86400 * 2))
p['fs'][f'attendance_days/emp1@almaster.tech_{d}'] = {'email': 'emp1@almaster.tech', 'date': d, 'leaderEmail': 'leader@almaster.tech', 'checkInMs': now - 86400000 * 2, 'workMs': 28000000, 'closed': True, 'mode': 'office'}
a = App(); pg = a.page
ok = lambda c, m: print(('OK ' if c else 'FAIL ') + m)
a.seed(p)
pg.evaluate("() => localStorage.setItem('mock_strict_index', '1')")
bad = lambda: 'تعذّر' in pg.locator('#view').inner_text() or 'requires an index' in pg.locator('#view').inner_text()
for who, routes in [('emp1@almaster.tech', ['#/attendance', '#/home', '#/requests']),
                    ('leader@almaster.tech', ['#/attendance', '#/monitor', '#/approvals', '#/leaves', '#/reports', '#/schedules']),
                    ('hr@almaster.tech', ['#/reports', '#/daily', '#/employees/emp1@almaster.tech']),
                    ('admin@almaster.tech', ['#/activity'])]:
    a.login(who)
    for r in routes:
        a.go(r); pg.wait_for_timeout(1300)
        ok(not bad(), f'{who.split("@")[0]} {r} loads without indexes')
a.login('emp1@almaster.tech'); a.go('#/attendance'); pg.wait_for_timeout(1300)
ok('أيام حضور' in pg.locator('#view').inner_text() and 'تعذّر' not in pg.locator('#view').inner_text(), 'attendance calendar rendered')
a.shot('f8-attendance')
warns = [e for e in a.errors if 'index missing' in e]
ok(len(warns) > 0, f'fallback used ({len(warns)} times)')
a.close()
