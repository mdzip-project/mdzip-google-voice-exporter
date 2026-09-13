# Scroll/export performance log

Tracks wall-clock performance of the "Scroll to top" tester and full export
across iterations of the same test conversation, so fixes can be compared
against a real before/after baseline instead of going by feel.

Not personal data — just step counts, timings, and pixel heights. Paste the
`scrollConversationToTop` summary dialog stats (steps / time / final height)
after each run, plus a one-line note on what changed in the code since the
last run, and this table gets a new row.

Every run should be tied to the exact `@version` the script was running —
runs 1-5 below all happened while the version stayed frozen at `0.1.0`
despite the code changing under it each time, which made them impossible to
tell apart after the fact. **Bump `@version`/`APP_VERSION` at the top of
`google-voice-chat-exporter.user.js` before each test run from now on** (even
a patch bump, e.g. 0.2.0 -> 0.2.1) so the version column is unambiguous.
Your userscript manager shows the installed version in its dashboard, so it's
easy to confirm which one is actually loaded before you start a run.

## Runs

| # | Date | Version | Code state | Scroll-to-top steps | Scroll-to-top time | Final height (px) | Notes |
|---|------|---------|-----------|---------------------|---------------------|--------------------|-------|
| 1 | 2026-08-03 | 0.1.0 | Before boundary-only-wait fix | ~436 (est., old full-export run) | 2608.8s | — | Baseline from original full export run (pulseScrollUp + fixed 900ms wait), pre-dates this log |
| 2 | 2026-08-03 | 0.1.0 | `jumpScrollToTop` incremental decrement (no more snap-to-0) | — | — | — | Fixed the "worse" oscillation from snap-to-absolute-0; not timed standalone |
| 3 | 2026-08-03 | 0.1.0 | Boundary-only patient wait added | — | — | — | Coasting steps dropped to ~600-650ms each (from full 7-13s+ patient wait every step) |
| 4 | 2026-08-03 | 0.1.0 | `signatureChanged`-only grew signal (fixes heightChanged oscillation/bounce-forever bug) | 712 | 982.5s (~16.4 min) | 1,489,316 | First confirmed clean completion (`done: true`) on the large test conversation |
| 5 | 2026-08-03 | 0.1.0 | Adaptive sweep wait (`waitForRenderSettle`, replaces flat 180ms/step) | — | — | — | Targets the sweep/scan phase specifically; not yet timed standalone |
| 6 | 2026-08-03 | 0.2.0 | Version bumped to mark this checkpoint; no behavior change since #5 | — | — | — | First run to actually carry a distinct version number — pending |

## What to paste after a run

The `@version` shown in your userscript manager's dashboard for this script, plus from
the scroll-to-top summary dialog: outcome, steps, time, final height. If
running a full export, also note total export time and message count from
the success message, plus roughly how long the scanning/sweep phase took if
noticeable.
