# shellcheck shell=bash
# Shared "apply repo config to the box" helpers, SOURCED by setup.sh (bootstrap) and deploy.sh (redeploy)
# so unit/timer install lives in one place and can't drift. No side effects beyond defining helpers + REPO.
# Caller must set APP_DIR (and ENV_FILE for health_ok).

# The GitHub repo slug the box pulls release assets from — single source of truth for all four fetch
# helpers. Env-overridable so a public fork/mirror can point elsewhere without editing this file.
REPO="${REPO:-nullsink/nullsink}"

# Fetch one PUBLIC Release asset $2 for tag $1 into dir $3. The repo is public, so a plain unauthenticated
# curl works — no gh, no auth on the box. -L follows GitHub's 302 to the asset CDN; -f fails the pipeline
# on a 404/5xx. Callers still `test -f` + `sha256sum -c` what lands here.
fetch_asset() { curl -fsSL "https://github.com/$REPO/releases/download/$1/$2" -o "$3/$2"; }

install_units() {  # refresh ALL units + timers from the repo so on-box config can't drift, then reload
  cp "$APP_DIR"/deploy/*.service "$APP_DIR"/deploy/*.timer /etc/systemd/system/
  systemctl daemon-reload
}

install_binary() {  # $1=tag — fetch+verify+activate the self-contained app binary for a release tag
  # Binary layout: versioned /usr/local/lib/nullsink/nullsink-<tag> + a `current` symlink -> the active
  # version (a RELATIVE target, so the dir is self-contained/relocatable). The unit's ExecStart runs the
  # symlink; activation is an atomic `ln -sfn` swap, rollback is repointing it at the previous target.
  # The binary is the self-contained `bun build --compile` artifact (bundles prices.json etc.) — it runs
  # with only /etc/nullsink.env + /var/lib/nullsink, no source/Bun needed.
  local tag="$1" tmp
  mkdir -p /usr/local/lib/nullsink
  tmp="$(mktemp -d)"
  fetch_asset "$tag" 'nullsink-linux-x64' "$tmp"
  fetch_asset "$tag" 'SHA256SUMS' "$tmp"
  test -f "$tmp/nullsink-linux-x64"   # assert the asset downloaded
  ( cd "$tmp" && sha256sum -c --ignore-missing SHA256SUMS )   # SHA256SUMS lists all 4 assets; verify the one we pulled
  install -m755 "$tmp/nullsink-linux-x64" "/usr/local/lib/nullsink/nullsink-$tag"
  ln -sfn "nullsink-$tag" /usr/local/lib/nullsink/current   # atomic activate (relative target)
  rm -rf "$tmp"
  echo "    app binary $tag activated (/usr/local/lib/nullsink/current -> nullsink-$tag)"
}

install_nsk() {  # $1=tag — fetch+verify+install the operator CLI binary (nsk) to /usr/local/bin/nsk
  # A single flat binary (no version-symlink/rollback dance — it's a stateless one-shot tool), built from the
  # SAME tag as the server in one release.yml run so the two can't drift.
  local tag="$1" tmp
  tmp="$(mktemp -d)"
  fetch_asset "$tag" 'nsk-linux-x64' "$tmp"
  fetch_asset "$tag" 'SHA256SUMS' "$tmp"
  test -f "$tmp/nsk-linux-x64"
  ( cd "$tmp" && sha256sum -c --ignore-missing SHA256SUMS )
  install -m755 "$tmp/nsk-linux-x64" /usr/local/bin/nsk
  rm -rf "$tmp"
  echo "    operator CLI nsk $tag installed (/usr/local/bin/nsk)"
}

install_deploy_tree() {  # $1=tag $2=dest — fetch+verify+extract deploy-<tag>.tar.gz so $2/deploy/ exists
  # Source-free box: the systemd units ExecStart $APP_DIR/deploy/*.sh, so the box needs deploy/ (NOT src/ or
  # cli/). Ship it as a release tarball instead of git-cloning the whole source repo.
  local tag="$1" dest="$2" tmp
  tmp="$(mktemp -d)"
  fetch_asset "$tag" "deploy-${tag}.tar.gz" "$tmp"
  fetch_asset "$tag" 'SHA256SUMS' "$tmp"
  test -f "$tmp/deploy-${tag}.tar.gz"
  ( cd "$tmp" && sha256sum -c --ignore-missing SHA256SUMS )
  mkdir -p "$dest"
  tar -xzf "$tmp/deploy-${tag}.tar.gz" -C "$dest"   # release.yml `tar -czf … -C core deploy` -> $dest/deploy/*
  rm -rf "$tmp"
  echo "    deploy tree $tag extracted to $dest/deploy"
}

install_client_ui() {  # $1=tag $2=webbase — fetch+verify+extract the client UI, activate via a versioned symlink
  # Versioned webroot, mirroring the binary's versioned dir + `current` symlink: each release's UI lands in
  # $webbase/web-<tag>, and an atomic `ln -sfn` swaps $webbase/current-web at it. The Caddyfile root is
  # {$NULLSINK_WEBROOT:/var/www/nullsink/current-web}, so this swap (and its rollback in deploy.sh) is exactly
  # what the edge serves. release.yml `tar -czf … -C client dist` -> entries dist/*, so strip one component.
  local tag="$1" webbase="$2" tmp
  mkdir -p "$webbase"
  tmp="$(mktemp -d)"
  fetch_asset "$tag" "nullsink-ui-${tag}.tar.gz" "$tmp"
  fetch_asset "$tag" 'SHA256SUMS' "$tmp"
  test -f "$tmp/nullsink-ui-${tag}.tar.gz"
  ( cd "$tmp" && sha256sum -c --ignore-missing SHA256SUMS )
  # Stage the extract in web-$tag.new and swap it into place only once it's verified-good, so a
  # fetch-ok-then-extract-fail on a SAME-tag redeploy can't destroy the currently-serving web-$tag
  # (set -e aborts before the swap). The activate stays an atomic ln -sfn.
  local staging="$webbase/web-$tag.new"
  rm -rf "${staging:?}"
  mkdir -p "$staging"
  tar -xzf "$tmp/nullsink-ui-${tag}.tar.gz" -C "$staging" --strip-components=1   # dist/* -> web-$tag.new/*
  test -f "$staging/index.html"               # assert the extract landed (guards a malformed/empty UI tarball)
  chmod -R a+rX "$staging"                     # Caddy runs as its own user — ensure it can read files + traverse dirs
  rm -rf "${webbase:?}/web-$tag"               # drop the old copy only now — the new one is staged + validated
  mv "$staging" "$webbase/web-$tag"            # swap into place
  ln -sfn "web-$tag" "$webbase/current-web"   # atomic activate (relative target)
  rm -rf "$tmp"
  echo "    client UI $tag activated ($webbase/current-web -> web-$tag)"
}

health_ok() {  # poll /healthz until it answers 200, up to HEALTH_TIMEOUT (default 60) seconds; return 0/1
  # /healthz is localhost-only (Caddy never routes it). Port from the env file (default 8080).
  local port health_url waited=0
  port="$(grep -E '^PORT=' "${ENV_FILE:-/etc/nullsink.env}" 2>/dev/null | tail -n1 | cut -d= -f2- || true)"
  health_url="http://127.0.0.1:${port:-8080}/healthz"
  while [ "$waited" -lt "${HEALTH_TIMEOUT:-60}" ]; do
    if curl -fsS --max-time 3 "$health_url" >/dev/null 2>&1; then return 0; fi
    sleep 2; waited=$((waited + 2))
  done
  return 1
}
