---
name: Bug report
about: Something in remarkable-setup or send-to-remarkable did not work as expected
title: "[bug] "
labels: bug
---

> **Do not paste secrets.** Never include the tablet's root password, a private key (such as `~/.ssh/id_ed25519_remarkable`), or `~/.ssh/config` lines you consider private.
> To report a security problem, follow [SECURITY.md](https://github.com/luongnv89/remarkable-skills/blob/main/SECURITY.md) instead of opening a public issue.

## Skill

- Skill: `remarkable-setup` / `send-to-remarkable`
- Skill version (`metadata.version` in its `SKILL.md`):
- Agent and version (for example Claude Code 2.x):

## Environment

- macOS version:
- `node --version`:
- Google Chrome version:
- Tablet model (reMarkable 1, reMarkable 2, Paper Pro, Paper Pro Move):
- Tablet software version (Settings → General → About):
- xovi or reMarkdown installed? (yes / no)

## Input

- Input type: X link / web URL / `.md` / `.txt` / `.html` / `.pdf`
- URL (if public):
- Flags used (`--device`, `--render`, `--no-notes`, ...):

## What happened

**What you asked the agent:**

**What you expected:**

**What happened instead:**

## Evidence

<!-- Paste what applies. Remove personal paths you don't want to share. -->

- Output of `node make_article.mjs --check`:
- For setup issues, the output of `bash probe.sh` (the check lines and the JSON line):
- The JSON line from the failing script, and its exit code (`; echo $?`):
- The `Error:` and `Fix:` lines:
- For layout bugs, a screenshot of the page or the contact-sheet image:

## Reproducible with the fake tablet?

Can you reproduce it with `RM_TABLET_DIR` (see CONTRIBUTING.md → Testing requirements)? yes / no / not tried
