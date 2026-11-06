# Tablet — push protocol, guards, queue, syncing later, troubleshooting

Read this for a failed push, a question about how delivery or the queue works, or removing a pushed document. Code: `scripts/push_to_remarkable.mjs`.

## Facts verified on a reMarkable 2 (OS 3.28, xovi + AppLoad + reMarkdown installed, 2026-11-03)

- Library: `/home/root/.local/share/remarkable/xochitl/`. A PDF document is `<uuid>.pdf`, `<uuid>.pagedata` (`Blank\n` per page), `<uuid>.content` and `<uuid>.metadata`. xochitl adds `<uuid>.local` and thumbnails itself.
- A folder is `<uuid>.metadata` with `"type": "CollectionType"` plus `<uuid>.content` holding `{}`. Top-level items have `"parent": ""`. Trashed items have `"parent": "trash"`.
- xochitl reads the library only at start, so a new document appears after a UI restart (`systemctl restart xochitl`, about 10 s).
- **xovi survives the restart.** `/home/root/xovi/start` mounts a tmpfs on `/etc/systemd/system/xochitl.service.d/` and writes `00-xovi.conf` (`LD_PRELOAD=/home/root/xovi/xovi.so`). The drop-in lasts until reboot, so a restart reloads xovi, AppLoad and reMarkdown. Verified after a live push: xovi was in the new xochitl process's memory maps.
- **Start limit:** `xochitl.service` has `StartLimitIntervalSec=600`, `StartLimitBurst=4` and `OnFailure=remarkable-fail.service`. A fifth start within 10 minutes fails the unit, and `remarkable-fail.sh` can reboot the tablet, which also unloads xovi until the user triple-presses the power button.
- **reMarkdown** runs, while open, as a child of xochitl with the command line `backend/entry /tmp/reMarkdown.sock` and the executable `/home/root/xovi/exthome/appload/rmd/backend/entry`. The command line has no `rmd/` prefix, so `pgrep -f 'rmd/backend/entr[y]'` never matches. The guard checks for `reMarkdown.sock` in the command line or that executable path; both were verified with the editor open and closed.
- SSH: aliases `remarkable-wifi` (`remarkable.local`) and `remarkable` (USB, `10.11.99.1`), root, key `~/.ssh/id_ed25519_remarkable`. A sleeping tablet drops Wi-Fi, so it is unreachable until woken.

## Push protocol

1. **Queue** the PDF (`<state>/queue/<id>.json`, holding the PDF path, title and folder). One item per document and folder: queuing the same PDF again changes nothing, and a rebuilt PDF with the same title replaces the older path and moves to the end of the queue. The replacement prints a `Warning:` line on stderr, and `--queue-only` returns the older path in `replaced`. X posts take their title from the first 90 characters, so two different posts can collide: tell the user when `replaced` is set.
2. **Connect:** try each host in `--hosts` / `RM_HOSTS` (default `remarkable-wifi,remarkable`), 6 s timeout each. None answers → exit 3.
3. **Guards** (skipped with `--no-restart`):
   - reMarkdown open → exit 4. It saves its whole buffer on Esc, and a restart would kill it with unsaved text.
   - The UI started less than 90 s ago, or this skill restarted it twice in the last 10 min → exit 5, with the time to retry.
   - xochitl not active → exit 6. Restarting a UI that is already down is not safe.
   - Less free space than the PDFs plus 2 MB → exit 1.
4. **Read the library** (all `*.metadata`). For each queued item, find the top-level folder it was queued for by name (not trashed), or create it. A sync never moves an item to the `--folder` of a later call.
5. **Duplicates:** a live document with the same title in that folder → skipped (exit 0, `skipped[]`). `--force` uploads a second copy. The same title queued twice for one folder (a queue written by 1.0.1) is sent once: the newest PDF goes, the other is skipped as `queued twice`.
6. **Upload:** each file is written as `<name>.part`, then renamed (`mv`) when complete. Metadata goes last, so xochitl never sees half a document.
7. **Re-check the guards**, then **one UI restart** for the whole queue. Uploads take time and the user may open reMarkdown meanwhile: if the re-check fails, the restart is skipped, the uploaded documents are recorded in `<state>/pending-restart.json`, and the run exits 4 (or 5). The next `--flush` restarts once and shows them. After the restart, check that xochitl is active and whether xovi is still loaded.
8. **Verify:** re-read each new `.metadata` after the restart (same title, same parent, not trashed), then remove the item from the queue.

`--queue-only` takes no lock, so it works while a sync runs. Queue files are written whole (temp file, then rename). A sync removes an item only if its PDF path is unchanged: when `--queue-only` replaced it mid-sync, the item stays queued with a `Warning:` line, and the next sync skips it if that title is already in the folder (`--force` sends the newer copy).

