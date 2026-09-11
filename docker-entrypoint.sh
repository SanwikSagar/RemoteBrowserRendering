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
  # -n skips the stock default.pa, which probes ALSA/udev hardware that does not
  # exist in a container and can abort startup. Load only what capture needs.
  pulseaudio --daemonize=yes --exit-idle-time=-1 --disallow-exit \
    --realtime=no --high-priority=no --log-target=stderr -n \
    -L "module-native-protocol-unix auth-anonymous=1 socket=$XDG_RUNTIME_DIR/pulse/native" \
    -L "module-null-sink sink_name=virtual_speaker sink_properties=device.description=virtual_speaker" \
    -L "module-always-sink" \
    2>/tmp/pulseaudio.log \
    || { echo "[entrypoint] pulseaudio failed to start; audio capture disabled" >&2; cat /tmp/pulseaudio.log >&2; }
  for i in $(seq 1 40); do pactl info >/dev/null 2>&1 && break; sleep 0.25; done
  pactl set-default-sink virtual_speaker >/dev/null 2>&1 || true
  echo "[entrypoint] pulseaudio sources:" >&2; pactl list short sources >&2 || true
else
  echo "[entrypoint] pulseaudio not installed; audio capture disabled" >&2
fi

exec "$@"
