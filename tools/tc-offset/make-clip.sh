#!/bin/sh
# Testclip für die Zeitcode-Messung: 1280x720, 25 fps, in die oberste Bildzeile ist der Bildzähler N als 16 Balken (je 80 px breit,
# Bit k = Balken k, weiß = 1) eingebrannt. So lässt sich im Bild der Medienposition ablesen, ohne Texterkennung.
# Aufruf: tools/tc-offset/make-clip.sh <ziel.mp4> [sekunden]
set -e
out=${1:?Ziel}
sec=${2:-120}
ffmpeg -y -loglevel error -f lavfi -i "color=c=gray:s=1280x720:r=25:d=$sec" -f lavfi -i "anullsrc=r=48000:cl=stereo" -t "$sec" \
  -vf "format=yuv420p,geq=lum='if(lt(Y,24),255*mod(floor(N/pow(2,floor(X/80))),2),128)':cb=128:cr=128" \
  -c:v libx264 -preset veryfast -crf 14 -g 25 -bf 0 -pix_fmt yuv420p -c:a aac -shortest "$out"
