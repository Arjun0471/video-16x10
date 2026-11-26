#!/bin/bash
# Build synthetic test clips + mock YouTube player pages into $1 (default: ./clips).
set -e
OUT="${1:-clips}"; mkdir -p "$OUT"; cd "$OUT"
E="-c:v libvpx-vp9 -deadline realtime -cpu-used 8 -row-mt 1"
# still camera: subject in the middle of a plain wall (seams should go through the wall)
ffmpeg -v error -y -f lavfi -i "color=c=0x6a7480:s=1280x720:r=30:d=8,noise=alls=3:allf=t" \
 -f lavfi -i "testsrc2=s=360x560:r=30:d=8" -f lavfi -i "smptebars=s=150x120:r=30:d=8" \
 -filter_complex "[1]drawgrid=w=40:h=40:t=2:c=black[s];[0][s]overlay=x=460:y=120[a];[a][2]overlay=x='560+60*sin(t*2)':y=560" \
 $E -b:v 2M wall.webm
for v in wall; do
cat > p_$v.html <<HTML
<!doctype html><html><body style="margin:0;background:#222">
<div id="movie_player" class="html5-video-player" style="position:relative;width:1600px;height:1000px;background:#000">
 <div class="html5-video-container" style="position:relative;z-index:10">
  <video class="html5-main-video" src="$v.webm" muted playsinline style="position:absolute;left:0;top:50px;width:1600px;height:900px"></video>
 </div></div></body></html>
HTML
done
echo "clips in $PWD"
