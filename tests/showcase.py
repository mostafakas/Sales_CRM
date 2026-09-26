import sys, time, random, datetime; sys.path.insert(0, '/home/claude/almaster-hr/tests')
from harness import App, seed_payload, ts
random.seed(7)
now = int(time.time()*1000)
def cairo(date, hm):
    y,m,d = map(int, date.split('-')); h,mi = map(int, hm.split(':'))
    return int(datetime.datetime(y,m,d,h,mi, tzinfo=datetime.timezone(datetime.timedelta(hours=3))).timestamp()*1000)
extra = {'settings/general': {'weekend': [5], 'trackingStart': '2026-09-01', 'workStart': '09:00', 'workEnd': '17:00', 'graceMinutes': 15},
         'settings/holidays': {'days': {'2026-10-06': 'عيد القوات المسلحة'}}}
p = seed_payload(extra)
more = [('dev3@almaster.tech','ندى سمير','UI/UX Designer','employee','leader@almaster.tech','التصميم'),('dev4@almaster.tech','مصطفى رأفت','Mobile Developer','employee','leader@almaster.tech','البرمجيات'),
        ('mkt@almaster.tech','خلود أحمد','Digital Marketing Specialist','employee','admin@almaster.tech','التسويق'),('mkt2@almaster.tech','محمد عبدالله','SEO Specialist','employee','admin@almaster.tech','التسويق')]
for e,n,t,r,l,d in more:
    p['auth'][e] = {'password': 'Passw0rd!'}
    p['fs'][f'users/{e}'] = {'name': n, 'title': t, 'role': r, 'leaderEmail': l, 'department': d, 'status': 'Offline', 'timeBank': {'Online':0,'Break':0,'Meeting':0}, 'dayKey': '', 'isSuspended': False, 'permissions': {}, 'remoteQuota': 4, 'createdAt': ts(cairo('2026-08-01','10:00'))}
    p['fs'][f'employees_private/{e}'] = {'email': e, 'salary': {'basic': random.choice([9000,11000,14000]), 'allowances': [{'name':'بدل مواصلات','amount':600}], 'fixedDeductions': 300}, 'contract': 'fulltime'}
people = [k.split('/',1)[1] for k in p['fs'] if k.startswith('users/')]
for e in people: p['fs'][f'users/{e}']['createdAt'] = ts(cairo('2026-08-01','10:00'))
d0 = datetime.date(2026,9,1)
for i in range(25):
    d = d0 + datetime.timedelta(days=i)
    if d.weekday() == 4: continue  # Friday
    ds = d.isoformat()
    for e in people:
        if e == 'admin@almaster.tech': continue
        if random.random() < 0.05: continue  # absent
        mode = 'remote' if random.random() < 0.15 else 'office'
        late = random.choice([0,0,0,0,5,10,20,35,70]) ; cin = cairo(ds, '09:00') + late*60000 + random.randint(-10,5)*60000
        cout = cairo(ds, '17:00') + random.randint(-25, 40)*60000
        brk = random.randint(20, 55)*60000
        p['fs'][f'attendance_days/{e}_{ds}'] = {'email': e, 'date': ds, 'name': p['fs'][f'users/{e}']['name'], 'leaderEmail': p['fs'][f'users/{e}']['leaderEmail'], 'department': p['fs'][f'users/{e}']['department'],
            'mode': mode, 'checkInMs': cin, 'checkOutMs': cout, 'workMs': cout-cin-brk, 'breakMs': brk, 'meetingMs': random.randint(0,60)*60000, 'closed': True}
# live statuses today
today = '2026-09-26'
live = {'emp1@almaster.tech': ('Online', '09:04', 'office', 3), 'emp2@almaster.tech': ('Break', '09:40', 'office', 1), 'dev3@almaster.tech': ('Meeting', '08:57', 'remote', 2), 'dev4@almaster.tech': ('Online', '09:12', 'office', 4), 'hr@almaster.tech': ('Online', '08:50', 'office', 5), 'mkt@almaster.tech': ('Online', '10:25', 'remote', 2)}
for e, (st, cin, mode, h) in live.items():
    u = p['fs'][f'users/{e}']
    u.update({'status': st, 'dayKey': today, 'workLocation': mode, 'firstOnlineAt': ts(cairo(today, cin)), 'lastChange': ts(now - random.randint(5, 40)*60000), 'lastChangeClient': now - 20*60000,
              'timeBank': {'Online': h*3600000, 'Break': random.randint(5,30)*60000, 'Meeting': random.randint(0,45)*60000}, 'checkedOut': False})
    p['fs'][f'attendance_days/{e}_{today}'] = {'email': e, 'date': today, 'leaderEmail': u['leaderEmail'], 'mode': mode, 'checkInMs': cairo(today, cin), 'closed': False, 'workMs': h*3600000}
