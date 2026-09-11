#!/bin/sh
set -e

# Headless Chrome needs a real audio sink to render into; PulseAudio provides
# one entirely in software, and ffmpeg reads its monitor source for capture.
# The socket path is pinned via PULSE_SERVER so Chrome and ffmpeg (which both
# inherit this environment) connect to the same daemon regardless of $HOME.
export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/tmp/runtime-$(id -u)}"
mkdir -p "$XDG_RUNTIME_DIR" && chmod 700 "$XDG_RUNTIME_DIR"
export PULSE_SERVER="unix:$XDG_RUNTIME_DIR/pulse/native"
export PULSE_SINK=virtual_speaker

if command -v pulseaudio >/dev/null 2>&1; then
  pulseaudio --daemonize=yes --exit-idle-time=-1 --disallow-exit \
    --realtime=no --high-priority=no --log-target=stderr 2>/tmp/pulseaudio.log \
    || echo "[entrypoint] pulseaudio failed to start; audio capture disabled" >&2
  for i in $(seq 1 40); do pactl info >/dev/null 2>&1 && break; sleep 0.25; done
  pactl load-module module-null-sink sink_name=virtual_speaker sink_properties=device.description=virtual_speaker >/dev/null 2>&1 || true
  pactl set-default-sink virtual_speaker >/dev/null 2>&1 || true
  echo "[entrypoint] pulseaudio sinks:" >&2; pactl list short sinks >&2 || true
else
  echo "[entrypoint] pulseaudio not installed; audio capture disabled" >&2
fi

exec "$@"
