#!/bin/sh
# Tests the built image itself (CI, after building it for amd64): starts as PUID:PGID with files owned
# right, answers its health check, and has the programs convert.ts needs (ffmpeg 7 with x264/AAC/WebP/
# AV1 decoding and VAAPI, heif-dec with HEVC, the Intel drivers). Usage: tests/docker-smoke.sh IMAGE
set -eu
IMAGE=$1
DATA=$(mktemp -d)
NAME=mw-smoke-$$
fail() { echo "FAIL: $*"; docker logs "$NAME" 2>&1 | tail -30; docker rm -f "$NAME" >/dev/null 2>&1; exit 1; }
docker run -d --name "$NAME" -p 3999:3000 -e APP_PASSWORD=smoke-test-pw -e PUID=99 -e PGID=100 -v "$DATA:/data" "$IMAGE" >/dev/null
ok=
for i in $(seq 1 60); do
  if curl -fs localhost:3999/healthz >/dev/null; then ok=1; break; fi
  sleep 1
done
[ -n "$ok" ] || fail "no answer on /healthz"
echo "ok: health check answers"
uid=$(docker exec "$NAME" sh -c 'grep -E "^(Uid|Gid):" /proc/1/status | awk "{print \$2}" | paste -sd:')
[ "$uid" = "99:100" ] || fail "app runs as $uid, expected 99:100"
echo "ok: runs as 99:100"
owner=$(docker exec "$NAME" sh -c 'stat -c "%u:%g" /data /data/*.db | sort -u')
[ "$owner" = "99:100" ] || fail "database owned by $owner"
echo "ok: database owned by 99:100"
for i in $(seq 1 30); do
  [ "$(docker inspect -f '{{.State.Health.Status}}' "$NAME")" = healthy ] && break
  sleep 2
done
[ "$(docker inspect -f '{{.State.Health.Status}}' "$NAME")" = healthy ] || echo "note: Docker's own health check not 'healthy' yet (checks every 30 s)"
x() { docker exec "$NAME" sh -c "$1"; }
v=$(x 'ffmpeg -version | head -1'); echo "$v"
echo "$v" | grep -Eq 'version [7-9]\.|version n?[7-9]' || fail "ffmpeg older than 7"
for e in libx264 aac h264_vaapi; do x "ffmpeg -hide_banner -encoders | grep -qw $e" || fail "ffmpeg encoder $e missing"; done
for d in libdav1d hevc; do x "ffmpeg -hide_banner -decoders | grep -qw $d" || fail "ffmpeg decoder $d missing"; done
for f in scale_vaapi hwupload; do x "ffmpeg -hide_banner -filters | grep -qw $f" || fail "ffmpeg filter $f missing"; done
x "ffmpeg -hide_banner -muxers | grep -qw webp" || fail "webp missing"
echo "ok: ffmpeg encoders, decoders and filters"
x 'ls /usr/lib/x86_64-linux-gnu/dri/iHD_drv_video.so /usr/lib/x86_64-linux-gnu/dri/i965_drv_video.so' >/dev/null || fail "Intel video drivers missing"
echo "ok: Intel drivers"
# A video and an iPhone-style photo, converted like the app does (as the app's user, in /tmp). Making
# the HEIC needs an encoder the image doesn't ship: installed into this test container only.
x 'cd /tmp && setpriv --reuid=99 --regid=100 --clear-groups sh -c "
  ffmpeg -v error -y -f lavfi -i testsrc2=size=320x240:rate=25 -f lavfi -i sine -t 1 -c:v libx264 -pix_fmt yuv420p -c:a aac -shortest t.mp4 &&
  ffmpeg -v error -y -i t.mp4 -frames:v 1 t.png"' || fail "video conversion"
echo "ok: video conversion"
x 'apt-get update -qq >/dev/null && apt-get install -y -qq --no-install-recommends libheif-plugin-x265 >/dev/null && heif-enc -q 50 -o /tmp/t.heic /tmp/t.png && chmod a+r /tmp/t.heic' || fail "making a test HEIC"
x 'cd /tmp && setpriv --reuid=99 --regid=100 --clear-groups sh -c "heif-dec t.heic back.png && test -s back.png"' || fail "HEIC conversion"
echo "ok: HEIC conversion"
# Sticker OCR: made-up stickers with text (a font for that only in this test container), read by the
# real models. Transparent with outlined white text; yellow text on a busy picture; an animated WebP
# (read through webpmux); and one without text.
x 'apt-get install -y -qq --no-install-recommends fonts-dejavu-core >/dev/null' || fail "installing a test font"
F=/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf
x "cd /tmp && ffmpeg -v error -y -f lavfi -i color=c=black@0.0:s=512x512,format=rgba -vf \"drawtext=fontfile=$F:text='NEE JOH':fontsize=96:fontcolor=white:borderw=7:bordercolor=black:x=(w-tw)/2:y=h-th-40\" -frames:v 1 -c:v libwebp -lossless 1 s1.webp \
  && ffmpeg -v error -y -f lavfi -i testsrc2=s=512x512 -vf \"drawtext=fontfile=$F:text='GOEDEMORGEN':fontsize=64:fontcolor=yellow:borderw=4:bordercolor=black:x=(w-tw)/2:y=60\" -frames:v 1 -c:v libwebp s2.webp \
  && ffmpeg -v error -y -f lavfi -i color=c=black@0.0:s=512x512:r=5:d=0.6,format=rgba -vf \"drawtext=fontfile=$F:text='HAHA':fontsize=120:fontcolor=white:borderw=8:bordercolor=black:x=(w-tw)/2:y=(h-th)/2\" -c:v libwebp -lossless 1 -loop 0 s3.webp \
  && ffmpeg -v error -y -f lavfi -i testsrc2=s=512x512 -frames:v 1 -c:v libwebp s4.webp && chmod a+r s*.webp" || fail "making test stickers"
out=$(x 'cd /tmp && setpriv --reuid=99 --regid=100 --clear-groups node /app/server/dist/ocr-cli.js s1.webp s2.webp s3.webp s4.webp')
echo "$out"
echo "$out" | grep 's1.webp' | grep -qi 'nee' || fail "OCR: NEE JOH not read"
echo "$out" | grep 's1.webp' | grep -qi 'joh' || fail "OCR: NEE JOH not read"
echo "$out" | grep 's2.webp' | grep -qi 'goedemorgen' || fail "OCR: GOEDEMORGEN not read"
echo "$out" | grep 's3.webp' | grep -qi 'haha' || fail "OCR: animated HAHA not read"
echo "ok: sticker OCR"
docker logs "$NAME" 2>&1 | grep -i "ocr\|sticker" || true

docker rm -f "$NAME" >/dev/null
echo "image smoke test passed"
