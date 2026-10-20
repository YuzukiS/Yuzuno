# README screenshots

These images show the production Yuzuno web UI with **fictional sample data**. Fieldnotes, Mori, Hana, their conversations, tasks, Jobs and resource figures are fixtures. No real Workspace, account, model, repository contents or private conversations are loaded.

| Image | View |
| --- | --- |
| [home.png](home.png) | Home, project briefs and a decision needing a reply |
| [conversation.png](conversation.png) | An Agent conversation and tool activity |
| [jobs.png](jobs.png) | Running, queued and completed local Jobs |

The initial capture uses the UI from `79623ac`, the merged UI refinement batch in the private development repository. Each image is 1600 × 1000 pixels, captured directly in Chromium without compositing, hidden UI errors or injected styling. The character images in them are under the Apache License 2.0 like the rest of the project ([asset notes](../../web/src/assets/README.md)); the font keeps its own license.

## Refresh the images

Build the UI from the revision you want to show, then run the capture script from the repository root:

```sh
npm --prefix web ci
npm --prefix web run build
YUZUNO_UI_DIST="$PWD/web/dist" node web/tools/readme-screenshots.mjs
```

The script uses `playwright-core` from the Web dependencies and defaults to `/usr/sbin/chromium`. Set `YUZUNO_BROWSER_BIN` for another Chromium executable; `YUZUNO_PLAYWRIGHT_MODULE` can point to an existing installed `playwright-core` package. `YUZUNO_UI_DIST` can also point to an isolated production build.

All browser requests are served from the build or explicit API fixtures; requests to other hosts are blocked. The script checks for UI exceptions, unexpected requests and page overflow before capture. Inspect all three images after running it, and update the recorded source revision above. When working inside Yuzuno, run the build and browser through a managed Job.
