#!/usr/bin/env python3
"""A stand-in for Tailscale Serve's HTTPS side (T-5), for a browser on the Core
host. It reads the Serve configuration the stand-in tailscale.exe keeps
(acceptance/t185-remote-access/fake_tailscale.py) and, about twice a second,
listens on 127.0.0.1:<port> with TLS for each of its HTTPS entries on the
ports given (and stops listening when an entry goes). For each request it does
what Serve does with identity headers: it removes any Tailscale-* header the
client sent, sets Tailscale-User-Login to the state's owner, keeps the
browser's Host, adds X-Forwarded-For, and proxies to the entry's target. Every
request is appended to --log as one JSON line.

    serve_proxy.py --state <tailscale.exe.json> --cert C --key K --ports 18444,18445 --log requests.jsonl

The browser reaches it as https://<node>:<port> with Chromium's
--host-resolver-rules mapping the node's name to 127.0.0.1 and the stand-in's
certificate ignored. Nothing here reaches Tailscale, Windows or a daily Core.
"""
import argparse, http.client, http.server, json, ssl, threading, time

HOP = {"connection", "keep-alive", "proxy-connection", "transfer-encoding", "te", "trailer", "upgrade"}


def read_state(path):
    """The stand-in's state; it rewrites the file in place, so a read can meet it half written."""
    for _ in range(50):
        try:
            return json.load(open(path))
        except (OSError, ValueError):
            time.sleep(0.02)
    return {}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--state", required=True)
    parser.add_argument("--cert", required=True)
    parser.add_argument("--key", required=True)
    parser.add_argument("--ports", required=True, help="the only Serve ports to play, comma separated")
    parser.add_argument("--log", required=True)
    args = parser.parse_args()
    ports = {int(p) for p in args.ports.split(",")}
    tls = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    tls.load_cert_chain(args.cert, args.key)
    lock = threading.Lock()

    def note(entry):
        with lock, open(args.log, "a") as log:
            log.write(json.dumps({"at": time.time(), **entry}) + "\n")

    def handler(port):
        class Handler(http.server.BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.0"

            def log_message(self, *_):
                pass

            def forward(self):
                state = read_state(args.state)
                web = state.get("serve", {}).get("Web", {})
                entry = next((v for k, v in web.items() if k.rsplit(":", 1)[-1] == str(port)), None)
                target = entry and entry.get("Handlers", {}).get("/", {}).get("Proxy")
                if not target:
                    self.send_error(502, "no Serve entry")
                    note({"port": port, "method": self.command, "path": self.path, "status": 502})
                    return
                host, _, target_port = target.removeprefix("http://").partition(":")
                length = int(self.headers.get("content-length") or 0)
                body = self.rfile.read(length) if length else None
                headers = {k: v for k, v in self.headers.items()
                           if not k.lower().startswith("tailscale-") and k.lower() not in HOP and k.lower() != "x-forwarded-for"}
                headers["Tailscale-User-Login"] = state["owner"]
                headers["X-Forwarded-For"] = "100.64.0.2"
                upstream = http.client.HTTPConnection(host, int(target_port), timeout=60)
                try:
                    upstream.request(self.command, self.path, body=body, headers=headers)
                    answer = upstream.getresponse()
                except OSError as error:
                    self.send_error(502, str(error))
                    note({"port": port, "method": self.command, "path": self.path, "status": 502, "error": str(error)})
                    return
                self.send_response_only(answer.status, answer.reason)
                for k, v in answer.getheaders():
                    if k.lower() not in HOP:
                        self.send_header(k, v)
                self.end_headers()
                note({"port": port, "method": self.command, "path": self.path, "status": answer.status,
                      "origin": self.headers.get("origin"), "referer": self.headers.get("referer")})
                try:
                    while chunk := answer.read1(65536):
                        self.wfile.write(chunk)
                        self.wfile.flush()
                except OSError:
                    pass
                finally:
                    upstream.close()

            do_GET = do_POST = do_PUT = do_PATCH = do_DELETE = do_HEAD = do_OPTIONS = forward

        return Handler

    running = {}
    while True:
        web = read_state(args.state).get("serve", {}).get("Web", {})
        wanted = {int(k.rsplit(":", 1)[1]) for k in web if k.rsplit(":", 1)[1].isdigit()} & ports
        for port in wanted - running.keys():
            server = http.server.ThreadingHTTPServer(("127.0.0.1", port), handler(port))
            server.daemon_threads = True
            server.socket = tls.wrap_socket(server.socket, server_side=True)
            threading.Thread(target=server.serve_forever, daemon=True).start()
            running[port] = server
            note({"listening": port})
        for port in running.keys() - wanted:
            server = running.pop(port)
            server.shutdown()
            server.server_close()
            note({"stopped": port})
        time.sleep(0.5)


if __name__ == "__main__":
    main()
