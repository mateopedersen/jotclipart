#!/bin/sh
# Local, fail-closed rebuild proof. No download, package installation or overwrite.
set -eu
HERE=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)
OUT=${1:?supply an existing absolute output directory}
case "$OUT" in /*) ;; *) printf '%s\n' 'absolute output directory required' >&2; exit 1;; esac
REAL_OUT=$(CDPATH= cd -- "$OUT" && pwd -P)
[ "$OUT" = "$REAL_OUT" ] || { printf '%s\n' 'output directory must be canonical' >&2; exit 1; }
[ "$(uname -s)" = Darwin ] && [ "$(uname -m)" = arm64 ] || { printf '%s\n' 'this binary is for macOS arm64 only' >&2; exit 1; }
CLANG=/Library/Developer/CommandLineTools/usr/bin/clang
SDK=/Library/Developer/CommandLineTools/SDKs/MacOSX.sdk
[ -x "$CLANG" ] && [ -d "$SDK" ] || { printf '%s\n' 'local Apple Command Line Tools are required' >&2; exit 1; }
(cd "$HERE/node-api-headers" && shasum -a 256 -c SHA256SUMS)
[ "$(shasum -a 256 "$HERE/clonefile.c" | cut -d ' ' -f 1)" = 1fbfdde415ff8ea4d0ab1f158bf055240d6ede9c04aa67d5b14a20ae712a6283 ] || { printf '%s\n' 'source attestation failed' >&2; exit 1; }
[ ! -e "$OUT/clonefile.node" ] && [ ! -L "$OUT/clonefile.node" ] || { printf '%s\n' 'refusing to overwrite output' >&2; exit 1; }
BUILD=$(mktemp -d "$OUT/.clone-build.XXXXXXXX")
trap 'rm -rf "$BUILD"' EXIT HUP INT TERM
"$CLANG" -std=c11 -O2 -Wall -Wextra -Werror -fPIC -DNAPI_VERSION=8 -bundle -undefined dynamic_lookup -isysroot "$SDK" -mmacosx-version-min=12.0 -I "$HERE/node-api-headers" "$HERE/clonefile.c" -o "$BUILD/clonefile.node"
ACTUAL=$(shasum -a 256 "$BUILD/clonefile.node" | cut -d ' ' -f 1)
[ "$ACTUAL" = 627ccf8c494b1dcae9914321dfd65c5fabb380dd985ce3ac36f8a775407a2b04 ] || { printf '%s\n' 'binary digest differs: review and renew attestation' >&2; exit 1; }
ln "$BUILD/clonefile.node" "$OUT/clonefile.node"
printf '%s\n' "attested binary: $ACTUAL"
