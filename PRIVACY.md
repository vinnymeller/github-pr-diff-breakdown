# Privacy Policy

**PR Diff Breakdown for GitHub**
Last updated: 21 September 2026

## Summary

This extension collects nothing, transmits nothing, and has no server.

## What it accesses

The extension runs only on GitHub pull request pages
(`https://github.com/<owner>/<repo>/pull/<number>`). On such a page it:

1. Reads the page's existing diff summary element, to position its own display.
2. Requests the pull request's own diff
   (`https://github.com/<owner>/<repo>/pull/<number>.diff`), which GitHub
   redirects to `patch-diff.githubusercontent.com`.
3. Requests two optional repository files from the default branch —
   `.gitattributes` and `.github/pr-diff-breakdown.yml` — which GitHub redirects
   to `raw.githubusercontent.com`.

These requests go to GitHub and use the browser's existing GitHub session, which
is how private repositories work without a token. They are the same requests the
browser would make if you opened those URLs yourself.

## What it stores

The only stored data is the user's own configuration: a short YAML document of
file path patterns and labels, typed into the extension's options page. It is
kept in `chrome.storage.sync` so it persists between sessions and across the
user's own signed-in browsers.

The extension also caches parsed diff results in `chrome.storage.local` so that
revisiting a pull request is fast. This cache holds file paths and line counts
from pull requests already opened, never leaves the device, and is capped and
evicted automatically.

## What it does not do

- No data is sent to the developer or any third party. The extension has no
  backend, no analytics, no telemetry, and no error reporting.
- No browsing history, page content, credentials, or personal information is
  collected, stored remotely, or shared.
- No user data is sold or transferred to third parties.
- No user data is used to determine creditworthiness or for lending purposes.
- No remote code is loaded or executed. All code ships inside the extension
  package.

## Source

The extension is open source under the MIT licence. Every network request and
every storage write can be inspected at
<https://github.com/vinnymeller/github-pr-diff-breakdown>.

## Contact

Questions or concerns: open an issue at
<https://github.com/vinnymeller/github-pr-diff-breakdown/issues>.
