#!/bin/sh
# Run as PUID:PGID (Unraid default 99:100 = nobody:users) so files in appdata stay manageable.
set -e
if [ "$(id -u)" = "0" ]; then
  mkdir -p "$DATA_DIR"
  # Only walk the whole folder when its owner is wrong (first start, or PUID/PGID changed): with a
  # WhatsApp media folder in there, a recursive chown on every start takes minutes on Unraid's shares.
  if [ "$(stat -c '%u:%g' "$DATA_DIR")" != "$PUID:$PGID" ]; then
    chown -R "$PUID:$PGID" "$DATA_DIR"
  else
    # The database and its folders are what the app must be able to write.
    for f in "$DATA_DIR" "$DATA_DIR"/*.db "$DATA_DIR"/*.db-wal "$DATA_DIR"/*.db-shm "$DATA_DIR"/attachments "$DATA_DIR"/avatars "$DATA_DIR"/whatsapp-backup; do
      [ -e "$f" ] && chown "$PUID:$PGID" "$f"
    done
  fi
  exec su-exec "$PUID:$PGID" "$@"
fi
exec "$@"
