# YN-10: a large page attached on Home opens in the Portal

A Home attachment's interactive preview used to be refused above 2 MB, so a
6.6 MB single-file design preview could not open. Core now serves a preview
from its snapshot file in 64 KiB chunks, up to the 25 MB a Home attachment
snapshot can be.

`lab.py` starts a lab Core (its own free port and a new data folder, never
the daily Core), has the lab Agent attach a synthetic page of exactly
6,606,144 bytes to a Home section through its own MCP `brief_update`, and runs
`browser.mjs`. That opens the page from Home in English and in Chinese
(zh-Hans, by the browser's language), 1440 and 390 px wide. Each time, the
page's last script, at the very end of the file, must have run, the preview
Core gave must be the whole page with the attachment's SHA-256, and no
refusal may show. A screenshot is taken of each.

```sh
python3 acceptance/yn10-large-previews/lab.py --core <yuzuno-workspace binary> --web web/dist \
  --validator runtimes/result-validator/validator.mjs --out <new folder>
```

It needs `web/node_modules` (Playwright) and Chromium (`/usr/sbin/chromium`,
or `YUZUNO_BROWSER_BIN`). It writes `<out>/report.json` and the screenshots in
`<out>/browser/`, and exits 0 only when every step passed.

Covered: Chromium on the Core host, through Core's own port. The phone entry's
route is covered by Core's Rust tests (`remote_access::tests`), not here; nor
are Safari or an iPhone.
