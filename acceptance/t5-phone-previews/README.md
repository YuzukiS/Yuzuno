# Previews on the phone: browser lab (T-5)

`lab.py` starts a lab Core (its own ports and data folder, never 4317 or a daily Core) with the T-185 stand-ins for Windows' `tailscale.exe` and `curl.exe`. It applies phone access, and the lab Agent writes a Home section with one HTML attachment (`proto.html`, synthetic, written from `lab.py`). `serve_proxy.py` then plays Tailscale Serve's HTTPS side for both Serve ports, with a self-signed certificate for the node's name and the stand-in owner's login.

`browser.mjs` drives Chromium through it. Previews are turned on from Settings. A "phone" window, through the stand-in Serve, opens the attachment, and the checks follow:
- the page runs, framed from the previews' own entry;
- it reaches neither Core nor the phone page (its probes, and the stand-in's request log);
- its proof is answered once;
- another page cannot frame it;
- a copy opened outside keeps working after the Portal closes;
- the computer's own preview is unchanged;
- turned off, the phone says so and the entry is gone.

```sh
python3 acceptance/t5-phone-previews/lab.py --core <yuzuno-workspace> --web <isolated web build> \
  --validator runtimes/result-validator/validator.mjs --out <new dir> [--serve-ports 18444,18445]
```

Run it as a bounded Job on a WSL host, as the feature needs. It writes `report.json` and screenshots in `--out`. Covered: Chromium on the Core host with a stand-in Serve. Not covered: a real Serve or tailnet, Safari, or an iPhone.
