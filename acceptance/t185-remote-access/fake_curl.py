#!/usr/bin/env python3
"""A stand-in for Windows' curl.exe (T-185), run as `curl.exe` beside the fake
tailscale.exe, whose state it reads. Loopback URLs are fetched as they are; an
https URL goes through the Serve entry for its host and port, with the Host
header and Tailscale-User-Login of the state's owner, as Serve would send them."""
import json, sys, urllib.request, urllib.error
url = sys.argv[-1]
s = json.load(open(sys.argv[0].replace("curl.exe", "tailscale.exe") + ".json"))
headers = {}
if url.startswith("https://"):
    rest = url[len("https://"):]
    hostport, _, path = rest.partition("/")
    port = hostport.rsplit(":", 1)[1] if ":" in hostport else "443"
    web = s.get("serve", {}).get("Web", {}).get(hostport if ":" in hostport else hostport + ":443")
    if not web or "/" not in web["Handlers"]:
        print("curl: (7) Failed to connect", file=sys.stderr); print("\n000", end=""); sys.exit(7)
    target = web["Handlers"]["/"]["Proxy"]
    headers = {"Host": hostport, "Tailscale-User-Login": s["owner"]}
    url = target + "/" + path
try:
    r = urllib.request.urlopen(urllib.request.Request(url, headers=headers), timeout=10)
    code, body = r.status, r.read().decode()
except urllib.error.HTTPError as e:
    code, body = e.code, e.read().decode()
except Exception as e:
    print("curl: (7) " + str(e), file=sys.stderr); print("\n000", end=""); sys.exit(7)
print(body + "\n" + str(code), end="")
