# Changelog

All notable changes to this project are documented in this file.

The format follows [Keep a Changelog 1.1.0](https://keepachangelog.com/en/1.1.0/). Each skill has its own [Semantic Versioning](https://semver.org/) version, set in `metadata.version` in that skill's `SKILL.md`.

## [Unreleased]

### Added

- Open-source project files: `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`, `SECURITY.md`, `CHANGELOG.md`, issue and pull request templates, and `docs/OSS_READINESS_CHECKLIST.md`.

## send-to-remarkable 1.1.0 - 2026-11-06

### Added

- Send later: when the tablet is not at hand ("send it later", "my reMarkable isn't with me"), the skill builds and checks the PDF now and queues it with `--queue-only`, without contacting the tablet. "Sync my reMarkable" delivers the whole queue later, in one UI restart.
- `push_to_remarkable.mjs --list` shows the queue from the Mac, without contacting the tablet.
- The fake tablet logs each connection attempt to `.fake-probes.log`.
- 5 evals for sending later, syncing, a tablet out of reach, the offline queue list, and "read it later" wording (12 in total), plus the `evals/files/field-notes.txt` fixture.

### Changed

- Exit 3 (tablet unreachable) reads as a deferral: wake a nearby tablet, or sync when you are back. "Read it later" still delivers now.
- `--queue-only` reports `count` and `contacted: false`; `delivered[]`, `skipped[]` and the `--dry-run` plan name each item's folder.

### Fixed

- A sync delivers each queued item to the folder it was queued for. It used to put every item in the folder of the current call.
- The same article queued twice, for example rebuilt on another day, is sent once instead of twice.

## send-to-remarkable 1.0.1 - 2026-11-03

### Fixed

- The install command now runs `npm ci` inside `scripts/`, because npm 11 mishandles `--prefix`. This touched `README.md`, `SKILL.md`, `docs/README.md`, the `--check` hint in `make_article.mjs` and `lib/web.mjs` (commit `43d2b79`).

## send-to-remarkable 1.0.0 - 2026-11-03

### Added

- X Articles, posts and threads, read through the FxTwitter API.
- Web articles, read through Mozilla Readability, with headless Chrome as a fallback.
- Local inputs: `.md` (with Obsidian embeds), `.txt` and `.html`, plus PDF pass-through.
- Page sizes for the reMarkable 2 (`rm2`), Paper Pro (`rmpp`) and Paper Pro Move (`move`).
- A journal layout, with links as numbered notes and headings as a PDF outline.
- SSH delivery, with:
  - a queue
  - guards for an open reMarkdown editor and for the restart budget
  - a single UI restart
  - a check after the restart
- `--status`, `--flush`, `--dry-run` and `--queue-only` options.
- A fake-tablet test mode and 7 evals.

(Commit `c6e4426`.)

## remarkable-setup 1.0.0 - 2026-11-03

### Added

- `probe.sh`, a read-only readiness check.
- Gated steps for:
  - the Mac tools
  - the ed25519 key
  - the `remarkable` and `remarkable-wifi` host aliases
  - installing the key over USB (the user types the password)
  - SSH over Wi-Fi
- A Developer Mode warning for the Paper Pro.
- A troubleshooting reference and 5 evals.

(Commit `c6e4426`.)

<!-- Compare links go here once the first repository tag exists; the tag (v0.1.0 or v1.0.0) is chosen at release time. -->
