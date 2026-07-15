#!/usr/bin/env bash
# Print the extra `gh release create` flags required by a valid nullsink tag.
# Stable tags intentionally print nothing, preserving GitHub's existing automatic "Latest" selection.
set -euo pipefail

tag="${1:-}"
core='(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)'
identifier='[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*'
stable_re="^v${core}(\+${identifier})?$"
prerelease_re="^v${core}-${identifier}(\+${identifier})?$"

if [[ "$tag" =~ $prerelease_re ]]; then
  # SemVer forbids leading zeroes in numeric prerelease identifiers (`-0` is valid; `-00` is not).
  prerelease="${tag#v}"
  prerelease="${prerelease%%+*}"
  prerelease="${prerelease#*-}"
  IFS='.' read -r -a prerelease_identifiers <<< "$prerelease"
  for identifier_part in "${prerelease_identifiers[@]}"; do
    if [[ "$identifier_part" =~ ^[0-9]+$ && ${#identifier_part} -gt 1 && "$identifier_part" == 0* ]]; then
      printf 'release-create-flags: numeric prerelease identifiers must not contain leading zeroes: %q\n' "$tag" >&2
      exit 2
    fi
  done
  # A manual RC/beta tag must never become an ordinary Release or GitHub's Latest release.
  printf '%s\n' --prerelease --latest=false
elif [[ "$tag" =~ $stable_re ]]; then
  # No flags: this is the exact behavior the manual stable-tag fallback had before prerelease support.
  exit 0
else
  printf 'release-create-flags: expected vMAJOR.MINOR.PATCH[-PRERELEASE][+BUILD], got %q\n' "$tag" >&2
  exit 2
fi
