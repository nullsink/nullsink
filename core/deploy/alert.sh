#!/usr/bin/env bash
# Push a one-line operational alert to Telegram. Used as the OnFailure= sink for status-check.service and
# the app/wallet units, and by status-check.sh (--recovered) to close an incident. Outbound-only.
#
# PRIVACY: sends NO request content. For the health check (status-check.service) it includes that script's
# own WARN lines + an OK count (unit states + chain heights — no token, no subaddress, no user data, by
# design). For any OTHER unit it sends ONLY the unit name + host, never journal lines, so a stray
# prompt-derived error snippet in the app log can never reach a third party (Telegram). The operator
# investigates on the box.
#
# Reads TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID from /etc/nullsink.env (the status-alert@ unit's
# EnvironmentFile). If either is unset it is a NO-OP (logs to journald, exits 0) so an unconfigured box
# doesn't error the alert unit. Get a bot token from @BotFather and your numeric chat id from @userinfobot.
set -u

mode=failed
if [ "${1:-}" = "--recovered" ]; then mode=recovered; shift; fi

# %i arrives literal (OnFailure= passes %n verbatim into the instance). Do NOT systemd-escape -u it:
# unescaping turns '-' into '/', which both garbles the name and breaks the status-check detail match below.
unit="${1:-unknown}"
host="$(hostname 2>/dev/null || echo box)"
ts="$(date -u '+%Y-%m-%d %H:%M UTC')"

if [ -z "${TELEGRAM_BOT_TOKEN:-}" ] || [ -z "${TELEGRAM_CHAT_ID:-}" ]; then
  echo "alert: TELEGRAM_BOT_TOKEN/CHAT_ID unset in /etc/nullsink.env — skipping push for $unit" >&2
  exit 0
fi

# parse_mode=HTML below: every dynamic string must be escaped or one stray '>' (e.g. the backup-age WARN
# "(> 6h)") 400s the whole message.
esc() { sed 's/&/\&amp;/g; s/</\&lt;/g; s/>/\&gt;/g' <<<"$1"; }

# Only the health-check report is safe to forward (it is operational-only by construction): WARN lines
# first — the signal — plus an OK count instead of the full report (13 OK lines bury 2 WARNs on a phone).
# For app/wallet failures, page minimally and point the operator at the box.
detail=""
if [ "$unit" = "status-check.service" ] && [ "$mode" = failed ]; then
  report="$(journalctl -u status-check.service -n 25 --no-pager -o cat 2>/dev/null | grep -E '^(OK|WARN) ' | tail -20)"
  warns="$(grep '^WARN' <<<"$report")"
  detail="${warns:+$warns
}$(grep -c '^OK' <<<"$report") checks OK"
fi

if [ "$mode" = recovered ]; then
  html="✅ <b>nullsink</b>: <code>$(esc "$unit")</code> recovered on $(esc "$host") — ${ts}."
  plain="✅ nullsink: ${unit} recovered on ${host} — ${ts}."
else
  html="⚠ <b>nullsink</b>: <code>$(esc "$unit")</code> failed on $(esc "$host") — ${ts}.
Check on the box:
<code>systemctl status $(esc "$unit")</code>
<code>journalctl -u $(esc "$unit") -n50</code>${detail:+

<pre>$(esc "$detail")</pre>}"
  plain="⚠ nullsink: ${unit} failed on ${host} — ${ts}.
Check on the box: systemctl status ${unit} ; journalctl -u ${unit} -n50${detail:+

$detail}"
fi

# -f + --retry-all-errors: a page lost to one flaky curl attempt is a silent monitoring hole, so retry
# transient network/API failures; if Telegram still rejects the HTML, fall back to plain text rather than
# dropping the page.
send() {
  curl -sS -f --max-time 15 --retry 3 --retry-all-errors --retry-delay 5 \
    "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage" \
    --data-urlencode "chat_id=${TELEGRAM_CHAT_ID}" -o /dev/null "$@"
}
send --data-urlencode "text=${html}" --data-urlencode "parse_mode=HTML" \
  || send --data-urlencode "text=${plain}" \
  || echo "alert: telegram push failed for $unit" >&2
