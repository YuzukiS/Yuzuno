# License texts traced to a runtime package's source

`tools/runtime_notices.py` reproduces the license texts each Claude runtime
package ships. A package that ships none is listed without a text, unless
`sources.json` here records the license text of its exact source. That text
is then reproduced and marked as not shipped in the package.

An entry is used only when all of these hold:
- the installed package has the entry's name and version;
- the lock file's `integrity` for it equals the entry's;
- the package itself ships no license text;
- the file here matches `textSha256`.

Otherwise the package stays without a text, and the generator's summary says
why (`recordedSourceNotUsed`). Nothing is fetched while building.

## Tracing a package (read-only, by hand)

For `standardwebhooks` 1.1.1, as recorded:

1. `npm view standardwebhooks@1.1.1 --json`: the declared `license` (MIT), the
   `gitHead`, and the trusted publisher.
2. `https://registry.npmjs.org/-/npm/v1/attestations/standardwebhooks@1.1.1`:
   the SLSA provenance. Its subject sha512 equals the lock file's integrity. It
   names the repository, the commit `b4d2c14fc5b4ccff3ff271e3b087dff812254c59`
   and the workflow `.github/workflows/javascript-release.yml`, which publishes
   from `libraries/javascript`.
3. The repository's tree at that commit
   (`gh api repos/standard-webhooks/standard-webhooks/git/trees/<commit>?recursive=1`)
   has three license files:
   - `LICENSE`: Apache-2.0;
   - `libraries/LICENSE`: MIT, Svix;
   - `libraries/python/LICENSE`.

   `libraries/javascript` has none. Its nearest license file,
   `libraries/LICENSE`, matches the declared MIT, so its bytes are stored
   here; `git hash-object` gives the recorded `gitBlob`.

If a source cannot be tied to the exact version this way, record nothing: the
package stays listed without a text.
