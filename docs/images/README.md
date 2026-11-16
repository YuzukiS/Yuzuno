# README screenshots

These images show the production Yuzuno web UI with **fictional sample data**. The Projects Fieldnotes, Thesis data and Garden site, their Agents Mori, Ren, Hana and the executor FN-12, their conversations, cards, tasks, Jobs and resource figures are fixtures. The attached sketch is drawn by the capture script in the browser's canvas, and the attached log is a three-line text it writes. No real Workspace, account, model, repository contents, screen captures or private conversations are loaded.

| Image | View |
| --- | --- |
| [home.png](home.png) | Home: a question with a reply and a marked-up sketch attached, a permission waiting for you, and each Project at a glance |
| [project.png](project.png) | A Project's page: its cards in three columns, one refreshing every morning, and a request with a sketch and a log file attached |
| [conversation.png](conversation.png) | An Agent conversation and tool activity |
| [jobs.png](jobs.png) | Running, queued and completed local Jobs |

YN-115 made the current images. `home.png` and `project.png` use the UI of main at `0a181a1` (2026-11-15; core.35 plus later fixes). `conversation.png` and `jobs.png` use main at `5dc0d0c` (2026-11-14): captured again from `0a181a1`, they differed only in the top bar, which no longer names the Workspace, and in the sample clock times. The first images used `79623ac` of the private development repository. Each image is 1600 × 1000 pixels, except `project.png` at 1600 × 1430, so that its cards show below the talk box; all are captured directly in Chromium without compositing, hidden UI errors or injected styling. The character images in them are under the Apache License 2.0 like the rest of the project ([asset notes](../../web/src/assets/README.md)); the font keeps its own license.

## Refresh the images

Build the UI from the revision you want to show, then run the capture script from the repository root:

```sh
npm --prefix web ci
npm --prefix web run build
YUZUNO_UI_DIST="$PWD/web/dist" node web/tools/readme-screenshots.mjs
```

The script uses `playwright-core` from the Web dependencies and defaults to `/usr/sbin/chromium`. Set `YUZUNO_BROWSER_BIN` for another Chromium executable; `YUZUNO_PLAYWRIGHT_MODULE` can point to an existing installed `playwright-core` package. `YUZUNO_UI_DIST` can also point to an isolated production build, and `YUZUNO_SCREENSHOT_OUT` to another folder for the images.

All browser requests are served from the build or explicit API fixtures; requests to other hosts are blocked. The script checks for UI exceptions, unexpected requests and page overflow before capture. Inspect all four images after running it, and update the recorded source revision above. When working inside Yuzuno, run the build and browser through a managed Job.
