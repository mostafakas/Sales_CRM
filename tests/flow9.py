"""Firebase quota exhausted: the app explains it instead of spinning."""
import sys, os; sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from harness import App, seed_payload, BASE
a = App(); pg = a.page
ok = lambda c, m: print(('OK ' if c else 'FAIL ') + m)
a.seed(seed_payload({'settings/migration': {'done': True}}))
a.login('emp1@almaster.tech')
pg.evaluate("() => localStorage.setItem('mock_quota', '1')")
pg.reload(); pg.wait_for_timeout(2000)
ok('الحد اليومي' in pg.locator('#splash').inner_text(), 'splash explains the quota')
a.shot('f9-quota')
a.close()
