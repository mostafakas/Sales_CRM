import sys, time; sys.path.insert(0, '/home/claude/almaster-hr/tests')
from harness import App, seed_payload, ts
import datetime
now = int(time.time()*1000)
def cairo(date, hm):
    y,m,d = map(int, date.split('-')); h,mi = map(int, hm.split(':'))
    return int(datetime.datetime(y,m,d,h,mi, tzinfo=datetime.timezone(datetime.timedelta(hours=3))).timestamp()*1000)
extra = {'settings/general': {'weekend': [5], 'trackingStart': '2026-09-01', 'workStart': '09:00', 'workEnd': '17:00', 'graceMinutes': 15}}
p = seed_payload(extra)
# emp2 forgot to end yesterday: status Online since yesterday 10:00
p['fs']['users/emp2@almaster.tech'].update({'status': 'Online', 'dayKey': '2026-09-25', 'lastChange': ts(cairo('2026-09-25','10:00')), 'timeBank': {'Online': 3600000, 'Break': 0, 'Meeting': 0}, 'checkedOut': False, 'firstOnlineAt': ts(cairo('2026-09-25','09:00'))})
p['fs']['attendance_days/emp2@almaster.tech_2026-09-25'] = {'email': 'emp2@almaster.tech', 'date': '2026-09-25', 'leaderEmail': 'leader@almaster.tech', 'checkInMs': cairo('2026-09-25','09:00'), 'mode': 'office', 'closed': False, 'workMs': 3600000}
a = App(); a.seed(p); pg = a.page
def step(n):
    e = a.dump_errors(n); print('OK' if not e else 'ERR', n)

# emp1: two requests, cancel one
a.login('emp1@almaster.tech')
for sd in ['2026-10-05', '2026-10-12']:
    pg.click('[data-rq="leave"]'); pg.wait_for_timeout(300); pg.fill('[name=startDate]', sd); pg.fill('[name=endDate]', sd); pg.click('#rq-send'); pg.wait_for_timeout(900)
# over-balance request should show an error inside the form
pg.click('[data-rq="leave"]'); pg.wait_for_timeout(300); pg.fill('[name=startDate]', '2026-11-01'); pg.fill('[name=endDate]', '2026-12-31'); pg.click('#rq-send'); pg.wait_for_timeout(900)
print('  over-balance error:', pg.locator('#rq-err').inner_text()[:80]); a.shot('90-overbalance'); pg.keyboard.press('Escape')
a.go('#/requests'); pg.wait_for_timeout(600)
pg.locator('[data-action=cancel]').first.click(); pg.wait_for_timeout(300); pg.click('.modal [data-yes]'); pg.wait_for_timeout(900); step('cancel request')
st = sorted(v['status'] for k, v in a.db().items() if k.startswith('requests/')); print('  statuses:', st)

# leader rejects remaining
a.login('leader@almaster.tech'); a.go('#/approvals'); pg.wait_for_timeout(800)
pg.locator('[data-action=reject]').first.click(); pg.wait_for_timeout(300); pg.fill('.modal [data-inp]', 'ضغط شغل الأسبوع ده'); pg.click('.modal [data-yes]'); pg.wait_for_timeout(900); step('reject')
st = sorted(v['status'] for k, v in a.db().items() if k.startswith('requests/')); print('  statuses:', st)

# emp2 opens app next day: stale day auto-closed on start
a.login('emp2@almaster.tech'); pg.wait_for_timeout(600); a.shot('91-stale'); 
print('  stale notice visible:', pg.locator('#pad-card .alert.warn').count())
pg.click('#start-btn'); pg.click('[data-mode="office"]'); pg.wait_for_timeout(1500); step('start after stale')
d = a.db('attendance_days/emp2@almaster.tech_2026-09-25'); print('  closed stale:', d.get('closed'), d.get('autoClosed'), round(d.get('workMs',0)/3600000,2), 'h')

