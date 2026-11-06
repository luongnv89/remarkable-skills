# Contributing to remarkable-skills

Thanks for helping. This repo holds two agent skills, `remarkable-setup` and `send-to-remarkable`. Each lives in `skills/<name>/`, and an agent loads its `SKILL.md` when the skill triggers. This guide covers how to set up, change and test them.

## How to contribute

These contributions are all welcome:

- Bug reports that include the output of `probe.sh` or `make_article.mjs --check`
- New input sources
- Support for other tablet models
- Layout fixes
- New eval cases
- Docs improvements

To get started:

- Open an issue using one of the [issue templates](.github/ISSUE_TEMPLATE/).
- For a large change, such as a new source, a new device or a change to the push guards, discuss it in an issue first. GitHub Discussions are turned off.
- Follow the [Code of Conduct](CODE_OF_CONDUCT.md).
- Report vulnerabilities as described in [SECURITY.md](SECURITY.md), not in a public issue.

## Development setup

Requirements:

- macOS. The skills are macOS-only.
- Node.js 20 or later (see `engines` in `skills/send-to-remarkable/scripts/package.json`).
- Google Chrome. Headless Chrome prints the PDFs.
- pandoc, needed only for Markdown inputs.
- Optional: poppler and ImageMagick, for page previews and the contact sheet.
- Optional: shellcheck, to lint `probe.sh`.

Clone the repo and install the script dependencies:

```sh
git clone https://github.com/luongnv89/remarkable-skills.git
cd remarkable-skills
(cd skills/send-to-remarkable/scripts && npm ci)
```

Run `npm ci` inside `scripts/` as shown. npm 11 mishandles `--prefix`.

Link the skills into your agent, here Claude Code, so your edits take effect in the next agent session:

```sh
mkdir -p ~/.claude/skills
ln -s "$PWD/skills/remarkable-setup"   ~/.claude/skills/remarkable-setup
ln -s "$PWD/skills/send-to-remarkable" ~/.claude/skills/send-to-remarkable
```

Most work doesn't need a tablet. The fake tablet (`RM_TABLET_DIR`, see [Testing requirements](#testing-requirements)) covers the whole push path. To test on a real device, first run `/remarkable-setup` on it.

## Branching strategy

- Branch from `main` and name the branch `feat/<topic>`, `fix/<topic>` or `docs/<topic>`.
- Open a pull request into `main`.
- Don't push to `main` directly.

## Commit conventions

