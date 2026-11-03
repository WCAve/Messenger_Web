#!/bin/sh
# Run as PUID:PGID (Unraid default 99:100 = nobody:users) so files in appdata stay manageable.
set -e
if [ "$(id -u)" = "0" ]; then
  mkdir -p "$DATA_DIR"
  chown -R "$PUID:$PGID" "$DATA_DIR"
  exec su-exec "$PUID:$PGID" "$@"
fi
exec "$@"
