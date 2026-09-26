import sys, time, json; sys.path.insert(0, '/home/claude/almaster-hr/tests')
from harness import App, seed_payload, ts
now = int(time.time()*1000)
DAY = 86400000
extra = {}
# historical attendance for emp1/emp2 earlier this month (Cairo 09:xx)
import datetime
def cairo(date, hm):
    y,m,d = map(int, date.split('-')); h,mi = map(int, hm.split(':'))
    return int(datetime.datetime(y,m,d,h,mi, tzinfo=datetime.timezone(datetime.timedelta(hours=3))).timestamp()*1000)
for d, cin, cout, who, mode in [('2026-09-20','09:05','17:10','emp1','office'),('2026-09-21','09:50','17:00','emp1','office'),('2026-09-22','09:00','16:30','emp1','remote'),
                                ('2026-09-20','10:30','18:00','emp2','office'),('2026-09-23','09:10','17:00','emp2','office')]:
    e = f'{who}@almaster.tech'
    extra[f'attendance_days/{e}_{d}'] = {'email': e, 'name': who, 'date': d, 'leaderEmail': 'leader@almaster.tech', 'department': 'البرمجيات', 'mode': mode,
        'checkInMs': cairo(d,cin), 'checkOutMs': cairo(d,cout), 'workMs': cairo(d,cout)-cairo(d,cin)-1800000, 'breakMs': 1800000, 'meetingMs': 0, 'closed': True}
# legacy data for migration
extra['hr_stats/emp1@almaster.tech'] = {'annualLeavesLeft': 15}
extra['leave_requests/old1'] = {'user': 'emp2@almaster.tech', 'name': 'عمر خالد', 'managerId': 'leader@almaster.tech', 'req_class': 'leave', 'type': 'annual', 'start_date': '2026-10-04', 'end_date': '2026-10-05', 'reason': 'سفر', 'status': 'approved', 'submitted_at': ts(now-5*DAY)}
extra['monthly_schedules/emp2@almaster.tech_2026-10'] = {'userId': 'emp2@almaster.tech', 'monthId': '2026-10', 'days': {'2026-10-07': {'mode': 'online', 'start': '09:30', 'end': '18:00'}}}
extra['financial_months/2026-08'] = {'vault': 50000, 'vault_logs': [{'amount': 10000, 'note': 'إيداع', 'timestamp': now}], 'expenses': [{'title': 'إيجار', 'amount': 8000, 'date': '2026-08-05', 'type': 'general', 'timestamp': now}]}
extra['settings/general'] = {'weekend': [5], 'trackingStart': '2026-09-01', 'workStart': '09:00', 'workEnd': '17:00', 'graceMinutes': 15}
p = seed_payload(extra)
p['fs']['users/emp2@almaster.tech'].update({'salary_base': 11000, 'monthly_finance': {'2026-08': {'status': 'paid', 'bonus': 500, 'deductions': [{'amount': 200, 'reason': 'تأخير'}]}}, 'bank_account': '123'})

a = App()
a.seed(p)
pg = a.page
def step(name):
    errs = a.dump_errors(name); print('OK' if not errs else 'ERR', name)

# ---- employee
a.login('emp1@almaster.tech'); step('emp login')
pg.click('#start-btn'); pg.click('[data-mode="office"]'); pg.wait_for_timeout(1200)
pg.click('[data-st="Break"]'); pg.wait_for_timeout(1200); pg.click('[data-st="Online"]'); pg.wait_for_timeout(800); step('status changes')
u = a.db('users/emp1@almaster.tech'); print('  status', u['status'], u['timeBank'])
# leave request
pg.click('[data-rq="leave"]'); pg.wait_for_timeout(300)
pg.fill('[name=startDate]', '2026-09-28'); pg.fill('[name=endDate]', '2026-09-30'); pg.fill('[name=reason]', 'ظروف عائلية'); pg.wait_for_timeout(500)
a.shot('10-leave-form'); pg.click('#rq-send'); pg.wait_for_timeout(1200); step('leave submit')
pg.click('[data-rq="remote"]'); pg.wait_for_timeout(300); pg.fill('[name=startDate]', '2026-10-01'); pg.fill('[name=endDate]', '2026-10-01'); pg.click('#rq-send'); pg.wait_for_timeout(1000); step('remote submit')
pg.click('[data-rq="excuse"]'); pg.wait_for_timeout(300); pg.fill('[name=date]', '2026-09-21'); pg.fill('[name=fromTime]', '09:00'); pg.fill('[name=toTime]', '10:00'); pg.fill('[name=reason]', 'مشوار'); pg.click('#rq-send'); pg.wait_for_timeout(1000); step('excuse submit')
reqs = {k: v for k, v in a.db().items() if k.startswith('requests/')}
print('  requests:', [(v['type'], v['status'], v.get('days')) for v in reqs.values()])
a.shot('11-home-after'); a.go('#/requests'); pg.wait_for_timeout(600); a.shot('12-my-requests'); step('my requests')
a.go('#/attendance'); pg.wait_for_timeout(900); a.shot('13-my-attendance', True); step('my attendance')
a.go('#/profile'); pg.wait_for_timeout(800); a.shot('14-profile'); step('profile')

