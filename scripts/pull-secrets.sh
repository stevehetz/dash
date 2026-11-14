#!/bin/sh
# Copy secrets from the Dropbox master copy into this checkout as real files.
#
#   SRC  = $DASH_SECRETS_DIR, default ~/Library/CloudStorage/Dropbox/dropbox/secret/dash
#   DEST = repo root (resolved from this script's location)
#
# Every file under SRC except README.txt lands at the same relative path in the repo,
# chmod 600. Symlinks at the destination are replaced with real files. Never prints
# contents, and never fails: a missing source or unreadable file is a warning and the
# existing local file is kept, so boot always proceeds.

SRC=${DASH_SECRETS_DIR:-$HOME/Library/CloudStorage/Dropbox/dropbox/secret/dash}
DEST=$(cd "$(dirname "$0")/.." 2>/dev/null && pwd -P)

warn() { echo "secrets:pull: WARNING: $*" >&2; }

if [ -z "$DEST" ]; then
  warn "could not resolve repo root; skipping"
  exit 0
fi

if [ ! -d "$SRC" ]; then
  warn "source $SRC not found; keeping existing local secrets"
  exit 0
fi

LIST=$(mktemp "${TMPDIR:-/tmp}/pull-secrets.XXXXXX") || { warn "mktemp failed; skipping"; exit 0; }
trap 'rm -f "$LIST"' EXIT

(cd "$SRC" && find . -type f ! -name README.txt ! -name '.DS_Store') > "$LIST" 2>/dev/null \
  || warn "could not fully list $SRC"

while IFS= read -r rel; do
  rel=${rel#./}
  [ -n "$rel" ] || continue
  src="$SRC/$rel"
  dst="$DEST/$rel"

  if [ ! -r "$src" ]; then
    warn "$rel: cannot read source; keeping local file"
    continue
  fi

  # A symlink at the destination is always replaced, even if it points at the same content.
  if [ ! -L "$dst" ] && [ -f "$dst" ] && cmp -s "$src" "$dst"; then
    chmod 600 "$dst" 2>/dev/null
    echo "secrets:pull: unchanged $rel"
    continue
  fi

  if ! mkdir -p "$(dirname "$dst")"; then
    warn "$rel: cannot create directory; keeping local file"
    continue
  fi

  tmp="$dst.pull-secrets.$$"
  if cp "$src" "$tmp" 2>/dev/null; then
    chmod 600 "$tmp"
    [ -L "$dst" ] && rm -f "$dst"
    if mv -f "$tmp" "$dst"; then
      echo "secrets:pull: updated $rel"
    else
      rm -f "$tmp"
      warn "$rel: could not install; keeping local file"
    fi
  else
    rm -f "$tmp"
    warn "$rel: copy failed; keeping local file"
  fi
done < "$LIST"

exit 0
