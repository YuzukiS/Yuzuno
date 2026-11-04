# Previews on the phone: browser lab (T-5)

`lab.py` starts a lab Core (its own ports and data folder, never 4317 or a daily Core) with the T-185 stand-ins for Windows' `tailscale.exe` and `curl.exe`. Before it starts, the data folder holds what an older Core's phone previews left: their record (on, with a Serve entry of their own on the second Serve port) and that entry in the stand-in Serve. It applies phone access with no previews choice, as an older page would, and the lab Agent writes a Home section with one HTML attachment (`proto.html`, synthetic, written from `lab.py`). `serve_proxy.py` then plays Tailscale Serve's HTTPS side with a self-signed certificate for the node's name and the stand-in owner's login, and logs who sent each request.

Checked from `lab.py`: starting changes nothing in Serve and never listens for the older previews; their choice holds; that first Save and apply removes their entry alone (nothing reset) and keeps their record with only that entry forgotten; through the stand-in Serve, Yuzuno's page and API refuse framing, and the reserved path refuses anything but a live snapshot however it is written, never with Yuzuno's page; the page's probes reached nothing; the browser's own proof requests came by POST from the phone page's origin, same-origin, with the client header.

`browser.mjs` drives Chromium. Settings leaves previews out (the phone frames nothing and says where to include them; Serve unchanged) and includes them again. A "phone" window, through the stand-in Serve, opens the attachment on the phone entry's own address, and the checks follow:
- the page runs in the Portal; it reaches no storage, cookie, Core, this page, worker or service worker, opens nothing, its form goes nowhere, and its own meta policy and base widen nothing;
- its proof is asked by POST, answered once, never by GET;
- it carries its own policy and no `X-Frame-Options`; Yuzuno's page and API keep `DENY`; another page frames neither;
- opened outside, and by its address, it runs with the same limits, and stays after the Portal closes;
- through the phone entry the choice only shows; the computer's own preview is unchanged;
- left out, what the phone has open stops opening; included again, it stays gone.

```sh
python3 acceptance/t5-phone-previews/lab.py --core <yuzuno-workspace> --web <isolated web build> \
  --validator runtimes/result-validator/validator.mjs --out <new dir> [--serve-ports 18444,18445]
```

Run it as a bounded Job on a WSL host, as the feature needs. It writes `report.json` and screenshots in `--out`. Covered: Chromium on the Core host with a stand-in Serve. Not covered: a real Serve or tailnet, Safari, an iPhone or a Home Screen app.
