#!/bin/sh
set -e

# Headless Chrome needs a real audio sink to render into; PulseAudio provides
# one entirely in software, and ffmpeg reads its monitor source for capture.
pulseaudio -D --exit-idle-time=-1 --disallow-exit --disallow-module-loading=0 --log-target=stderr 2>/var/log/pulseaudio.log || true
for i in $(seq 1 20); do pactl info >/dev/null 2>&1 && break; sleep 0.25; done
pactl load-module module-null-sink sink_name=virtual_speaker sink_properties=device.description=virtual_speaker >/dev/null 2>&1 || true
pactl set-default-sink virtual_speaker >/dev/null 2>&1 || true

exec "$@"
