#!/bin/sh
set -eu

runtime_secrets=/tmp/objectid-simulator-secrets
mkdir -p "$runtime_secrets"
cp "${MQTT_PASSWORD_FILE:-/run/secrets/mqtt_password}" "$runtime_secrets/mqtt_password"
cp "${SIM_CONTROL_PASSWORD_FILE:-/run/secrets/sim_control_password}" "$runtime_secrets/sim_control_password"
chown -R simulator:simulator "$runtime_secrets"
chmod 0400 "$runtime_secrets/mqtt_password" "$runtime_secrets/sim_control_password"

export MQTT_PASSWORD_FILE="$runtime_secrets/mqtt_password"
export SIM_CONTROL_PASSWORD_FILE="$runtime_secrets/sim_control_password"
exec su-exec simulator "$@"
