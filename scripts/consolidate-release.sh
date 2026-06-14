#!/usr/bin/env bash
#
# Work around an electron-builder quirk: its GitHub publisher sometimes races and
# creates TWO releases for one tag — a canonical one (latest.yml + installer) and
# a stray one holding only the .exe.blockmap. This consolidates them: any asset on
# a stray release is uploaded to the canonical release (from the local build output
# in release/), then the stray release is deleted. The shared git tag is untouched.
#
# No-op when electron-builder behaves (a single release for the tag).
#
# Env: GH_TOKEN (contents:write), GITHUB_REF_NAME (tag, e.g. v0.3.2),
#      GITHUB_REPOSITORY (owner/repo). Run after `electron-builder --publish always`.
set -euo pipefail

TAG="${GITHUB_REF_NAME:?GITHUB_REF_NAME required}"
REPO="${GITHUB_REPOSITORY:?GITHUB_REPOSITORY required}"
OUT_DIR="${RELEASE_OUTPUT_DIR:-release}"

# Give GitHub a moment to settle after the publish uploads.
sleep 5

mapfile -t IDS < <(gh api "repos/$REPO/releases" --paginate \
  --jq ".[] | select(.tag_name==\"$TAG\") | .id")

echo "Releases on $TAG: ${IDS[*]:-none}"
if [ "${#IDS[@]}" -le 1 ]; then
  echo "Single release for $TAG — nothing to consolidate."
  exit 0
fi

# Canonical = the release that carries latest.yml (what electron-updater reads).
MAIN=""
for id in "${IDS[@]}"; do
  if gh api "repos/$REPO/releases/$id" --jq '.assets[].name' | grep -qx "latest.yml"; then
    MAIN="$id"
    break
  fi
done
if [ -z "$MAIN" ]; then
  echo "No release with latest.yml found for $TAG; leaving releases untouched."
  exit 0
fi
echo "Canonical release: $MAIN"

mapfile -t MAIN_ASSETS < <(gh api "repos/$REPO/releases/$MAIN" --jq '.assets[].name')

for id in "${IDS[@]}"; do
  [ "$id" = "$MAIN" ] && continue
  echo "Consolidating stray release $id"
  while IFS= read -r aname; do
    [ -z "$aname" ] && continue
    if printf '%s\n' "${MAIN_ASSETS[@]}" | grep -qx "$aname"; then
      echo "  $aname already on canonical — skip"
    elif [ -f "$OUT_DIR/$aname" ]; then
      echo "  Uploading $OUT_DIR/$aname -> canonical $MAIN"
      curl -sf -X POST \
        -H "Authorization: Bearer $GH_TOKEN" \
        -H "Content-Type: application/octet-stream" \
        --data-binary @"$OUT_DIR/$aname" \
        "https://uploads.github.com/repos/$REPO/releases/$MAIN/assets?name=$aname" >/dev/null
    else
      echo "  WARNING: $OUT_DIR/$aname not found locally — cannot move, skipping"
    fi
  done < <(gh api "repos/$REPO/releases/$id" --jq '.assets[].name')
  gh api -X DELETE "repos/$REPO/releases/$id"
  echo "  Deleted stray release $id"
done

echo "Consolidation complete for $TAG."
