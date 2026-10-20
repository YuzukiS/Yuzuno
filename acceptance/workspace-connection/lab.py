#!/usr/bin/env python3
"""Serve only the T-6 isolated build and synthetic local HTTP/SSE fault controls."""
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import mimetypes
from pathlib import Path
from urllib.parse import unquote, urlsplit

ROOT = Path(__file__).resolve().parents[2]
DIST = ROOT / 'target/workspace-connection-dist'
FIXTURE = ROOT / 'web/tools/connection-fixture.mjs'
CONTROLS = '''<section id="fault-controls" aria-label="Connection fault simulation">
<strong>T-6 · 故障模拟 · 未连接 Core</strong>
<select aria-label="Simulated condition" onchange="connectionFixture.scenario(this.value)">
<option value="ok">正常 / 恢复</option><option value="catalog">Codex 目录失败</option>
<option value="sse">仅 SSE 断开</option><option value="offline">HTTP + SSE 断开</option>
<option value="http500">HTTP 500 + SSE 正常</option><option value="hang">快照挂起（10秒超时）</option>
</select><button onclick="connectionFixture.release()">释放旧响应</button>
</section>'''
STYLE = '''<style>
#fault-controls{min-height:52px;padding:9px 15px;box-sizing:border-box;display:flex;align-items:center;flex-wrap:wrap;gap:10px;background:var(--cream);color:var(--ink);border-bottom:1px solid var(--line);font:12px system-ui}
#fault-controls select,#fault-controls button{padding:6px;background:var(--paper);color:var(--ink);border:1px solid var(--line);border-radius:6px}
body{display:flex;flex-direction:column;height:100dvh}#root{flex:1;min-height:0}#root>.app{height:100%}
</style>'''

class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        route = unquote(urlsplit(self.path).path)
        if route == '/':
            html = (DIST/'index.html').read_text()
            html = html.replace('</head>', '<script src="/fault-fixture.js"></script>' + STYLE + '</head>')
            html = html.replace('<body>', '<body>' + CONTROLS)
            body, kind = html.encode(), 'text/html; charset=utf-8'
        elif route == '/fault-fixture.js':
            body = (FIXTURE.read_text().replace('export function ', 'function ', 1) + '\ninstallConnectionFixture();').encode()
            kind = 'text/javascript; charset=utf-8'
        elif route.startswith('/assets/'):
            path = (DIST / route.lstrip('/')).resolve()
            if not path.is_relative_to((DIST/'assets').resolve()) or not path.is_file(): self.send_error(404); return
            body, kind = path.read_bytes(), mimetypes.guess_type(path)[0] or 'application/octet-stream'
        else: self.send_error(404); return
        self.send_response(200)
        self.send_header('Content-Type', kind); self.send_header('Cache-Control', 'no-store')
        self.send_header('Content-Length', str(len(body))); self.send_header('X-Content-Type-Options', 'nosniff')
        self.end_headers(); self.wfile.write(body)
    def do_POST(self): self.send_error(405, 'No Core or write API in this lab')
    do_PUT = do_PATCH = do_DELETE = do_POST

if __name__ == '__main__':
    server = ThreadingHTTPServer(('127.0.0.1', 4391), Handler)
    print('http://127.0.0.1:4391 — synthetic connection faults; no Core', flush=True)
    try: server.serve_forever()
    except KeyboardInterrupt: pass
    finally: server.server_close()