# ---- emp2 starts remote without approval (auto request)
a.login('emp2@almaster.tech'); step('emp2 login')
pg.click('#start-btn'); pg.click('[data-mode="remote"]'); pg.wait_for_timeout(1800); a.shot('15-remote-pending'); step('emp2 remote start')
print('  emp2 remotePending:', a.db('users/emp2@almaster.tech').get('remotePending'))
# ---- leader
a.login('leader@almaster.tech'); step('leader login')
a.go('#/approvals'); pg.wait_for_timeout(900); a.shot('20-approvals'); step('approvals')
n = pg.locator('[data-action="approve"]').count(); print('  inbox items', n)
for i in range(n):
    pg.locator('[data-action="approve"]').first.click(); pg.wait_for_timeout(1200)
step('leader approve all')
reqs = {k: v for k, v in a.db().items() if k.startswith('requests/')}
print('  after leader:', [(v['type'], v['status']) for v in reqs.values()])
print('  emp2 remotePending after approval:', a.db('users/emp2@almaster.tech').get('remotePending'), a.db('attendance_days/emp2@almaster.tech_2026-09-26').get('remotePending'))
a.go('#/schedules'); pg.wait_for_timeout(900)
pg.locator('.cell').nth(2).click(); pg.wait_for_timeout(300); pg.select_option('#sf [name=mode]', 'remote'); pg.click('#ok'); pg.wait_for_timeout(900); step('leader edits schedule')
print('  schedule emp1 2026-10:', a.db('schedules/emp1@almaster.tech_2026-10'))
a.go('#/monitor'); pg.wait_for_timeout(800); a.shot('21-monitor'); step('monitor')
a.go('#/reports'); pg.wait_for_timeout(1200); a.shot('22-reports-leader'); step('leader reports')
a.go('#/schedules'); pg.wait_for_timeout(900); a.shot('23-schedules'); step('schedules')
a.go('#/leaves'); pg.wait_for_timeout(900); step('leaves')

# ---- HR
a.login('hr@almaster.tech'); step('hr login')
a.go('#/approvals'); pg.wait_for_timeout(900); a.shot('30-hr-approvals')
pg.locator('[data-action="approve"]').first.click(); pg.wait_for_timeout(1500); step('hr approve leave')
print('  balance emp1:', a.db('balances/emp1@almaster.tech_2026'))
print('  schedule emp1 2026-09:', a.db('schedules/emp1@almaster.tech_2026-09'))
a.go('#/employees'); pg.wait_for_timeout(800); a.shot('31-employees'); step('employees')
pg.click('#add'); pg.wait_for_timeout(300)
pg.fill('[name=name]', 'ليلى إبراهيم'); pg.fill('[name=email]', 'new@almaster.tech')
pg.click('#et .tab[data-p=job]'); pg.fill('[name=title]', 'QA Engineer'); pg.fill('[name=department]', 'البرمجيات'); pg.select_option('[name=leaderEmail]', 'leader@almaster.tech')
pg.click('#et .tab[data-p=pay]'); pg.fill('[name=basic]', '9000')
a.shot('32-new-employee'); pg.click('#save'); pg.wait_for_timeout(1500); a.shot('33-created'); step('create employee')
print('  new user doc:', {k: v for k, v in (a.db('users/new@almaster.tech') or {}).items() if k in ('name','role','mustChangePassword','leaderEmail')})
pg.keyboard.press('Escape')
a.go('#/employees/emp1%40almaster.tech'); pg.wait_for_timeout(1200); a.shot('34-employee-file'); step('employee file')
a.go('#/daily'); pg.wait_for_timeout(1000); a.shot('35-daily'); step('daily')
a.go('#/leaves'); pg.wait_for_timeout(1000); a.shot('36-leaves'); step('hr leaves')
a.go('#/reports'); pg.wait_for_timeout(1200); a.shot('37-reports', True); step('hr reports')
pg.click('#rt .tab[data-t=people]'); pg.wait_for_timeout(500); a.shot('38-reports-people'); step('reports people')
pg.click('#xls'); pg.wait_for_timeout(500); print('  xlsx:', pg.evaluate('() => (window.__xlsx||[]).map(x=>[x.n, x.wb.SheetNames])'))
a.go('#/settings'); pg.wait_for_timeout(600); a.shot('39-settings'); step('settings')
for t in ['remote','leave','holidays','flow','pay']:
    pg.click(f'#st .tab[data-p={t}]'); pg.wait_for_timeout(300)
