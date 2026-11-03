# Troubleshooting

Read the section for the probe item that stays `×` (or `—` when it should be testable). Every command here that changes the Mac or the tablet is a gate: explain it and get a yes first.

## USB link (`usb-link` stays `—` with the cable in)

- Wake the tablet and unlock it. The USB network (10.11.99.1) appears only while it is awake.
- Use a data cable; some USB-C cables only charge. Try another port, without a hub.
- macOS: System Settings → Network should list a "reMarkable" (RNDIS/Ethernet) interface with a 10.11.99.x address. Missing → unplug, wait 5 s, replug.
- Still nothing → reboot the tablet (hold the power button, choose Restart), then plug in again.

## Password and key install (`usb-key-login` stays `×`)

- The password is case-sensitive and shown under Settings → General → Help → About → Copyrights and licenses → General information. It can change after a factory reset.
- `ssh-copy-id` says "Permission denied" → retype the password; copy it character by character, as `l`/`1` and `O`/`0` look alike.
- `ssh-copy-id` is missing → the user can install the key with the same password prompt:
  `cat ~/.ssh/id_ed25519_remarkable.pub | ssh remarkable 'mkdir -p ~/.ssh && chmod 700 ~/.ssh && cat >> ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys'`
- "no matching host key type found" → the `HostKeyAlgorithms +ssh-rsa` line is missing from the alias block.

## Host key warnings

- Probe detail "host key changed" (ssh: "REMOTE HOST IDENTIFICATION HAS CHANGED") is expected right after a software update or a factory reset: the tablet made a new host key. Ask the user whether the tablet was updated or reset. Only on a yes (gate), remove the old key with `ssh-keygen -R remarkable`, then let the user accept the new one with `! ssh remarkable true` (over USB).
- The same warning with no update or reset → stop and tell the user; do not remove the key.

## Wi-Fi (`wifi-key-login` stays `×`)

1. Wake the tablet: Wi-Fi turns off while it sleeps.
2. Check that Wi-Fi SSH is on. This needs the cable and a working USB key login: `ssh remarkable rm-ssh-over-wlan on` (safe to run again).
3. Name resolution: `ping -c 1 remarkable.local`. "Unknown host" means mDNS (Bonjour) does not reach the tablet. This happens on guest networks and some routers. Use the tablet's IP instead:
   - Find it over USB: `ssh remarkable "ip -4 addr show wlan0"` (the `inet` address).
   - Gate: back up `~/.ssh/config`, then replace `HostName remarkable.local` with that address in the `remarkable-wifi` block.
   - Suggest a DHCP reservation on the router so the address stays the same.
4. Same network: the Mac and the tablet must be on the same Wi-Fi (not a guest network with client isolation).
5. macOS Local Network permission: apps that run `ssh` (Obsidian, a terminal, an editor) may need System Settings → Privacy & Security → Local Network turned on.

## Library (`library` or `ui` stays `×`)

- `xochitl not active` → the tablet UI is not running; the screen shows an error or is frozen. Reboot the tablet.
- `free-space` low → delete or archive documents on the tablet; the workflow needs room for each PDF.
