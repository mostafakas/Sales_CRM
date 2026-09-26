"""Browser test harness: serves the app locally and swaps the Firebase CDN for the in-memory test double."""
import json, os, threading, http.server, socketserver, functools, time, sys
from playwright.sync_api import sync_playwright

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PORT = 8765
BASE = f'http://localhost:{PORT}'
SHOTS = os.path.join(ROOT, 'tests', 'shots')
os.makedirs(SHOTS, exist_ok=True)

class Quiet(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *a): pass
    def end_headers(self):
        self.send_header('Cache-Control', 'no-store'); super().end_headers()

def serve():
    socketserver.TCPServer.allow_reuse_address = True
    h = functools.partial(Quiet, directory=ROOT)
    srv = socketserver.ThreadingTCPServer(('127.0.0.1', PORT), h)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv

MOCK = os.path.join(ROOT, 'tests', 'mock')
def route(r):
    url = r.request.url
    if 'gstatic.com/firebasejs/' in url:
        name = url.split('/')[-1].split('?')[0]
        p = os.path.join(MOCK, name)
        if os.path.exists(p):
            return r.fulfill(status=200, body=open(p, encoding='utf-8').read(), headers={'Content-Type': 'application/javascript', 'Access-Control-Allow-Origin': '*'})
        return r.fulfill(status=404, body='')
    if 'xlsx' in url and 'cdnjs' in url:
        return r.fulfill(status=200, body='window.XLSX={utils:{book_new:()=>({SheetNames:[],Sheets:{}}),json_to_sheet:(d)=>({d}),aoa_to_sheet:(d)=>({d}),book_append_sheet:(wb,ws,n)=>{wb.SheetNames.push(n);wb.Sheets[n]=ws;}},writeFile:(wb,n)=>{window.__xlsx=(window.__xlsx||[]).concat([{n,wb}]);}};', headers={'Content-Type': 'application/javascript', 'Access-Control-Allow-Origin': '*'})
    ASSETS = '/tmp/claude-0/-home-claude/421810db-a6e5-5109-a05a-94c4076ca1d2/scratchpad/assets'
    if os.path.isdir(ASSETS):
        fa = os.path.join(ASSETS, 'fontawesome-free-6.5.2-web')
        if 'font-awesome' in url and url.endswith('all.min.css'):
            return r.fulfill(status=200, body=open(os.path.join(fa, 'css', 'all.min.css'), 'rb').read(), headers={'Content-Type': 'text/css', 'Access-Control-Allow-Origin': '*'})
        if 'font-awesome' in url and '/webfonts/' in url:
            f = os.path.join(fa, 'webfonts', url.split('/webfonts/')[-1].split('?')[0])
            if os.path.exists(f): return r.fulfill(status=200, body=open(f, 'rb').read(), headers={'Content-Type': 'font/woff2', 'Access-Control-Allow-Origin': '*'})
        if 'fonts.googleapis' in url:
            css = ''.join(f"@font-face{{font-family:'IBM Plex Sans Arabic';font-weight:{w};src:url(https://fonts.gstatic.com/local/plex-{n}.woff2) format('woff2');}}" for w, n in [(400, 'Regular'), (500, 'Medium'), (600, 'SemiBold'), (700, 'Bold')])
            return r.fulfill(status=200, body=css, headers={'Content-Type': 'text/css', 'Access-Control-Allow-Origin': '*'})
        if 'fonts.gstatic.com/local/plex-' in url:
            n = url.split('plex-')[-1].replace('.woff2', '')
            f = os.path.join(ASSETS, 'ibm-plex-sans-arabic', 'fonts', 'complete', 'woff2', f'IBMPlexSansArabic-{n}.woff2')
            if os.path.exists(f): return r.fulfill(status=200, body=open(f, 'rb').read(), headers={'Content-Type': 'font/woff2', 'Access-Control-Allow-Origin': '*'})
    if any(h in url for h in ['fonts.googleapis', 'fonts.gstatic', 'cdnjs.cloudflare', 'cdn.jsdelivr', 'ui-avatars', 'api.dicebear', 'cdn.tailwindcss']):
        ct = 'text/css' if ('.css' in url or 'fonts.googleapis' in url) else 'application/javascript'
        return r.fulfill(status=200, body='', headers={'Content-Type': ct, 'Access-Control-Allow-Origin': '*'})
    if url.startswith(BASE):
        return r.continue_()
    return r.fulfill(status=404, body='')

def ts(ms): return {'__ts': int(ms)}

