# License texts recorded for the Windows desktop app

`tools/desktop_notices.py` reproduces the license texts each crate of the app
ships. Some code in the app or its installer comes with no license text in any
crate. `sources.json` records the texts of its exact source, stored here byte
for byte (`.gitattributes` keeps line endings as they are), each with its
SHA-256 and how it was traced.

- **`linked`: code inside `yuzuno-desktop.exe`.** On MSVC targets,
  `webview2-com-sys` links Microsoft's `WebView2LoaderStatic.lib` from its own
  `x64` folder. Its texts are used only while the crate has the recorded
  version and that file has the recorded SHA-256. If the crate is in the app
  and either differs, the generator refuses, rather than ship the code without
  its texts.
- **`installer`: the installer's own code.** It comes from the folder the Tauri
  CLI bundles with, `%LOCALAPPDATA%\tauri\NSIS`. `scripts/desktop.ps1 -Bundle`
  checks that each file named under `files` has the recorded SHA-256 there,
  before and after it bundles. It also checks that the entry for the installer
  script names the Tauri CLI version it pins.

Nothing is fetched while building.

## How each was traced (read-only, by hand)

- **WebView2 loader:**
  - `src/lib.rs` of `webview2-com-sys` 0.39.1 links `WebView2LoaderStatic` on
    MSVC, and its `build.rs` adds the crate's `x64` folder to the link path.
  - The NuGet package `Microsoft.Web.WebView2` 1.0.3800.47 is the version on
    the `webview2-rs` default branch. It is 8 973 762 bytes, SHA-256
    `56c9f26b…`, from `https://www.nuget.org/api/v2/package/Microsoft.Web.WebView2/1.0.3800.47`.
    Its `build/native/x64/WebView2LoaderStatic.lib` has the same SHA-256 as the
    crate's file.
  - Its nuspec names `LICENSE.txt` as the license file. That file and
    `NOTICE.txt` are stored unchanged.
- **NSIS 3.13:**
  - `tauri-bundler` at `tauri-cli-v2.12.3`
    (`crates/tauri-bundler/src/bundle/windows/nsis/mod.rs`) downloads
    `nsis-3.13.zip` and pins the SHA-1 of its `NSIS.exe`. The folder's
    `NSIS.exe` has that SHA-1.
  - The folder's `COPYING` is stored unchanged.
- **`nsis_tauri_utils` 0.5.3:**
  - The same file pins the plug-in's download URL and SHA-1. The folder's DLL
    has that SHA-1.
  - At the tag `nsis_tauri_utils-v0.5.3` (commit `13d9edd2`), the crate
    declares `MIT or Apache-2.0`. Its `LICENSE_MIT` and `LICENSE_APACHE-2.0`
    are stored unchanged. They also cover the plug-in sources that its
    `build.rs` combines into it, all from that repository.
  - The DLL is that tag's release asset: its GitHub digest is the same
    SHA-256, published 2026-01-26. `cargo build --release` built it for
    `i686-pc-windows-msvc`. It is `#![no_std]`, so Rust's `core` is in it and
    `std` is not.
  - **Its crates.** The manifests at that commit name `windows-sys` `^0.61.2`
    (which needs `windows-link` `^0.2.1`) and `semver` `^1.0`.
    - **The versions are inferred, not recorded.** The commit has no
      `Cargo.lock`, the release run's log has expired (HTTP 410), and the
      stripped DLL names no versions.
    - `sources.json` lists the newest versions crates.io offered in those
      ranges on 2026-01-26: `windows-sys` 0.61.2, `windows-link` 0.2.1,
      `semver` 1.0.27. `semver` 1.0.28 only came out on 2026-04-04.
  - **Their texts are not stored here.** The generator refuses unless each
    listed SHA-256 is among the texts the app's own crates ship.
    - `windows-sys` and `windows-link` are the app's own versions.
    - `semver-1.0.27.crate` matches the crates.io index checksum, and its
      `LICENSE-APACHE` and `LICENSE-MIT` are byte-identical to the app's
      `semver` 1.0.28.
  - **Not recorded:** the toolchain that built the plug-in. The notices point
    to the Rust library notices of the toolchain that built the app.
- **Tauri's installer script:**
  - The Tauri CLI writes it from `tauri-bundler`'s NSIS template. At
    `tauri-cli-v2.12.3`, that is `tauri-bundler` 2.10.3, which declares
    `Apache-2.0 OR MIT`.
  - Its `License-MIT.md` and `License-Apache.md` are stored unchanged.

When the Tauri CLI, NSIS or `webview2-com-sys` changes, trace the new source
the same way and update `sources.json`. Until then the generator or the bundle
step refuses.
