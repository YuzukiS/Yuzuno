"""A rejecting HTTP server must still count as network reachable."""
import errno
from http.server import BaseHTTPRequestHandler, HTTPServer
import importlib.util
from pathlib import Path
import socket
import threading
import unittest
from unittest.mock import patch
import urllib.error
import urllib.request

spec = importlib.util.spec_from_file_location('mac_client_host', Path(__file__).with_name('mac-client-host.py'))
helper = importlib.util.module_from_spec(spec)
spec.loader.exec_module(helper)


class Reject(BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_response(403)
        self.end_headers()

    def log_message(self, *args):
        pass


class MacTransportTest(unittest.TestCase):
    def test_http_403_is_reachable(self):
        with HTTPServer(('127.0.0.1', 0), Reject) as server:
            thread = threading.Thread(target=server.serve_forever, kwargs={'poll_interval': .01}, daemon=True)
            thread.start()
            try:
                host, port = server.server_address
                opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
                with self.assertRaises(urllib.error.HTTPError) as error:
                    opener.open(f'http://{host}:{port}/api/health', timeout=2)
                self.assertEqual(error.exception.code, 403)
                error.exception.close()
                self.assertEqual(helper.tcp_reachability(host, port), {'transport': 'tcp', 'reachable': True})
            finally:
                server.shutdown()
                thread.join(timeout=2)

    def test_refused_connection_is_recorded(self):
        # Reserve the port without listening, so another service cannot race in.
        with socket.socket() as reserved:
            reserved.bind(('127.0.0.1', 0))
            result = helper.tcp_reachability(*reserved.getsockname())
        self.assertFalse(result['reachable'])
        self.assertEqual(result['errno'], errno.ECONNREFUSED)

    def test_timeout_is_recorded(self):
        with patch.object(helper.socket, 'create_connection', side_effect=socket.timeout()):
            self.assertEqual(helper.tcp_reachability('127.0.0.1', 1)['reason'], 'timeout')

    def test_unexpected_local_failure_does_not_pass_isolation(self):
        with patch.object(helper.socket, 'create_connection', side_effect=OSError(errno.EMFILE, 'too many files')):
            with self.assertRaises(OSError):
                helper.tcp_reachability('127.0.0.1', 1)


if __name__ == '__main__':
    unittest.main()