Use [Conventional Commits](https://www.conventionalcommits.org/), with the skill as the scope when one applies:

```text
feat(send-to-remarkable): read RSS feeds
fix(remarkable-setup): detect a missing HostKeyAlias
docs: clarify fake tablet markers
```

The types are `feat`, `fix`, `docs`, `test` and `chore`. The first two commits in the history came before this convention.

## Pull request process

1. Fill in the [pull request template](.github/PULL_REQUEST_TEMPLATE.md).
2. Keep to one topic per PR.
3. There is no CI yet. Paste the output of the checks in [Testing requirements](#testing-requirements) into the PR.
4. The maintainer reviews every PR. Expect a review round on `SKILL.md` wording, because agent behavior depends on it.
5. PRs are squash-merged.

## Coding standards

No linter or formatter is configured. Follow the conventions the code already uses.

**Scripts** (`skills/send-to-remarkable/scripts/`)

- ESM `.mjs` files, with no build step.
- Use only `node:` built-ins plus the two pinned dependencies (`@mozilla/readability`, `jsdom`).
- Each script prints exactly one JSON line on stdout. Progress goes to stderr. A failure prints an `Error: …` line and a `Fix: …` line.
- Exit codes are stable and documented. `push_to_remarkable.mjs` uses:

  | Exit | Meaning |
  | --- | --- |
  | 0 | Delivered, skipped as a duplicate, or nothing to do |
  | 1 | Other error (SSH dropped, low space, lock held) |
  | 2 | Bad input |
  | 3 | Tablet unreachable, PDF queued |
  | 4 | reMarkdown open, PDF queued or restart pending |
  | 5 | Restart budget used up, PDF queued |
  | 6 | UI was down, or did not come back or failed the check after the restart |

  The full table is in [`references/tablet.md`](skills/send-to-remarkable/references/tablet.md). `probe.sh` uses 0 for ready, 1 for not ready and 2 for bad arguments.
- Never interpolate untrusted text into a shell command. Article titles come from the web. Call `spawnSync` or `execFileSync` with argument arrays.

**`probe.sh`** (`skills/remarkable-setup/scripts/`)

- It stays read-only. The agent runs it before and after every gated step.
- It must stay clean under `shellcheck -S warning`.

**Skill files**

- Keep `SKILL.md` short and imperative. Move detail into `references/`.
- When `SKILL.md` changes, update the human page `docs/README.md` to match.
- Any behavior change bumps `metadata.version` in that skill's `SKILL.md` frontmatter (patch for a fix, minor for a feature). It also needs an entry in [CHANGELOG.md](CHANGELOG.md).
- Never put secrets, passwords, keys or personal paths in skill files.

**Safety rails**

- Every change to the Mac or the tablet sits behind a gate the user approves.
- The agent never asks for, stores or types the tablet's root password.
- Tests never touch a real tablet.

## Testing requirements

There is no automated test suite or CI yet. Adding them would be a good first contribution. Until then, run the checks below and paste their output into your PR.

**1. Static checks** (from the repo root)

```sh
for f in skills/send-to-remarkable/scripts/*.mjs skills/send-to-remarkable/scripts/lib/*.mjs; do node --check "$f"; done
bash -n skills/remarkable-setup/scripts/probe.sh
shellcheck -S warning skills/remarkable-setup/scripts/probe.sh
```

**2. Environment check**

```sh
node skills/send-to-remarkable/scripts/make_article.mjs --check; echo $?
```

It prints one `√`, `×` or `—` line per tool, then a JSON line. It exits 0 when everything is ready.

**3. Offline smoke test**

This test needs Chrome and pandoc. It uses no network and no tablet. It builds the eval fixture, then pushes it to a fake tablet in a temp folder:

```sh
cd skills/send-to-remarkable/scripts
T=$(mktemp -d)
node make_article.mjs "../evals/files/vault/notes/Reading notes.md" --out "$T/out"
# expect: "ok":true, "pages":3, "images":{"found":2,"saved":2,...}

RM_TABLET_DIR="$T/tablet" RM_STATE_DIR="$T/tablet.state" \
  node push_to_remarkable.mjs "$T"/out/*.pdf; echo $?
# expect: exit 0, "delivered":[{..."verified":true}], "restarted":true

touch "$T/tablet/.fake-offline"
RM_TABLET_DIR="$T/tablet" RM_STATE_DIR="$T/tablet.state" \
  node push_to_remarkable.mjs "$T"/out/*.pdf --force; echo $?
# expect: exit 3, the PDF listed in "queued"

RM_TABLET_DIR="$T/tablet" RM_STATE_DIR="$T/tablet.state" \
  node push_to_remarkable.mjs --status
# expect: "reachable":false and the queued PDF in "queue"

# send later, then sync
node make_article.mjs ../evals/files/field-notes.txt --out "$T/later"
RM_TABLET_DIR="$T/tablet" RM_STATE_DIR="$T/tablet.state" \
  node push_to_remarkable.mjs "$T"/later/*.pdf --queue-only --folder Papers; echo $?
# expect: exit 0, "mode":"queue-only", "contacted":false, "count":2

RM_TABLET_DIR="$T/tablet" RM_STATE_DIR="$T/tablet.state" \
  node push_to_remarkable.mjs --list
# expect: both PDFs in "queue", each with its folder; no new line in "$T/tablet/.fake-probes.log"

rm "$T/tablet/.fake-offline"
echo $(( $(date +%s) - 600 )) > "$T/tablet/.fake-last-start"   # the UI started 10 min ago
RM_TABLET_DIR="$T/tablet" RM_STATE_DIR="$T/tablet.state" \
  node push_to_remarkable.mjs --flush; echo $?
# expect: exit 0, the field notes in "delivered" with "folder":"Papers", the forced copy in "skipped"
# (--force is not kept in the queue), "queued":[], "restarted":true

# a rebuilt PDF with the same title replaces the queued one
cp "$T"/later/*.pdf "$T/rebuilt.pdf"
RM_TABLET_DIR="$T/tablet" RM_STATE_DIR="$T/tablet.state" \
  node push_to_remarkable.mjs "$T"/later/*.pdf --queue-only --folder Notes
RM_TABLET_DIR="$T/tablet" RM_STATE_DIR="$T/tablet.state" \
  node push_to_remarkable.mjs "$T/rebuilt.pdf" --queue-only --folder Notes; echo $?
# expect: exit 0, "count":1, "replaced" set to the first path, a Warning: line on stderr

# a 1.0.1 queue holding the same title twice sends the newest PDF once
Q="$T/tablet.state/queue"; rm -f "$Q"/*.json
TITLE="Field notes on reading in the margins"
printf '{"id":"old","pdf":"%s","title":"%s","folder":"Notes","queuedAt":"2026-01-01T00:00:00.000Z"}' "$(ls "$T"/later/*.pdf)" "$TITLE" > "$Q/old.json"
printf '{"id":"new","pdf":"%s","title":"%s","folder":"Notes","queuedAt":"2026-01-02T00:00:00.000Z"}' "$T/rebuilt.pdf" "$TITLE" > "$Q/new.json"
echo $(( $(date +%s) - 900 )) > "$T/tablet/.fake-last-start"
rm -f "$T/tablet.state/restarts.log"   # the two syncs above used this skill's restart budget
RM_TABLET_DIR="$T/tablet" RM_STATE_DIR="$T/tablet.state" \
  node push_to_remarkable.mjs --flush; echo $?
# expect: exit 0, one item in "delivered" (folder Notes), the older one in "skipped" with "queued twice", "queued":[]
```

The fake tablet reads marker files to simulate tablet states. They're listed in [`references/tablet.md` → Fake tablet](skills/send-to-remarkable/references/tablet.md#fake-tablet-tests-and-evals). If you change the push guards, also test `.fake-remarkdown-open` (exit 4) and `.fake-last-start` (exit 5).

Don't paste machine-specific paths such as `/var/folders/...` into the PR. The `ok`, `pages` and `exit` fields are the evidence.

**4. Evals**

Each skill has an `evals/evals.json` file: `send-to-remarkable` has 13 evals and `remarkable-setup` has 5. Each eval has these fields:

- `id`
- `kind`: `happy-path`, `edge` or `negative-trigger`
- `prompt`
- `expected_output`
- `files`
- `expectations`
- `setup` (optional): shell commands to run before the prompt, for example to queue PDFs for a sync eval

No eval runner is checked in, so run evals by hand:

1. Start a fresh agent session with the skill installed.
2. For `send-to-remarkable`, replace `{SKILL}` with the skill folder and `{TABLET}`, `{OUT}` and `{FIXTURES}` with empty temp folders, as the file's `harness_note` says. Run the eval's `setup` commands, if any, then paste the eval prompt.
3. Check each item in `expectations`.

Keep these in mind:

- `remarkable-setup` evals run in plan mode. The agent may run only the read-only probe, and it must stop at the first gate.
- `send-to-remarkable` eval 1 needs network access (the FxTwitter API).
- Add or update an eval for every new edge case or trigger change.
- Put local eval workspaces in a `*-workspace/` folder, which git ignores.

**5. Real device (optional)**

On a tablet prepared with `remarkable-setup`, first run `node push_to_remarkable.mjs <file.pdf> --dry-run`, then do a real push. Put the tablet model and software version in the PR.

## Releasing (maintainer)

1. Bump `metadata.version` in each changed skill's `SKILL.md`.
2. In [CHANGELOG.md](CHANGELOG.md), move the `[Unreleased]` entries under the new version.
3. Tag the release and create a GitHub release.
