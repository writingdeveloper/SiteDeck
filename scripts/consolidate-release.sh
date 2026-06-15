#!/usr/bin/env bash
#
# Work around an electron-builder quirk: its GitHub publisher sometimes races and
# creates TWO releases for one tag — a canonical one (latest.yml + installer) and
# a stray one holding only the .exe.blockmap. This consolidates them: every asset
# on a stray release is copied to the canonical release, then the stray is deleted.
# Assets are copied by downloading them from the stray release over the API (NOT
# from the local build dir, whose layout we can't rely on), and the stray is only
# deleted once every one of its assets is confirmed on the canonical release — so a
# failed copy never loses an asset. The shared git tag is untouched.
#
# No-op when electron-builder behaves (a single release for the tag).
#
# Env: GH_TOKEN (contents:write), GITHUB_REF_NAME (tag, e.g. v0.3.3),
#      GITHUB_REPOSITORY (owner/repo). Run after `electron-builder --publish always`.
set -euo pipefail

TAG="${GITHUB_REF_NAME:?GITHUB_REF_NAME required}"
REPO="${GITHUB_REPOSITORY:?GITHUB_REPOSITORY required}"
API="https://api.github.com/repos/$REPO"
UPLOADS="https://uploads.github.com/repos/$REPO"

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
  if gh api "$API/releases/$id" --jq '.assets[].name' | grep -qx "latest.yml"; then
    MAIN="$id"
    break
  fi
done
if [ -z "$MAIN" ]; then
  echo "No release with latest.yml found for $TAG; leaving releases untouched."
  exit 0
fi
echo "Canonical release: $MAIN"

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

for id in "${IDS[@]}"; do
  [ "$id" = "$MAIN" ] && continue
  echo "Consolidating stray release $id"
  mapfile -t MAIN_ASSETS < <(gh api "$API/releases/$MAIN" --jq '.assets[].name')
  moved_all=1

  while IFS=$'\t' read -r aid aname; do
    [ -z "$aname" ] && continue
    if printf '%s\n' "${MAIN_ASSETS[@]}" | grep -qx "$aname"; then
      echo "  $aname already on canonical — skip"
      continue
    fi
    echo "  Copying $aname (asset $aid) -> canonical $MAIN"
    if curl -sfL -H "Authorization: Bearer $GH_TOKEN" -H "Accept: application/octet-stream" \
         "$API/releases/assets/$aid" -o "$tmp/$aname" \
       && curl -sf -X POST -H "Authorization: Bearer $GH_TOKEN" \
         -H "Content-Type: application/octet-stream" --data-binary @"$tmp/$aname" \
         "$UPLOADS/releases/$MAIN/assets?name=$aname" >/dev/null; then
      echo "    copied."
    else
      echo "    WARNING: could not copy $aname"
      moved_all=0
    fi
  done < <(gh api "$API/releases/$id" --jq '.assets[] | "\(.id)\t\(.name)"')

  if [ "$moved_all" -eq 1 ]; then
    gh api -X DELETE "$API/releases/$id"
    echo "  Deleted stray release $id"
  else
    echo "  Kept stray release $id (some assets could not be copied) — resolve manually."
  fi
done

echo "Consolidation complete for $TAG."
