"""The Simulator check's page server (T-170), never part of the app.

Serves a directory on 127.0.0.1 only, with the measuring probe added to its
index.html, so Mobile Safari in the same Simulator can open the same page
the app shows and the UI test can read what Safari gives it.
"""
import argparse
import functools
import http.server
import pathlib

parser = argparse.ArgumentParser()
parser.add_argument('--root', required=True)
parser.add_argument('--probe', required=True)
parser.add_argument('--port', type=int, required=True)
args = parser.parse_args()
root = pathlib.Path(args.root).resolve()
probe = pathlib.Path(args.probe).read_bytes()


class Handler(http.server.SimpleHTTPRequestHandler):
    def do_GET(self):
        path = self.path.split('?', 1)[0]
        if path == '/__probe.js':
            return self.send_body(probe, 'text/javascript')
        if path in ('/', '/index.html'):
            page = (root / 'index.html').read_bytes()
            assert b'</head>' in page
            return self.send_body(page.replace(b'</head>', b'<script src="/__probe.js"></script></head>', 1), 'text/html; charset=utf-8')
        return super().do_GET()

    def send_body(self, body, kind):
        self.send_response(200)
        self.send_header('Content-Type', kind)
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Cache-Control', 'no-store')
        self.end_headers()
        self.wfile.write(body)


server = http.server.ThreadingHTTPServer(('127.0.0.1', args.port), functools.partial(Handler, directory=str(root)))
print(f'serving {root} at http://127.0.0.1:{args.port}/', flush=True)
server.serve_forever()
