"""Reset-password page, project-manager role, chat (text/image/file, unread, popup, admin view + archive), activity log."""
import sys, json, os, io, time; sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from harness import App, seed_payload, BASE, ts
from PIL import Image

p = seed_payload({'settings/migration': {'done': True}})
p['auth']['pm@almaster.tech'] = {'password': 'Passw0rd!'}
p['fs']['users/pm@almaster.tech'] = {'name': 'أحمد شحاتة', 'title': 'General Project Manager', 'role': 'pm', 'leaderEmail': '', 'department': 'الإدارة', 'status': 'Offline',
                                      'timeBank': {'Online': 0, 'Break': 0, 'Meeting': 0}, 'dayKey': '', 'isSuspended': False, 'permissions': {}, 'remoteQuota': 4, 'createdAt': ts(int(time.time() * 1000))}
a = App(); pg = a.page
ok = lambda c, m: print(('OK ' if c else 'FAIL ') + m)
a.seed(p)

# 1) reset-password page
pg.evaluate("() => localStorage.setItem('mockauth_codes', JSON.stringify({ CODE1: 'emp1@almaster.tech' }))")
pg.goto(BASE + '/reset.html?mode=resetPassword&oobCode=CODE1'); pg.wait_for_timeout(800)
ok('emp1@almaster.tech' in pg.locator('#state').inner_text(), 'reset page shows the account')
pg.fill('#p1', 'short'); pg.fill('#p2', 'short'); pg.click('#save'); pg.wait_for_timeout(200)
ok(pg.locator('#err').is_visible(), 'short password rejected')
pg.fill('#p1', 'NewPass123'); pg.fill('#p2', 'NewPass123'); pg.click('#save'); pg.wait_for_timeout(600)
ok(pg.locator('#go').count() == 1, 'password changed → sign-in button')
pg.click('#go'); pg.wait_for_timeout(700)
ok(pg.input_value('#email') == 'emp1@almaster.tech', 'sign-in prefilled after reset')
a.login('emp1@almaster.tech', 'NewPass123'); ok('app.html' in pg.url, 'signs in with the new password')
pg.goto(BASE + '/reset.html?mode=resetPassword&oobCode=CODE1'); pg.wait_for_timeout(700)
ok('انتهى' in pg.locator('#state').inner_text(), 'used link shows expired')

# 2) chat: emp1 → emp2 (text, image, file)
a.login('emp1@almaster.tech', 'NewPass123'); a.go('#/chat'); pg.wait_for_timeout(600)
pg.click('#new'); pg.wait_for_timeout(200)
ok(pg.locator('#plist .chat-person').count() >= 6 and pg.locator('#plist .avatar').count() >= 6, 'picker lists everyone with avatars')
pg.fill('#pq', 'عمر'); pg.wait_for_timeout(200); pg.click('#plist [data-to="emp2@almaster.tech"]'); pg.wait_for_timeout(900)
ok('#/chat/' in pg.url, 'conversation opened')
pg.fill('#text', 'أهلاً يا عمر، ابعتلي التقرير'); pg.keyboard.press('Enter'); pg.wait_for_timeout(700)
buf = io.BytesIO(); Image.new('RGB', (900, 600), (27, 27, 219)).save(buf, 'PNG')
pg.set_input_files('#file', files=[{'name': 'design.png', 'mimeType': 'image/png', 'buffer': buf.getvalue()}]); pg.wait_for_timeout(1500)
pg.set_input_files('#file', files=[{'name': 'report.pdf', 'mimeType': 'application/pdf', 'buffer': b'%PDF-1.4 test ' * 2000}]); pg.wait_for_timeout(1500)
db = a.db(); cid = 'emp1@almaster.tech__emp2@almaster.tech'
msgs = [v for k, v in db.items() if k.startswith(f'chats/{cid}/messages/')]
ok(len(msgs) == 3 and {m['type'] for m in msgs} == {'text', 'image', 'file'}, f'3 messages stored ({len(msgs)})')
ok(db[f'chats/{cid}']['unread']['emp2_almaster_tech'] == 3, 'recipient unread = 3')
files = [k for k in db if k.startswith('chat_files/') and '/chunks/' not in k]
ok(len(files) == 2 and all(any(c.startswith(f + '/chunks/') for c in db) for f in files), 'files stored in chunks')
ok(pg.locator('.chat-row.me .chat-img img').count() == 1 and pg.locator('.chat-row.me .chat-file').count() == 1, 'image & file bubbles rendered')
a.shot('f6-chat-emp1')

