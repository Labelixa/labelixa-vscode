# Labelixa ZPL for VS Code

See the Zebra **ZPL** label you are editing — rendered, without a printer —
and get the label linted in the Problems panel while you work.

## Install

```
ext install labelixa.labelixa-zpl
```

Or from the command line:

```
code --install-extension labelixa.labelixa-zpl
```

## What it does

**Preview the label under your cursor.** Put the caret anywhere inside a
`^XA … ^XZ` block and run **Labelixa: Preview the label under the cursor**.
The block is rendered by the [Labelixa](https://labelixa.com) API and shown
beside your code.

If the cursor is *between* labels, nothing is rendered and the extension
says so. Showing the nearest label instead would let you edit one label
while looking at another — a quiet way to ship the wrong thing.

**Lint while you type.** 700 ms after you stop typing — and on save — the
file is checked and the findings land in the Problems panel with their real
line and column: unknown commands, unterminated fields, out-of-range
parameters, RFID notes, and more. Each finding code is a link to its rule
page (`labelixa.com/zpl/rules/<code>`): what it means, why it matters and a
label that shows the fix. The delay is not cosmetic: a request per
keystroke would exceed the rate limit and answer your typing with errors.

**Fix it from the marker.** Where the API returns a fix, the finding offers
it as a quick-fix (Ctrl+. / Cmd+.) — a missing `^FS`, a parameter put back
in range. Only fixes that carry a readable title are offered; you are never
asked to accept a change you cannot read.

**Hover a command to see what it does.** Hovering `^FO`, `^BY`, `~JC` and
the rest shows the command's name, format and parameters, from the same
dictionary the [command reference](https://labelixa.com/zpl-commands) is
built from. A command the preview engine does not render says so — better
to read it here than to discover it on a blank label.

## Quota, plainly

- **Linting does not consume label quota.** It only shares the rate limit.
  That is why it can run on every save.
- **Rendering a preview does consume quota** — so it is *never* automatic.
  It happens only when you run the preview command.

Quick-fixes and hover help do not consume quota either: both are served
from data the extension already has or from a free endpoint.

Anonymous use is free and rate limited. To use your own quota, run
**Labelixa: Set the API key** and paste your key (`lbx_…` from
[labelixa.com/panel](https://labelixa.com/panel)).

**The key is stored as a secret, not in a settings file.** Until 0.1.3 it
was an ordinary setting, which meant it could end up in a workspace's
`.vscode/settings.json` and be committed, or be carried to other machines
by Settings Sync. A key already in settings is moved into the secret store
the first time 0.1.4 runs, and the setting is then cleared.

## Settings

| Setting | Default | Meaning |
|---|---|---|
| `labelixa.apiKey` | *empty* | **Deprecated.** Use **Labelixa: Set the API key**; a value left here is moved into the secret store once and then cleared. |
| `labelixa.baseUrl` | `https://api.labelixa.com` | Change only for a self-hosted Labelixa. |
| `labelixa.dpmm` | `8` | Printer resolution (8 dpmm = 203 dpi). |
| `labelixa.widthIn` / `labelixa.heightIn` | `4` / `6` | Label size in inches. |
| `labelixa.lintOnSave` | `true` | Lint on save. |
| `labelixa.lintWhileTyping` | `true` | Lint 700 ms after you stop typing. |

## What it does not do

- **It does not print.** It renders what a printer *would* produce, from
  our own ZPL engine — a simulation, not a device.
- **It is not a substitute for a test print.** Fonts, media calibration and
  darkness live in the printer; the preview cannot see them.
- **The caret character is fixed to `^`.** `^CC` (change caret) is not
  handled — the Labelixa engine does not handle it either, so the preview
  is exactly as capable as the renderer behind it, no more.
- **It sends nothing from an untrusted workspace.** A folder you opened
  only to read is not shipped to a network service; trust it first.
- **It has no AI rewriting of your ZPL.** Quick-fixes come from the rules
  that found the problem, so they are the same every time.

## Privacy

Your ZPL is sent to the Labelixa API to be rendered and checked. The
diagnostics endpoint is stateless: the label is not written to disk and not
logged, and the response carries positions and codes rather than your label
text. See [labelixa.com/security](https://labelixa.com/security).

The extension collects **no telemetry**: nothing about your editing, your
files or your usage is sent anywhere except the label text you ask it to
render or check. Your API key is kept in the editor's secret store and is
never written to a settings file, a log or a request URL.

## Support

Bug reports and questions: support@labelixa.com (API reference:
[labelixa.com/docs/api](https://labelixa.com/docs/api)).
Labelixa on GitHub: [github.com/Labelixa](https://github.com/Labelixa)
(examples, cheatsheets and the `labelixa-mcp` package source).

MIT licensed.
