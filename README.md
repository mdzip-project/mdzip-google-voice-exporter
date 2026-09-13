# Google Voice Chat Exporter

A userscript that saves the [Google Voice](https://voice.google.com)
conversation you have open — every message, with sender names, timestamps,
and photos — as a single file you can archive, search, print, or hand to
someone else.

Google Voice doesn't offer a way to save a conversation as anything other
than screenshots. This script auto-scrolls the thread to load its full
history, reads the rendered messages and attachments out of the page, and
packages them into one file that stays readable long after Google Voice
does whatever it's going to do to that number.

The result is one `.mdz` file — a ZIP archive with a different extension
(rename it to `.zip` and it opens anywhere). It also serves as a working
demo of [MDZip](https://mdzip.org): a single file that holds Markdown text
*and* the images it references, instead of a folder of loose attachments
you have to keep track of separately.

## Use it

1. Install a userscript manager — [Violentmonkey](https://violentmonkey.github.io/),
   [Tampermonkey](https://www.tampermonkey.net/), or another maintained one.
2. Install this script:
   [google-voice-chat-exporter.user.js](google-voice-chat-exporter.user.js)
   (your userscript manager will prompt to install it when you open the raw file).
3. Open a conversation at [voice.google.com](https://voice.google.com) and
   click the **export icon** in the conversation header (or run it from your
   userscript manager's menu).
4. Wait for it to finish scrolling and downloading — for long threads this
   can take a while, since it has to load the whole history first.

You'll end up with a `gv-export-<date>.mdz` file.

## Open the result

An `.mdz` file is just a ZIP archive with a defined internal layout — see
[the full list of MDZip-compatible tools](https://mdzip.org/tools.html) for
viewers, editors, and the CLI. Or skip tooling entirely:

- Rename `gv-export-<date>.mdz` to `.zip` and extract it with any archive
  utility.
- Open `index.md` in any Markdown-aware editor — the exported images are
  referenced with paths relative to the archive, so they render as long as
  the folder stays together.

Once it's open in a Markdown viewer, printing to PDF or selecting all and
pasting into Word both just work, because underneath it's plain text and
images — no proprietary format to fight with.

## What's inside the archive

```text
gv-export-2026-08-01.mdz
├── index.md          # the conversation, one heading per day
├── manifest.json     # title, export time, entry point
├── README.md         # what this file is (mdzip.org boilerplate)
├── AGENTS.md         # guidance for AI agents reading the archive
├── diagnostics.json  # scroll/collection counters, for troubleshooting
└── images/
    └── 2026-08-01t17-43-00.000-07-00-image-01.jpg
```

## Scope and limitations

- Exports the conversation you currently have open — no batch export across
  every thread (yet).
- Only works while the tab is open and scrolling; very long threads take
  longer because it has to load history first.
- Google Voice's DOM isn't a public API. This script reads visible/rendered
  structure and accessibility labels, which is inherently a little fragile —
  if Google changes the page layout, extraction may need updating. Export
  warnings are written into the archive when something couldn't be read.
- No redaction — the export contains whatever was visible in the
  conversation, verbatim.

## How it's built

The script itself has no build step — it's one file, install it as-is. ZIP
writing, path safety, and manifest generation are handled by a prebuilt
browser bundle of [`@mdzip/core-js`](https://github.com/mdzip-project/mdzip-core-js),
loaded via the userscript `@require` directive. Everything Google-Voice-specific
(scrolling, DOM scraping, Markdown formatting) lives in this repo.

## License

Apache-2.0 — see [LICENSE](LICENSE).
