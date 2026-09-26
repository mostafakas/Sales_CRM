"""Requests: the form closes right away, approvers and employees get live popups (different kinds), sales link gone for admin."""
import sys, json, os, time; sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from harness import App, seed_payload, BASE, ts
p = seed_payload({'settings/migration': {'done': True}})
a = App(); pg = a.page
ok = lambda c, m: print(('OK ' if c else 'FAIL ') + m)
a.seed(p)
inject = """(d) => { const fs = JSON.parse(localStorage.getItem('mockfs')); fs['notifications/' + d.id] = d.doc; fs['notifications/' + d.id].at = { __ts: Date.now() + 1000 };
  const v = JSON.stringify(fs); localStorage.setItem('mockfs', v); window.dispatchEvent(new StorageEvent('storage', { key: 'mockfs', newValue: v })); }"""

# 1) employee submits a remote-work request: modal closes, approver notified with kind=request
a.login('emp1@almaster.tech'); a.go('#/requests'); pg.wait_for_timeout(500)
pg.click('#new-btn'); pg.wait_for_timeout(400)
pg.select_option('.modal select[name=type]', 'remote'); pg.wait_for_timeout(300)
d = time.strftime('%Y-%m-%d', time.localtime(time.time() + 86400 * 3))
while time.strptime(d, '%Y-%m-%d').tm_wday in (4, 5): d = time.strftime('%Y-%m-%d', time.localtime(time.mktime(time.strptime(d, '%Y-%m-%d')) + 86400))
pg.fill('.modal [name=startDate]', d); pg.fill('.modal [name=endDate]', d); pg.fill('.modal [name=reason]', 'صيانة في البيت')
t0 = time.time(); pg.click('#rq-send'); pg.wait_for_selector('.modal-root .modal', state='detached', timeout=8000)
ok(time.time() - t0 < 5, f'request form closed in {time.time() - t0:.1f}s')
notes = [v for k, v in a.db().items() if k.startswith('notifications/')]
ok(any(n.get('to') == 'leader@almaster.tech' and n.get('kind') == 'request' for n in notes), 'leader notified (kind=request)')

# 2) leader approves → employee notification kind=approved
a.login('leader@almaster.tech'); a.go('#/approvals'); pg.wait_for_timeout(900)
pg.locator('[data-action=approve]').first.click(); pg.wait_for_timeout(400)
m = pg.locator('.modal-root .modal').last
if m.count(): m.locator('[data-yes]').click()
pg.wait_for_timeout(1200)
notes = [v for k, v in a.db().items() if k.startswith('notifications/')]
ok(any(n.get('to') == 'emp1@almaster.tech' and n.get('kind') == 'approved' for n in notes), 'employee notified (kind=approved)')

# 3) live popups while signed in (different kinds)
a.login('emp1@almaster.tech'); pg.wait_for_timeout(900)
pg.evaluate(inject, {'id': 'live1', 'doc': {'to': 'emp1@almaster.tech', 'title': 'تم اعتماد طلبك: عمل أونلاين', 'body': '', 'link': '#/requests', 'kind': 'approved', 'read': False, 'from': 'leader@almaster.tech'}})
pg.wait_for_timeout(700)
ok(pg.locator('.chat-pop.ok').count() == 1 and 'اعتماد' in pg.locator('.chat-pop.ok').inner_text(), 'approved popup (green)')
pg.evaluate(inject, {'id': 'live2', 'doc': {'to': 'emp1@almaster.tech', 'title': 'تم رفض طلبك: إجازة', 'body': 'ضغط شغل', 'link': '#/requests', 'kind': 'rejected', 'read': False, 'from': 'leader@almaster.tech'}})
pg.wait_for_timeout(700)
ok(pg.locator('.chat-pop.bad').count() == 1, 'rejected popup (red)')
a.shot('f7-popups')
a.login('leader@almaster.tech'); pg.wait_for_timeout(900)
pg.evaluate(inject, {'id': 'live3', 'doc': {'to': 'leader@almaster.tech', 'title': 'طلب جديد: إجازة', 'body': 'عمر خالد', 'link': '#/approvals', 'kind': 'request', 'read': False, 'from': 'emp2@almaster.tech'}})
pg.wait_for_timeout(700)
ok(pg.locator('.chat-pop.warn').count() == 1 and 'مراجعة' in pg.locator('.chat-pop.warn').inner_text(), 'new-request popup for the approver')

# 4) admin menu: no sales system
a.login('admin@almaster.tech'); pg.wait_for_timeout(600)
ok('CRM' not in pg.locator('#nav').inner_text() and 'المبيعات' not in pg.locator('#nav').inner_text(), 'sales link removed for admin')
ok('الشات' in pg.locator('#nav').inner_text(), 'chat tab in admin side menu')
a.dump_errors('flow7')
a.close()
