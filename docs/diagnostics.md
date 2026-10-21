# When the window can't show the app

If the web UI fails to draw (in a browser, the Windows app or the Mac app),
the window shows **"Yuzuno couldn't show this screen"** instead of a blank
page. Nothing is cleared: conversations, drafts, layouts and settings stay
where they were.

- **Try again** draws the app anew in the same window.
- **Reload** reloads the window, as the browser's reload does.
- **Copy diagnostics** copies a short text to paste into a report. The same
  button is in Settings → Updates → Diagnostics while the app works.

Neither needs developer tools. Where the window can't use the clipboard (no
permission, or an older WebView), the text is shown to select and copy by
hand.

A single Brief section that can't be drawn shows "This section couldn't be
displayed." in its place; the rest of Home keeps working. Such a section is
recorded in the diagnostics too.

## What the diagnostics contain

- **Times:** when the text was made and when the page was loaded.
- **Web UI:** the file name of the page's script bundle, which names the build.
- **Page origin:** shown only when it is a loopback address. Any other host is
  written as `<remote host>`.
- **Core:** Core's version, release and readiness, read from `/api/health`
  within 2 s. If Core can't be reached, the text says so with the time, and
  gives the last successful read with its time.
- **Core memory:** Core's own counts, read from `/api/diagnostics/memory`
  at the same time, within 2 s, only for this text and never stored:
  - the process's resident size, peak, anonymous and file pages, swap and
    threads, as the kernel counts them;
  - glibc malloc's `arena`, `uordblks`, `fordblks` and `hblkhd`, as the
    allocator counts them. Its free space need not be resident;
  - how many records Core holds in memory, and requests in flight;
  - the idle trim: whether its tick runs, what it waits for, by Core's own
    names only, and its last check.

  The parts are read one after another, not as one snapshot. A count Core
  can't read on its platform is written `not available`, never 0. If Core
  doesn't answer, or predates this, the line says `unknown` with the reason.
- **Desktop app:** its version, from the update status the desktop app
  already reports; no new desktop command is needed. If it doesn't answer,
  the text says `unknown`.
- **WebView:** always `unknown`, because the desktop app does not report it.
- **Page environment:** the page's browser engine (major version) and
  operating system, as the page reads them. This is never the full user-agent
  text, and it is not a version reported by the desktop app.
- **Recent errors on this device:** at most 12, newest first. The same error
  again only increases its count. Each gives:
  - its kind: the whole app, one section, an uncaught error or a rejection;
  - its name, if it is one of the language's, the browser's or Yuzuno's own
    (such as `TypeError` or `HttpError`); any other name is written `Error`,
    and a thrown value that isn't an error is named by its type, such as
    `string`;
  - its codes, if Yuzuno defines them: a schema's issue codes, Yuzuno's own
    error codes and an HTTP status. Any other code is written `other code`. Of
    the keys a schema names, only Yuzuno's own are given; the others are
    counted;
  - for common failures, a fixed summary such as `read a property of null`
    or `a request did not reach the server`. It is chosen by the message, but
    none of the message is kept. Any other message is written
    `other message, not kept`;
  - up to four positions in Yuzuno's own script bundle, by file, line and
    column. Frames from anywhere else are only counted.

The record of errors is kept in this window's browser storage, under at most
8 KB. A record written by an earlier version is shown, and stored again, by
the same rules; nothing else in the window's storage is touched.

## What they never contain

Conversations, drafts, requests and their responses, model output,
credentials, file paths and the workspace ID are never part of the text.

No text an error carries is kept: not its message, a rejection's reason, a
name or code outside the lists above, or a key a schema names other than
Yuzuno's own. Whatever it held, from your input, your files or a server's
response, can't reach the record that way.

Nothing is uploaded or sent anywhere. The text stays on the device until you
paste it somewhere.
