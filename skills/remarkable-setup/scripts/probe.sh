#!/usr/bin/env bash
# probe.sh — read-only readiness check for the reMarkable article workflow; changes nothing anywhere.
#   bash probe.sh [--key ~/.ssh/id_ed25519_remarkable] [--usb remarkable] [--wifi remarkable-wifi]
# Prints one line per check (√ ready · × missing · — optional/untestable now), then one JSON line.
# Exit 0 when ready (every required item √, and key login works over USB or Wi-Fi), 1 otherwise, 2 on bad arguments.
set -u
KEY="$HOME/.ssh/id_ed25519_remarkable"
USB=remarkable
WIFI=remarkable-wifi
while [ $# -gt 0 ]; do
  case "$1" in
    --key) KEY="${2:?--key needs a path}"; shift 2 ;;
    --usb) USB="${2:?--usb needs a host alias}"; shift 2 ;;
    --wifi) WIFI="${2:?--wifi needs a host alias}"; shift 2 ;;
    -h|--help) sed -n '2,5p' "$0"; exit 0 ;;
    *) echo "Error: unknown option '$1'." >&2; echo "Fix: run 'bash probe.sh --help' for the options." >&2; exit 2 ;;
  esac
done

FAIL=0
JSON=""
row() { # row <id> <state: ok|missing|optional|skip> <detail>
  local mark='×'
  case "$2" in ok) mark='√' ;; optional|skip) mark='—' ;; esac
  printf '%s %-22s %s\n' "$mark" "$1:" "$3"
  [ "$2" = missing ] && FAIL=1
  JSON="$JSON\"$1\":{\"state\":\"$2\",\"detail\":\"$(printf '%s' "$3" | tr '"\\' "''")\"},"
}
SSH_OPTS=(-o BatchMode=yes -o ConnectTimeout=5)

# Classify an ssh failure from its stderr, so the agent picks the right troubleshooting section.
why() {
  case "$1" in
    *"IDENTIFICATION HAS CHANGED"*|*"Host key verification failed"*) echo "host key changed (troubleshooting: Host key warnings)" ;;
    *"Could not resolve"*|*"nodename nor servname"*) echo "name does not resolve (asleep, Wi-Fi off, or mDNS blocked)" ;;
    *"Permission denied"*) echo "reached the tablet but the key was refused (key not installed)" ;;
    *"timed out"*|*"No route"*|*"Network is unreachable"*) echo "no answer (asleep, off this network, or Wi-Fi SSH off)" ;;
    *"refused"*) echo "port 22 refused (SSH off for this interface)" ;;
    *) echo "failed: $(printf '%s' "$1" | head -n 1 | cut -c1-80)" ;;
  esac
}

# --- Mac tools ---
if [ "$(uname -s)" != Darwin ]; then row platform missing "not macOS — the article workflow is Mac-only"; fi
if command -v brew >/dev/null 2>&1; then row homebrew ok "$(command -v brew)"; else row homebrew optional "not installed (needed only to install missing tools)"; fi
if command -v node >/dev/null 2>&1; then
  v=$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)
  case "$v" in ''|*[!0-9]*) v=0 ;; esac
  if [ "$v" -ge 20 ]; then row node ok "$(node --version)"; else row node missing "$(node --version) is older than 20"; fi
else row node missing "not installed"; fi
chrome=""
for c in "/Applications/Google Chrome.app" "/Applications/Chromium.app" "/Applications/Microsoft Edge.app" "/Applications/Brave Browser.app" "$HOME/Applications/Google Chrome.app"; do
  [ -d "$c" ] && { chrome="$c"; break; }
done
if [ -n "$chrome" ]; then row chrome ok "$chrome (any Chromium-family browser works)"; else row chrome missing "no Chrome, Chromium, Edge or Brave in /Applications"; fi
if command -v pandoc >/dev/null 2>&1; then row pandoc ok "$(pandoc --version | head -n 1)"; else row pandoc optional "not installed (needed only for .md notes)"; fi
if command -v pdftoppm >/dev/null 2>&1 && command -v magick >/dev/null 2>&1; then row page-preview ok "poppler + ImageMagick"; else row page-preview optional "poppler/ImageMagick missing (all-page preview unavailable)"; fi

# --- SSH key ---
if [ -f "$KEY" ] && [ -f "$KEY.pub" ]; then
  if ssh-keygen -y -P "" -f "$KEY" >/dev/null 2>&1; then row ssh-key ok "$KEY"; else row ssh-key missing "$KEY has a passphrase (BatchMode logins cannot use it)"; fi
