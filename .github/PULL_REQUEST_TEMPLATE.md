## Summary

<!-- What changed and why. -->

Closes #

## Skill(s) touched

- [ ] `remarkable-setup`
- [ ] `send-to-remarkable`
- [ ] Repo-level docs or config

Type: fix / feature / docs / evals

## Checklist

- [ ] Ran `node --check` on every `.mjs` file, and `bash -n` plus `shellcheck -S warning` on `probe.sh`
- [ ] Ran `node make_article.mjs --check`
- [ ] Ran the offline smoke test (fixture → fake tablet with `RM_TABLET_DIR` / `RM_STATE_DIR`) and pasted the JSON lines below
- [ ] Ran the affected evals by hand, or added or updated evals for new edge cases
- [ ] No test contacted a real tablet. If I also tested on a device, I gave its model and software version below
- [ ] Bumped `metadata.version` in the changed skill's `SKILL.md` if behavior changed
- [ ] Kept `SKILL.md`, `docs/README.md` and `references/` in sync
- [ ] Added an entry under `[Unreleased]` in `CHANGELOG.md`
- [ ] No secrets, passwords, keys or personal paths
- [ ] PR title follows Conventional Commits (for example `fix(send-to-remarkable): ...`)

## Test output

<!-- Paste the JSON lines and exit codes. Leave out machine-specific paths. -->

```text

```