step('settings tabs')

# ---- admin: migration
a.login('admin@almaster.tech'); step('admin login')
a.go('#/settings'); pg.wait_for_timeout(500); pg.click('#st .tab[data-p=system]'); pg.wait_for_timeout(800)
pg.click('#dry'); pg.wait_for_timeout(1500); a.shot('40-migration-dry'); step('migration dry')
pg.click('#run'); pg.wait_for_timeout(300); pg.click('.modal [data-yes]'); pg.wait_for_timeout(2500); a.shot('41-migration-run'); step('migration run')
print('  emp2 after migration:', {k: v for k, v in a.db('users/emp2@almaster.tech').items() if k in ('salary_base','monthly_finance','bank_account','remoteQuota','role')})
print('  emp2 private:', a.db('employees_private/emp2@almaster.tech'))
print('  migrated req:', a.db('requests/old1') and a.db('requests/old1')['status'])
print('  emp1 balance annual:', a.db('balances/emp1@almaster.tech_2026')['types']['annual'])

# ---- finance
a.login('fin@almaster.tech'); step('fin login')
a.go('#/payroll'); pg.wait_for_timeout(800)
pg.click('[data-action=build]'); pg.wait_for_timeout(2000); a.shot('50-payroll'); step('payroll build')
pg.click('[data-action=approve]'); pg.wait_for_timeout(300); pg.click('.modal [data-yes]'); pg.wait_for_timeout(1500); step('payroll approve')
pg.click('[data-action=payall]'); pg.wait_for_timeout(300); pg.click('.modal [data-yes]'); pg.wait_for_timeout(2500); a.shot('51-payroll-paid'); step('payroll paid')
pg.locator('[data-action=slip]').first.click(); pg.wait_for_timeout(500); a.shot('52-payslip'); pg.keyboard.press('Escape'); step('payslip')
a.go('#/treasury'); pg.wait_for_timeout(800)
pg.click('[data-action=add][data-kind=out]'); pg.wait_for_timeout(300); pg.fill('[name=amount]', '1200'); pg.fill('[name=title]', 'فاتورة إنترنت'); pg.click('#ok'); pg.wait_for_timeout(1000)
a.shot('53-treasury'); step('treasury')

# ---- employee again
a.login('emp1@almaster.tech')
a.go('#/payslips'); pg.wait_for_timeout(800); a.shot('60-payslips'); step('emp payslips')
a.go('#/notifications'); pg.wait_for_timeout(600); a.shot('61-notifications'); step('notifications')
a.go('#/home'); pg.wait_for_timeout(800)
pg.click('#end-btn'); pg.wait_for_timeout(300); pg.click('.modal [data-yes]'); pg.wait_for_timeout(1200); a.shot('62-ended'); step('end day')
print('  day doc:', {k: v for k, v in a.db('attendance_days/emp1@almaster.tech_2026-09-26').items() if k in ('closed','closedBy','workMs','breakMs','checkOutMs')})

# ---- visual variants
a.set_pref(lang='en', theme='dark'); a.login('hr@almaster.tech'); a.go('#/monitor'); pg.wait_for_timeout(900); a.shot('70-en-dark-monitor'); step('en dark monitor')
a.go('#/reports'); pg.wait_for_timeout(1200); a.shot('71-en-dark-reports'); step('en dark reports')
a.set_pref(lang='ar', theme='light')
pg.set_viewport_size({'width': 390, 'height': 844})
a.login('emp1@almaster.tech'); pg.wait_for_timeout(800); a.shot('80-mobile-home', True); step('mobile home')
a.go('#/attendance'); pg.wait_for_timeout(900); a.shot('81-mobile-attendance', True); step('mobile attendance')
pg.click('#bn-more'); pg.wait_for_timeout(400); a.shot('82-mobile-menu'); step('mobile menu')
pg.goto('http://localhost:8765/index.html'); pg.wait_for_timeout(600); a.shot('83-mobile-login')
writes = pg.evaluate("() => JSON.parse(localStorage.getItem('mockwrites') || '[]')")
sig = {}
for w in writes:
    col = w['path'].split('/')[0]
    k = (w['actor'], col, w['op'], ','.join(sorted(w['changed'])) if w['op']=='update' else '')
    sig[k] = sig.get(k, 0) + 1
import json
json.dump([list(k)+[v] for k, v in sorted(sig.items(), key=lambda x: (str(x[0][0]), x[0][1]))], open('/home/claude/almaster-hr/tests/writes.json','w'), ensure_ascii=False, indent=0)
print('write signatures:', len(sig))
a.close()