# pending requests for leader
reqs = [('emp2@almaster.tech','عمر خالد','leave','annual','2026-10-04','2026-10-07',4,'سفر مع العيلة'),('dev3@almaster.tech','ندى سمير','remote',None,'2026-09-29','2026-09-29',1,'صيانة في البيت'),
        ('dev4@almaster.tech','مصطفى رأفت','excuse',None,'2026-09-28','2026-09-28',0,'مشوار حكومي الصبح')]
for i,(e,n,t,lt,s,en,days,reason) in enumerate(reqs):
    r = {'email': e, 'name': n, 'leaderEmail': 'leader@almaster.tech', 'type': t, 'startDate': s, 'endDate': en, 'days': days, 'reason': reason, 'status': 'pending_leader', 'stages': ['leader','hr'] if t=='leave' else ['leader'], 'createdMs': now-(i+1)*3600000, 'createdAt': ts(now-(i+1)*3600000),
         'history': [{'at': now-(i+1)*3600000, 'by': e, 'byName': n, 'action': 'submitted', 'note': ''}]}
    if lt: r['leaveType'] = lt
    if t=='excuse': r.update({'excuseKind':'late','fromTime':'09:00','toTime':'11:00','minutes':120})
    p['fs'][f'requests/r{i}'] = r
p['fs']['schedules/emp1@almaster.tech_2026-09'] = {'email': 'emp1@almaster.tech', 'month': '2026-09', 'leaderEmail': 'leader@almaster.tech', 'days': {'2026-09-29': {'mode':'leave','leaveType':'annual','requestId':'x'}, '2026-09-30': {'mode':'remote','requestId':'y'}}}
p['fs']['users/admin@almaster.tech']['trackAttendance'] = False
p['fs']['balances/emp1@almaster.tech_2026'] = {'email':'emp1@almaster.tech','year':2026,'types':{'annual':{'entitled':21,'used':6,'adjust':0},'casual':{'entitled':6,'used':1,'adjust':0},'sick':{'entitled':14,'used':0,'adjust':0},'unpaid':{'entitled':0,'used':0,'adjust':0}}}

a = App(); a.seed(p); pg = a.page
def shot(name, full=False, wait=900):
    pg.wait_for_timeout(wait); a.shot(name, full)
pg.goto('http://localhost:8765/index.html'); shot('s01-login', wait=1500)
a.login('emp1@almaster.tech'); shot('s02-my-day', wait=1500)
a.go('#/attendance'); shot('s03-my-attendance', True, 1500)
pg.click('[data-rq]') if pg.locator('[data-rq]').count() else None
a.go('#/requests'); pg.click('#new-btn'); shot('s04-new-request', wait=800); pg.keyboard.press('Escape')
a.login('leader@almaster.tech'); a.go('#/approvals'); shot('s05-approvals', wait=1500)
a.go('#/monitor'); shot('s06-monitor', wait=1200)
a.login('hr@almaster.tech'); a.go('#/reports'); shot('s07-reports', True, 2000)
a.go('#/daily'); shot('s08-daily', wait=1500)
a.go('#/schedules'); shot('s09-schedules', wait=1200)
a.go('#/employees'); shot('s10-employees', wait=1000)
a.login('fin@almaster.tech'); a.go('#/payroll'); pg.wait_for_timeout(800); pg.click('[data-action=build]'); pg.wait_for_timeout(5500); shot('s11-payroll', wait=200)
pg.locator('[data-action=slip]').nth(1).click(); shot('s12-payslip', wait=900); pg.keyboard.press('Escape')
a.set_pref(lang='en', theme='dark'); a.login('hr@almaster.tech'); a.go('#/monitor'); shot('s13-en-dark', wait=1500)
a.set_pref(lang='ar', theme='light'); pg.set_viewport_size({'width': 390, 'height': 844}); a.login('dev3@almaster.tech'); shot('s14-mobile', wait=1500)
a.dump_errors('showcase')
a.close()
