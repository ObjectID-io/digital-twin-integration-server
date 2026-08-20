#!/bin/sh
set -eu

mosquitto -c /mosquitto/config/mosquitto.conf &
broker_pid=$!
trap 'kill -TERM "$broker_pid" 2>/dev/null || true' TERM INT

fingerprint() {
  cksum /mosquitto/config/password_file /mosquitto/config/acl_file 2>/dev/null | cksum | awk '{print $1":"$2}'
}

previous="$(fingerprint)"
while kill -0 "$broker_pid" 2>/dev/null; do
  sleep 2
  current="$(fingerprint)"
  if [ "$current" != "$previous" ]; then
    kill -HUP "$broker_pid"
    previous="$current"
  fi
done
wait "$broker_pid"
