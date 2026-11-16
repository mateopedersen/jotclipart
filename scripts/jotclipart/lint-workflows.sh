#!/usr/bin/env bash
set -euo pipefail
# The existing approved actionlint release/archive pin, shared by both backends.
audit_dir="${RUNNER_TEMP:?GitHub runner temporary directory required}/jotclipart-actionlint"
mkdir -p "$audit_dir"
archive="$audit_dir/archive.tar.gz"
verified_archive() {
  test -f "$1" &&
    test "$(wc -c < "$1")" -eq 2353908 &&
    echo '8aca8db96f1b94770f1b0d72b6dddcb1ebb8123cb3712530b08cc387b349a3d8  '"$1" | sha256sum --check --status
}
if ! verified_archive "$archive"; then
  rm -f "$archive.part"
  for asset_url in \
    https://api.github.com/repos/rhysd/actionlint/releases/assets/384924896 \
    https://github.com/rhysd/actionlint/releases/download/v1.7.12/actionlint_1.7.12_linux_amd64.tar.gz; do
    if curl --fail --silent --show-error --location --proto '=https' --proto-redir '=https' \
      --max-redirs 5 --retry 1 --retry-max-time 95 --max-time 45 --max-filesize 2353908 \
      -H 'Accept: application/octet-stream' -o "$archive.part" "$asset_url" &&
      verified_archive "$archive.part"; then
      mv "$archive.part" "$archive"
      break
    fi
    rm -f "$archive.part"
  done
fi
verified_archive "$archive"
tar -xzf "$archive" -C "$audit_dir" actionlint
"$audit_dir/actionlint" -shellcheck= .github/workflows/ci.yml .github/workflows/jotclipart-native.yml