`.metadata` and `.content` copy the field set that OS 3.28 itself writes for an imported PDF (`formatVersion: 1`, one page id per page, `zoomMode: bestFit`).

## Send later and sync

The queue lives on the Mac, so documents can wait for days while the tablet is away.

1. **Send later:** `push_to_remarkable.mjs <pdf> --queue-only` adds the PDF to the queue and exits 0 with `mode: queue-only`, `count` and `contacted: false`. It never connects, so it takes no SSH timeout and never restarts the UI.
2. **While away:** `--list` prints the queue (`id`, title, folder, `queuedAt`, `pdf`, `pdfExists`) and any pending restart, from the Mac alone. `--status` connects first, so it waits for the SSH timeouts.
3. **Sync:** `--flush` delivers every queued item to its own folder, then restarts the UI once. Any push of a new PDF that reaches the tablet delivers the queue with it. A sync while the tablet is still away exits 3 and keeps the queue.
4. A queued PDF must still exist at sync time. If it was deleted from the library, the sync drops the item with a warning; `--list` shows it beforehand as `pdfExists: false`.

## Exit codes

| Exit | Meaning | Queue |
| --- | --- | --- |
| 0 | Delivered, skipped as a duplicate, queued by `--queue-only`, or nothing to do | Emptied for delivered/skipped items; `--queue-only` adds one |
| 2 | Bad input (missing or non-PDF file, bad option) | Unchanged |
| 3 | Tablet unreachable (asleep, out of range, or not with the user) | Item kept |
| 4 | reMarkdown open (item kept), or opened mid-push (item uploaded, restart pending) | Kept, or moved to `pending-restart.json` |
| 5 | Restart budget used up | Item kept |
| 6 | The UI was down before the upload, or it did not come back / the check failed after it | Kept if nothing was uploaded; removed once uploaded (it is on the tablet) |
| 1 | Other error (SSH dropped mid-upload, low space, lock held) | Item kept; partial `.part` files removed |

## Options and state

- `--status` (read-only, but it does connect): reachability, guard values, queue, pending restart, restarts in the last 10 min.
- `--list` (read-only, never connects): the queue and any pending restart. `--list` and `--status` take no PDF (exit 2).
- `--flush`: sync the queue. `--queue-only`: add to the queue without connecting (send later, or batches).
- `--dry-run`: connect and plan without writing anything, the queue included. The plan names each item's folder and any folder it would create (`newFolders`).
- `--no-restart`: upload only; documents appear after the next restart or reboot.
- `--folder <name>` / `RM_FOLDER`: top-level folder for the PDF given in this call (default `Articles`, no slashes). Queued items keep the folder they were queued with.
- Titles come from the PDF's own Title field (Chrome copies the article title); `--title` overrides it.
- State: `~/Library/Application Support/send-to-remarkable/` (`queue/`, `pending-restart.json`, `restarts.log`, `push.lock`), or `RM_STATE_DIR`.

## Fake tablet (tests and evals)

`RM_TABLET_DIR=<folder>` makes the script use that folder as the library: no SSH, restart simulated. The state then defaults to `<folder>.state` unless `RM_STATE_DIR` is set. Marker files in the folder simulate tablet states:

| File | Simulates |
| --- | --- |
| `.fake-offline` | Tablet asleep → exit 3 |
| `.fake-remarkdown-open` | reMarkdown open → exit 4 |
| `.fake-remarkdown-opens-later` | reMarkdown opened mid-push → upload, restart skipped, exit 4 |
| `.fake-last-start` (epoch seconds) | When the UI last started (the restart guard reads it) |
| `.fake-xovi-lost` | xovi missing after the restart |

Each simulated restart appends a line to `.fake-restarts.log`, and each connection attempt a line to `.fake-probes.log`. A send-later run leaves no `.fake-probes.log`.

## Troubleshooting

| Problem | Action |
| --- | --- |
| Exit 3 while the tablet is awake | `ssh remarkable-wifi true`. If it fails, Wi-Fi SSH may be off: on the tablet's USB link run `rm-ssh-over-wlan on`. Or plug in USB (`remarkable`). |
| `xovi NOT loaded after the restart` | Triple-press the power button (tripletap starts xovi). The document is already delivered. |
| Exit 6, UI not back | Look at the tablet. If it is stuck, hold power to reboot, then triple-press. The files are in place. |
| Document missing in the folder | `--status`; then `ssh remarkable-wifi 'cat /home/root/.local/share/remarkable/xochitl/<uuid>.metadata'` with the uuid from `delivered[]`. |
| Remove a pushed document | On the tablet: long-press → Move to trash (preferred, syncs cleanly). Never delete files in the library over SSH. |
| Lock held (`another push is running`) | Wait. A stale lock from a dead process is taken over automatically. |
