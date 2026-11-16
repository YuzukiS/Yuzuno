# Desktop release checklist

The order a release executor follows to publish one desktop release, `desktop-V`, for both platforms at once:
- Windows: the installer and its signature.
- Mac: the update package, its signature and the disk image.

Both are built from the same commit. The scripts' own rules are in [Building and publishing a desktop release](../desktop/README.md#building-and-publishing-a-desktop-release). This page adds the steps between them: the cut, the two candidates, the notes, the one Ask, the signing and the checks after it.

Read this page at the release commit (`git show <SHA>:docs/desktop-release-checklist.md`), not from a checkout left at an older one.

## Who does what

- **The Lead** chooses the release commit `SHA` and the version `V` and names them in the dispatch.
  - `SHA` is main's head, with its push CI passed.
  - `V` is newer than the previous desktop release.
  - From the cut until the Mac candidate's run has started, the Lead puts no pull request into the merge queue. The Mac candidate is built from main's head at the moment its run starts.
- **The release executor** does every step below. On Windows that is a Job on the release machine, with a source copy of `SHA` (`git archive SHA`) or a checkout at it.
- **The user** answers one Ask, opened by the executor itself, and installs the release by hand. Nobody else installs.

The signing key stays on the release machine and goes to the scripts by its path only. Nothing prints, copies or uploads it. The Mac candidate is built without it: CI has no private key.

## Before the first release with Mac files

The first `desktop-V` that carries Mac files waits for the Mac update lab to pass ([Update lab](../desktop/README.md#update-lab), on a Mac). Later releases have no such condition.

The first Mac release is installed by hand once, over the earlier Mac build:
1. Install the Core release that relays `darwin-aarch64` on the Core host first.
2. Quit Yuzuno, download `yuzuno-desktop-darwin-aarch64.dmg` from the release page with a browser, and drag `Yuzuno.app` to Applications, replacing the old one.
3. Open it: macOS refuses an app it has not seen. Choose **Open Anyway** under System Settings, Privacy & Security, and confirm. The saved Core stays.

From then on the Mac app updates itself under **Settings → Updates → Desktop app**. The release notes (step 4) carry these three steps in both languages.

## Steps

### 1. Cut (Lead)

1. Take `SHA` = main's head, after its push CI has passed.
2. Choose `V`, newer than the previous desktop release.
3. Name both in the dispatch. Until step 2's run has started, release nothing from the merge queue.

### 2. Mac candidate

1. Start the run: `gh workflow run desktop-macos.yml --ref main -f version=V`.
2. Confirm that its head is `SHA`, then wait for it with `ci_subscribe`.
3. Download its one artifact into a new folder and check the sums:

   ```sh
   gh run download <run> -n yuzuno-macos-arm64-V-<SHA>-<attempt> -D <W>/.tmp/desktop-V/mac
   (cd <W>/.tmp/desktop-V/mac && shasum -a 256 -c SHA256SUMS)
   ```

4. Check its `build.json`:
   - `sourceCommit` is `SHA`;
   - `app.version` is `V`;
   - `app.architectures` is `["arm64"]`;
   - `app.updatePublicKeyId` is `E8881810BE226D78`, the key ID of `desktop/desktop-update.pub`.

GitHub keeps the artifact 14 days: sign before then, or build the candidate again.

### 3. Windows candidate

Build and check the unsigned installer as for the earlier Windows releases:
- notices and installer contents (`tools/desktop_installer_check.py`);
- version resources, identity, icons and capabilities.

Build it with the committed update key: `-UpdatePublicKeyPath desktop\desktop-update.pub`.

### 4. Notes

Write the notes in Chinese and English, by feature, checked against `SHA`, each at most 16384 bytes (Core shows no more).
- For a release with Mac files, include the first-install steps above.
- Say that Mac in-app updates need a Core that relays `darwin-aarch64`.

### 5. Ask

Open one Ask on Home, as the executor, under the task's own topic. It holds:
- the sha256 of each file, as far as it exists before signing;
- the results of steps 2–3;
- the exact commands of steps 6 and 8.

If the Mac candidate failed, offer **Windows only** as an option.

Only a reply on this Ask authorizes the signing and the publication, once.

### 6. Sign (after the reply; one Windows Job)

Run both commands on the release machine, from the source of `SHA`:

```powershell
.\scripts\desktop.ps1 -Bundle -Version V -SigningKeyPath <key> -UpdatePublicKeyPath desktop\desktop-update.pub
.\scripts\desktop.ps1 -StageMac <the Mac folder of step 2> -Version V -SigningKeyPath <key> -SourceCommit <SHA>
```

`-StageMac` refuses unless:
- the folder's `SHA256SUMS` matches its disk image, update package and `build.json`;
- `build.json` names `V`, `arm64`, `SHA` and the committed key ID;
- a git checkout running the script is at `SHA`.

It copies the update package and the disk image into `desktop-V\` under the names Core relays. Then it signs the update package for `V` with `tauri signer sign -f <key> --app-version V`, without reading the key itself.

The release folder `<target>\release\bundle\desktop-release\desktop-V\` then holds exactly five files:
- `yuzuno-desktop-windows-x86_64-setup.exe` and its `.sig`;
- `yuzuno-desktop-darwin-aarch64.app.tar.gz` and its `.sig`;
- `yuzuno-desktop-darwin-aarch64.dmg`.

With **Windows only**, skip `-StageMac`: the folder holds the first two.

### 7. Check the signed files

- **Windows:** the same checks as for the candidate, and for the signed installer.
- **Mac:**
  - the staged `.app.tar.gz` has the candidate's sha256;
  - both `.sig` files carry key ID `E8881810BE226D78`;
  - the pinned `minisign` verifies each against `desktop/desktop-update.pub`. The `.pub` and `.sig` lines are base64 of minisign's own files; decode them first;
  - each trusted comment ends with `version:V`.

### 8. Publish

Confirm that the tag does not exist yet, then:

```sh
gh release create desktop-V --target <SHA> --latest=false --title "Yuzuno desktop V" --notes-file <notes> <the five files>
```

### 9. Verify

- Download the five files without a sign-in into a new folder. Each sha256 must equal step 7's.
- The release's notes are the final notes.
- GitHub's latest release is still the Core release.

### 10. Hand over

Give the user what to look at on a real machine:
- **Mac, first install:** the steps above. Connected to a Core that relays `darwin-aarch64`, the **Desktop app** part shows `V`, and **Check for desktop update** can be pressed.
- **Mac, the next release:** check, download and install, then the app reopens as the new version on the same Core.
- **Windows:** the in-app update, as for the earlier releases.

Nothing here installs for the user.
