# Changelog

## 0.2.4

- **Updates come from wherever you installed the script.** The script no
  longer names GitHub as its update source, so a copy installed from Greasy
  Fork updates from Greasy Fork, and one installed from GitHub or mdzip.org
  keeps updating from GitHub.

## 0.2.3

- **Exporting one year or a date range now works as chosen.** The year and
  date boxes used to stay greyed out until you clicked their option, so an
  export could silently cover the whole conversation instead. Clicking or
  typing in a box now selects its option.
- **Year and date-range exports are much faster.** The scan now jumps
  straight to the start of the range instead of reading through every
  earlier year, and its progress message shows the month it's on.
- **Your own messages are right-aligned** in MDZip Studio, the browser
  editor and other Markdown viewers, like they are in Google Voice.
- **Letter avatars** (for contacts without a photo) are saved as round PNG
  images, so they show up in more viewers, including the Windows File
  Explorer preview.
- The script now links to its page on [mdzip.org](https://mdzip.org/google-voice)
  and to GitHub issues for support, and only asks to download from Google's
  own image servers.

## 0.2.2

- Uses `@mdzip/core-js` 2.0.1.
- The export dialog shows the script's version.

## 0.2.1

- First public release.