# HR: edit employee, suspend, correction, adjust balance, revoke
a.login('hr@almaster.tech')
a.go('#/employees'); pg.wait_for_timeout(700)
pg.locator('[data-action=edit][data-email="emp2@almaster.tech"]').click(); pg.wait_for_timeout(500)
pg.click('#et .tab[data-p=job]'); pg.fill('[name=title]', 'Senior Backend Developer'); pg.click('#save'); pg.wait_for_timeout(1000); step('edit employee')
print('  title:', a.db('users/emp2@almaster.tech')['title'])
pg.locator('[data-action=edit][data-email="new@almaster.tech"]').count()
a.go('#/employees/emp1%40almaster.tech'); pg.wait_for_timeout(900)
pg.click('#ft .tab[data-p=bal]'); pg.wait_for_timeout(700); pg.click('#adj'); pg.wait_for_timeout(300)
pg.fill('#af [name=d]', '2'); pg.fill('#af [name=n]', 'مكافأة أيام'); pg.click('#as'); pg.wait_for_timeout(900); step('adjust balance')
print('  annual:', a.db('balances/emp1@almaster.tech_2026')['types']['annual'])
a.go('#/daily'); pg.wait_for_timeout(900)
pg.locator('[data-action=fix][data-email="emp1@almaster.tech"]').click(); pg.wait_for_timeout(300)
pg.fill('#cf [name=in]', '09:10'); pg.fill('#cf [name=out]', '17:05'); pg.fill('#cf [name=note]', 'نسي يسجل'); pg.click('#cs'); pg.wait_for_timeout(900); step('daily correction')
print('  corrected:', {k: v for k, v in a.db('attendance_days/emp1@almaster.tech_2026-09-26').items() if k in ('corrected','correctionNote','workMs')})
# suspend emp1
a.go('#/employees'); pg.wait_for_timeout(600)
pg.locator('[data-action=edit][data-email="emp1@almaster.tech"]').click(); pg.wait_for_timeout(400)
pg.click('#et .tab[data-p=access]'); pg.click('label.switch:has([name=isSuspended]) span'); pg.click('#save'); pg.wait_for_timeout(900); step('suspend')
# create a user to test first-login password change
pg.click('#add'); pg.wait_for_timeout(300); pg.fill('[name=name]', 'Test User'); pg.fill('[name=email]', 'first@almaster.tech'); pg.click('#save'); pg.wait_for_timeout(1300)
pw = pg.locator('.modal dd.num').nth(1).inner_text().strip(); print('  temp pw captured:', bool(pw))
pg.keyboard.press('Escape')

# suspended user can't log in
pg.goto('http://localhost:8765/index.html'); pg.evaluate("() => localStorage.removeItem('mockauth_current')"); pg.goto('http://localhost:8765/index.html')
pg.fill('#email', 'emp1@almaster.tech'); pg.fill('#password', 'Passw0rd!'); pg.click('#login-btn'); pg.wait_for_timeout(1200)
print('  suspended msg:', pg.locator('#login-error').inner_text()[:70]); a.shot('92-suspended'); step('suspended login')

# first login forces password change
a.login('first@almaster.tech', pw); pg.wait_for_timeout(700); a.shot('93-force-pw')
print('  force modal:', pg.locator('#pw-form').count())
pg.fill('[name=p1]', 'NewPassw0rd'); pg.fill('[name=p2]', 'NewPassw0rd'); pg.click('#pw-form button[type=submit]'); pg.wait_for_timeout(900); step('force pw change')
print('  mustChangePassword:', a.db('users/first@almaster.tech')['mustChangePassword'])

# single session: simulate another device login
a.login('emp2@almaster.tech'); pg.wait_for_timeout(500)
pg.evaluate("() => { const fs = JSON.parse(localStorage.getItem('mockfs')); fs['users/emp2@almaster.tech'].sessionId = 'other-device'; localStorage.setItem('mockfs', JSON.stringify(fs)); window.dispatchEvent(new StorageEvent('storage', {key: 'mockfs', newValue: JSON.stringify(fs)})); }")
pg.wait_for_timeout(1500); print('  after other device -> url:', pg.url.split('/')[-1], '| reason:', pg.locator('#reason').inner_text()[:60] if pg.locator('#reason').count() else '')
step('single session')
a.close()