elif [ -f "$KEY" ]; then row ssh-key missing "$KEY exists but $KEY.pub is missing"
else row ssh-key missing "$KEY not found"; fi

# --- Host aliases: the effective values, after every Host/Match block ssh would apply ---
alias_state() { # alias_state <alias> <expected hostname or "any">
  local cfg h u idf
  cfg=$(ssh -G "$1" 2>/dev/null)
  h=$(printf '%s\n' "$cfg" | awk '/^hostname /{print $2}')
  u=$(printf '%s\n' "$cfg" | awk '/^user /{print $2}')
  idf=$(printf '%s\n' "$cfg" | awk '/^identityfile /{print $2}' | sed "s|^~|$HOME|" | tr '\n' ' ')
  if [ -z "$h" ] || [ "$h" = "$1" ]; then row "alias-$1" missing "no Host $1 block in ~/.ssh/config"; return; fi
  local bad=""
  [ "$2" != any ] && [ "$h" != "$2" ] && bad="$bad HostName is $h (expected $2);"
  [ "$u" != root ] && bad="$bad User is ${u:-unset} (expected root — an earlier Host * block may override it);"
  case " $idf" in *" $KEY "*) ;; *) bad="$bad IdentityFile does not include $KEY;" ;; esac
  if [ -n "$bad" ]; then row "alias-$1" missing "${bad# }"; else row "alias-$1" ok "HostName $h, User root"; fi
}
alias_state "$USB" 10.11.99.1
alias_state "$WIFI" any # remarkable.local or a fixed IP are both fine

# --- Tablet over USB (the ssh client itself is the probe: macOS nc ignores its timeout here) ---
usb_err=$(ssh -o BatchMode=yes -o ConnectTimeout=4 -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null root@10.11.99.1 true 2>&1 >/dev/null); usb_rc=$?
USB_OK=0
if [ $usb_rc -eq 0 ] || printf '%s' "$usb_err" | grep -qi 'permission denied'; then
  row usb-link ok "10.11.99.1:22 answers"
  err=$(ssh "${SSH_OPTS[@]}" "$USB" true 2>&1 >/dev/null) && { row usb-key-login ok "ssh $USB works without a password"; USB_OK=1; } || row usb-key-login missing "$(why "$err")"
else
  row usb-link skip "no tablet on USB (plug in the cable and wake it to test)"
  row usb-key-login skip "needs the USB link"
fi

# --- Tablet over Wi-Fi ---
WIFI_OK=0
if err=$(ssh "${SSH_OPTS[@]}" "$WIFI" true 2>&1 >/dev/null); then
  row wifi-key-login ok "ssh $WIFI works without a password"; WIFI_OK=1
elif [ $USB_OK = 1 ]; then
  row wifi-key-login optional "$(why "$err") — USB works, Wi-Fi is a convenience"
else
  row wifi-key-login missing "$(why "$err")"
fi

# --- Tablet library ---
LIVE=""; [ $WIFI_OK = 1 ] && LIVE="$WIFI"; [ -z "$LIVE" ] && [ $USB_OK = 1 ] && LIVE="$USB"
if [ -n "$LIVE" ]; then
  out=$(ssh "${SSH_OPTS[@]}" "$LIVE" 'test -d /home/root/.local/share/remarkable/xochitl && echo lib=1 || echo lib=0; echo ui=$(systemctl is-active xochitl); echo freekb=$(df -k /home | awk "NR==2{print \$4}")' 2>/dev/null)
  case "$out" in *lib=1*) row library ok "xochitl library present" ;; *) row library missing "library folder not found" ;; esac
  case "$out" in *ui=active*) row ui ok "xochitl running" ;; *) row ui missing "xochitl not active" ;; esac
  kb=$(printf '%s\n' "$out" | sed -n 's/^freekb=//p'); case "$kb" in ''|*[!0-9]*) kb=0 ;; esac
  if [ "$kb" -ge 200000 ]; then row free-space ok "$((kb / 1024)) MB free on /home"; else row free-space missing "${kb} KB free on /home"; fi
else
  row library skip "tablet not reachable"; row ui skip "tablet not reachable"; row free-space skip "tablet not reachable"
fi

[ $USB_OK = 0 ] && [ $WIFI_OK = 0 ] && FAIL=1
printf '{"ready":%s,%s"usbLogin":%s,"wifiLogin":%s}\n' "$([ $FAIL = 0 ] && echo true || echo false)" "$JSON" "$USB_OK" "$WIFI_OK"
exit $FAIL
