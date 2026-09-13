# samples/

Local-only fixtures for verifying DOM selectors against real Google Voice
markup. Drop captured conversation pages here (full HTML save of a
`voice.google.com` conversation, plus a screenshot if useful) when checking
whether a selector change still matches the real DOM.

Nothing in this folder is committed — see `.gitignore` — because these
captures are real personal conversations, and this repo is public. Feel free
to overwrite/add files here at any time; there's no need to ask before
replacing what's here.

When referencing content from a file here, use relative paths and grep with
tight, low `head_limit` matches — these captures tend to be minified into a
handful of very long lines rather than one-element-per-line.
