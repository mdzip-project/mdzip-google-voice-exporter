# Agent Instructions

- This repo is a single hand-written userscript
  (`google-voice-chat-exporter.user.js`) with no build step. Keep it that way —
  don't introduce a bundler/transpiler for the script itself.
- The script targets any maintained userscript manager (Violentmonkey,
  Tampermonkey, etc.) via standard `GM_*` grants — don't add Tampermonkey-only
  APIs without a fallback.
- The script `@require`s a prebuilt browser bundle of `@mdzip/core-js` from
  jsDelivr (pinned version in the userscript header) for ZIP writing,
  manifest generation, and archive path validation. Do not re-implement that
  logic locally; if it's insufficient, the fix belongs in `mdzip-core-js`
  (see `../mdzip-core-js`), not here.
- `samples/` is where a captured, real Google Voice conversation page (HTML +
  screenshot) goes locally, to verify DOM selectors without needing live site
  access. Its contents are gitignored — real personal conversations, never
  committed — so the folder is empty in a fresh clone aside from its own
  `.gitignore`/`README.md`. Don't add anything there to the public repo.
- `SPEC.mdz` and `todo.md` are working design notes for this repo specifically
  (not the MDZip format spec — that's `../mdzip-spec`).
- Never modify sibling/upstream repositories from here. Treat them as
  read-only; if a change in `mdzip-core-js` seems warranted, stop and discuss
  it with the user first.
