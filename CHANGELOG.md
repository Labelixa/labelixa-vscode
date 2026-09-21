# Changelog

All notable changes to the Labelixa ZPL extension are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
and the project uses [Semantic Versioning](https://semver.org/).

## [0.1.4] - 2026-09-18

### Security
- The API key is kept in the editor's secret store instead of a settings
  file. Until 0.1.3 it was an ordinary setting, which meant it could be
  written into a workspace's `.vscode/settings.json` and committed, or
  carried to other machines by Settings Sync. A key already present in
  settings is moved into the secret store once and the setting is then
  cleared; `labelixa.apiKey` is deprecated and machine-scoped.
- Nothing is sent to the API from an untrusted workspace. A file opened
  only to read it is not shipped to a network service.

### Added
- Quick-fixes for lint findings, from the fix the API already returns.
- Hover help for ZPL commands, from the same command dictionary the
  website's reference pages are built from. Commands the preview engine
  does not render say so.
- `labelixa.lintWhileTyping` (default on): lint 700 ms after you stop
  typing. Linting does not consume label quota. The delay is not cosmetic
  — a request per keystroke would exceed the anonymous rate limit.
- Command **Labelixa: Set the API key**, which stores the key as a secret.

## [0.1.3] - 2026-09-13

### Changed
- Internal identifiers, file names and comments translated to English;
  no change to commands, settings or behaviour.

### Added
- Publish guard (`vscode:prepublish`): packaging fails when a shipped
  file contains internal ticket ids, non-English text or unreleased
  markers.

## [0.1.2] - 2026-09-10

### Fixed
- The MIT license text now ships with the extension (the Marketplace
  displays the `LICENSE` file). No change to behaviour, commands or
  settings.

## [0.1.1] - 2026-08-31

### Changed
- Metadata only: `repository.url` points at the current repository.

## [0.1.0] - 2026-08-27

### Added
- First release.
- Preview the `^XA … ^XZ` label under the cursor, rendered by the
  Labelixa API.
- Lint on save; findings land in the Problems panel with real
  line/column.
- Anonymous free tier, or your own key via `labelixa.apiKey`.