# 3) emp2: badge, open, unread cleared, reply, popup for a new incoming message
a.login('emp2@almaster.tech'); pg.wait_for_timeout(1200)
ok(pg.locator('#nav [data-badge=chat]').inner_text() == '3', f"sidebar chat badge = {pg.locator('#nav [data-badge=chat]').inner_text()}")
nav_items = pg.locator('#nav .nav-item').all_inner_texts()
ok(any('الشات' in t for t in nav_items[:3]) and not any('CRM' in t or 'المبيعات' in t for t in nav_items), 'chat tab near the top of the side menu, no sales link')
a.go(f'#/chat/{cid}'); pg.wait_for_timeout(1200)
ok(pg.locator('.chat-row.them').count() == 3, 'recipient sees the 3 messages')
ok(a.db(f'chats/{cid}')['unread']['emp2_almaster_tech'] == 0, 'opening clears unread')
pg.locator('.chat-file').first.click(); pg.wait_for_timeout(800)
pg.fill('#text', 'تمام، هبعته بعد ساعة'); pg.click('#compose [type=submit]'); pg.wait_for_timeout(700)
ok(a.db(f'chats/{cid}')['unread']['emp1_almaster_tech'] >= 1, 'reply counted for emp1')
a.go('#/home'); pg.wait_for_timeout(600)
pg.evaluate("""(cid) => { const fs = JSON.parse(localStorage.getItem('mockfs')); const t = { __ts: Date.now() + 60000 };
  fs['chats/' + cid + '/messages/zz'] = { by: 'emp1@almaster.tech', type: 'text', text: 'فين التقرير؟', at: t };
  const c = fs['chats/' + cid]; c.lastMessage = { by: 'emp1@almaster.tech', text: 'فين التقرير؟', type: 'text', at: t }; c.unread.emp2_almaster_tech = 1; c.updatedAt = t;
  const v = JSON.stringify(fs); localStorage.setItem('mockfs', v); window.dispatchEvent(new StorageEvent('storage', { key: 'mockfs', newValue: v })); }""", cid)
pg.wait_for_timeout(900)
ok(pg.locator('.chat-pop').count() == 1 and 'فين التقرير' in pg.locator('.chat-pop').inner_text(), 'popup for a new message')
a.shot('f6-popup')

# 4) project manager
a.login('pm@almaster.tech'); pg.wait_for_timeout(600)
nav = pg.locator('#nav').inner_text()
ok('المتابعة اللحظية' in nav and 'التقارير الشهرية' in nav and 'الإجازات والأرصدة' in nav, 'PM sees monitor, reports, leaves')
ok('الموظفين' not in nav and 'الرواتب' not in nav and 'الإعدادات' not in nav, 'PM has no HR/payroll/settings')
a.go('#/monitor'); pg.wait_for_timeout(1200)
ok(pg.locator('.mon-table tbody tr').count() >= 5, f"PM monitor shows everyone ({pg.locator('.mon-table tbody tr').count()})")
a.go('#/reports'); pg.wait_for_timeout(1500)
ok('تعذّر' not in pg.locator('#view').inner_text(), 'PM reports load')

# 5) admin: all chats, archive, activity log
a.login('admin@almaster.tech'); a.go('#/chat'); pg.wait_for_timeout(700)
pg.click('#modes [data-m=all]'); pg.wait_for_timeout(600)
ok(pg.locator('.chat-conv').count() == 1, 'admin sees all conversations')
pg.locator('.chat-conv').first.click(); pg.wait_for_timeout(1200)
ok(pg.locator('.chat-row').count() >= 4 and pg.locator('#compose').count() == 0, 'admin reads the conversation (read-only)')
pg.click('#arch'); pg.wait_for_timeout(300); pg.locator('.modal-root .modal').last.locator('[data-yes]').click(); pg.wait_for_timeout(1500)
db = a.db()
ok(not any(k.startswith(f'chats/{cid}/messages/') for k in db) and sum(1 for k in db if k.startswith(f'chat_archive/{cid}/messages/')) >= 4, 'messages moved to admin archive')
pg.click('#arch-view'); pg.wait_for_timeout(900)
ok(pg.locator('.chat-bubble.archived').count() >= 4, 'archived messages visible to admin')
a.go('#/activity'); pg.wait_for_timeout(1500)
txt = pg.locator('#out').inner_text()
ok('سجّل دخول' in txt and 'أرشف محادثة' in txt, 'activity log shows sign-ins and the archive')
pg.select_option('#who', 'emp1@almaster.tech'); pg.wait_for_timeout(400)
ok('سارة' in pg.locator('#who-card').inner_text() and 'سجّل دخول' in pg.locator('#out').inner_text(), 'filter by person')
a.shot('f6-activity', True)
a.dump_errors('flow6')
a.close()