def seed_payload(extra_docs=None, now_ms=None):
    now_ms = now_ms or int(time.time() * 1000)
    people = [
        ('admin@almaster.tech', 'أحمد شحاتة', 'General Project Manager', 'admin', '', 'الإدارة'),
        ('hr@almaster.tech', 'منى عادل', 'HR Specialist', 'hr', 'admin@almaster.tech', 'الموارد البشرية'),
        ('leader@almaster.tech', 'كريم حسن', 'Team Lead — Software', 'leader', 'admin@almaster.tech', 'البرمجيات'),
        ('emp1@almaster.tech', 'سارة محمود', 'Frontend Developer', 'employee', 'leader@almaster.tech', 'البرمجيات'),
        ('emp2@almaster.tech', 'عمر خالد', 'Backend Developer', 'employee', 'leader@almaster.tech', 'البرمجيات'),
        ('fin@almaster.tech', 'ياسمين فؤاد', 'Accountant', 'finance', 'admin@almaster.tech', 'المالية'),
    ]
    auth = {e: {'password': 'Passw0rd!'} for e, *_ in people}
    fs = {}
    for e, n, t, r, l, d in people:
        fs[f'users/{e}'] = {'name': n, 'title': t, 'role': r, 'leaderEmail': l, 'department': d, 'gender': 'female' if n.split()[0] in ('منى', 'سارة', 'ياسمين') else 'male',
                            'status': 'Offline', 'timeBank': {'Online': 0, 'Break': 0, 'Meeting': 0}, 'dayKey': '', 'isSuspended': False,
                            'permissions': {'crm': r in ('admin',), 'payroll': r == 'finance'}, 'remoteQuota': 4, 'createdAt': ts(now_ms)}
        fs[f'employees_private/{e}'] = {'email': e, 'salary': {'basic': 12000 if r == 'employee' else 18000, 'allowances': [{'name': 'بدل مواصلات', 'amount': 800}], 'fixedDeductions': 350}, 'contract': 'fulltime', 'phone': '0100000000'}
    if extra_docs: fs.update(extra_docs)
    return {'auth': auth, 'fs': fs}

class App:
    def __init__(self, headless=True, width=1366, height=900):
        self.srv = serve()
        self.pw = sync_playwright().start()
        self.browser = self.pw.chromium.launch(headless=headless, args=['--disable-web-security'])
        self.errors = []
        self.new_context(width, height)
    def new_context(self, width=1366, height=900, locale='ar-EG'):
        self.ctx = self.browser.new_context(viewport={'width': width, 'height': height}, locale=locale, timezone_id='Africa/Cairo')
        self.ctx.route('**/*', route)
        self.page = self.ctx.new_page()
        self.page.on('pageerror', lambda e: self.errors.append(f'PAGEERROR {e}'))
        self.page.on('console', lambda m: self.errors.append(f'CONSOLE.{m.type} {m.text}') if m.type in ('error', 'warning') else None)
        return self.page
    def seed(self, payload, lang='ar', theme='light'):
        self.page.goto(BASE + '/tests/blank.html')
        self.page.evaluate("""([p, lang, theme]) => { localStorage.clear(); sessionStorage.clear();
            localStorage.setItem('mockauth_users', JSON.stringify(p.auth)); localStorage.setItem('mockfs', JSON.stringify(p.fs));
            localStorage.setItem('am_lang', lang); localStorage.setItem('am_theme', theme); }""", [payload, lang, theme])
    def set_pref(self, lang=None, theme=None):
        self.page.goto(BASE + '/tests/blank.html')
        if lang: self.page.evaluate("l => localStorage.setItem('am_lang', l)", lang)
        if theme: self.page.evaluate("t => localStorage.setItem('am_theme', t)", theme)
    def login(self, email, password='Passw0rd!'):
        p = self.page
        p.evaluate("() => localStorage.removeItem('mockauth_current')") if p.url.startswith(BASE) else None
        p.goto(BASE + '/index.html')
        p.fill('#email', email); p.fill('#password', password)
        p.click('#login-btn')
        p.wait_for_url('**/app.html**', timeout=8000)
        p.wait_for_selector('#splash', state='detached', timeout=8000)
    def go(self, hash_):
        self.page.evaluate("h => location.hash = h", hash_)
        self.page.wait_for_timeout(500)
    def shot(self, name, full=False):
        self.page.screenshot(path=os.path.join(SHOTS, name + '.png'), full_page=full)
    def db(self, path=None):
        data = self.page.evaluate("() => JSON.parse(localStorage.getItem('mockfs') || '{}')")
        return data if path is None else data.get(path)
    def dump_errors(self, label=''):
        errs = [e for e in self.errors if 'favicon' not in e and 'Failed to load resource' not in e]
        if errs: print(f'--- errors {label} ---'); [print(' ', e[:400]) for e in errs]
        self.errors.clear()
        return errs
    def close(self):
        self.browser.close(); self.pw.stop(); self.srv.shutdown()
