# reMarkable skills

Agent skills (for Claude Code and other agents that read `SKILL.md` skills) that turn what you want to read into documents on a reMarkable tablet.

| Skill | What it does |
| --- | --- |
| [`remarkable-setup`](skills/remarkable-setup/SKILL.md) | Walks you step by step from a stock tablet to one your Mac reaches over SSH (USB and Wi-Fi), with a read-only readiness probe. Run it once. |
| [`send-to-remarkable`](skills/send-to-remarkable/SKILL.md) | Turns an X article or post, a blog post, or a local `.md` / `.txt` / `.html` file into a journal-style PDF sized exactly to the tablet screen, and drops it into an `Articles` folder on the tablet. |

## What you get

- **X Articles in full**, with images and embedded posts, through the public [FxTwitter](https://github.com/FxEmbed/FxEmbed) API (no X login).
- **Blog posts** extracted with Mozilla Readability, with headless Chrome as a fallback for JavaScript-heavy pages.
- **Local notes**, including Obsidian `![[image]]` embeds.
- **A reader layout** made for e-ink: the exact panel size (reMarkable 2 by default; Paper Pro and Paper Pro Move as options), serif type, every image kept, links turned into numbered notes, and headings as a PDF outline.
- **Safe delivery over SSH**: one UI restart per batch; never while the reMarkdown editor is open; within the tablet's own restart limit; queued while the tablet sleeps; checked after the restart.

## Requirements

- macOS with [Homebrew](https://brew.sh), Node.js 20+, Google Chrome. pandoc is needed for Markdown notes. poppler and ImageMagick are optional (all-page previews).
- A reMarkable 1 or 2, or a Paper Pro / Paper Pro Move with Developer Mode on. **Enabling Developer Mode factory-resets the tablet**, so back up first.
- Tested on a reMarkable 2 running software 3.28.

## Install

```sh
git clone https://github.com/luongnv89/remarkable-skills.git
cd remarkable-skills
mkdir -p ~/.claude/skills
ln -s "$PWD/skills/remarkable-setup"   ~/.claude/skills/remarkable-setup
ln -s "$PWD/skills/send-to-remarkable" ~/.claude/skills/send-to-remarkable
npm ci --prefix skills/send-to-remarkable/scripts
```

Other agents: copy or link the `skills/<name>` folders into the agent's skills directory.

## Use

1. Run `/remarkable-setup` once (or ask "set up my reMarkable so I can send articles to it").
2. Send things: "send this to my reMarkable: https://x.com/user/status/123", "put this blog post on my tablet", "make ~/notes/today.md readable on my reMarkable".
3. If the tablet was asleep, the PDF waits in a queue: wake the tablet and say "flush the reMarkable queue".

## How delivery works

The tablet's UI (`xochitl`) only reads its library at start. The push script writes the PDF and its metadata files into `/home/root/.local/share/remarkable/xochitl/`, then restarts the UI once. Before restarting, it checks that:

- the reMarkdown editor is not open (a restart would lose its unsaved text);
- the UI has not been restarted too often (xochitl allows 4 starts in 10 minutes before the tablet's failure handler can reboot it).

See [`skills/send-to-remarkable/references/tablet.md`](skills/send-to-remarkable/references/tablet.md) for the protocol, exit codes and troubleshooting.

## Disclaimer

Not affiliated with reMarkable AS. Writing to the tablet over SSH is unsupported by reMarkable; you use these skills at your own risk. Respect the terms of the sites you read; the skills do not bypass paywalls or logins.

## License

MIT, see [LICENSE](LICENSE).
