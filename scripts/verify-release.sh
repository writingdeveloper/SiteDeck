#!/usr/bin/env bash
#
# Assert the release for this tag is actually usable, and fail the job loudly if not.
#
# Why this exists: on v0.9.8 electron-builder's publisher raced itself, one side lost with
# `422 already_exists`, and what survived was a PUBLISHED release flagged "Latest" holding a
# single .exe.blockmap — no installer, no latest.yml, so electron-updater could not even see
# the version. consolidate-release.sh can't repair that (it needs two releases, one carrying
# latest.yml). Nothing checked, so the only signal was a red step buried in the log.
#
# Checks, for the tag being released:
#   1. exactly one GitHub release exists for it
#   2. it carries latest.yml, the installer, and the installer's blockmap
#   3. latest.yml names the installer that is actually attached
#
# Env: GH_TOKEN (contents:read), GITHUB_REF_NAME (tag), GITHUB_REPOSITORY (owner/repo).
set -euo pipefail

TAG="${GITHUB_REF_NAME:?GITHUB_REF_NAME required}"
REPO="${GITHUB_REPOSITORY:?GITHUB_REPOSITORY required}"
VERSION="${TAG#v}"

mapfile -t IDS < <(gh api "repos/$REPO/releases" --paginate --jq ".[] | select(.tag_name==\"$TAG\") | .id")
if [ "${#IDS[@]}" -eq 0 ]; then
  echo "FAIL: no GitHub release exists for $TAG."
  exit 1
fi
if [ "${#IDS[@]}" -gt 1 ]; then
  echo "FAIL: $TAG has ${#IDS[@]} releases (${IDS[*]}) — consolidation did not resolve the duplicate."
  exit 1
fi

ASSETS="$(gh api "repos/$REPO/releases/${IDS[0]}" --jq '.assets[].name')"
echo "Assets on $TAG:"
echo "$ASSETS" | sed 's/^/  /'

INSTALLER="SiteDeck-Setup-$VERSION.exe"
missing=0
for want in "latest.yml" "$INSTALLER" "$INSTALLER.blockmap"; do
  if ! printf '%s\n' "$ASSETS" | grep -qx "$want"; then
    echo "FAIL: missing asset $want"
    missing=1
  fi
done
[ "$missing" -eq 0 ] || {
  echo "The release is published but unusable — auto-update cannot see it. Re-run this job:"
  echo "  the release now exists, so electron-builder uploads into it instead of racing to create it."
  exit 1
}

# latest.yml is what electron-updater reads; if it points at a file that isn't attached,
# every client fails the download instead of updating.
YML_ID="$(gh api "repos/$REPO/releases/${IDS[0]}/assets" --jq '.[] | select(.name=="latest.yml") | .id')"
YML="$(gh api "repos/$REPO/releases/assets/$YML_ID" -H "Accept: application/octet-stream")"
YML_TARGET="$(printf '%s\n' "$YML" | sed -n 's/^path: *//p' | tr -d '\r')"
if [ "$YML_TARGET" != "$INSTALLER" ]; then
  echo "FAIL: latest.yml points at '$YML_TARGET' but the attached installer is '$INSTALLER'."
  exit 1
fi

echo "OK: $TAG has a single release with latest.yml + installer + blockmap, and latest.yml points at $INSTALLER."
