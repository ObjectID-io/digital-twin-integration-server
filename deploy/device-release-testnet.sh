#!/bin/sh
set -eu
umask 077
release=device-first-20260908
backup=/root/backups/$release
test ! -e "$backup/sources.tgz"
mkdir -p "$backup"
for directory in digital-twin-integration-server digital-twin-webview objectid-twinscope-demo; do test -f "/root/$directory/Dockerfile"; done
tar -czf "$backup/sources.tgz" --exclude=node_modules --exclude=.git --exclude=graphify-out --exclude=dist --exclude=.cache -C /root digital-twin-integration-server digital-twin-webview objectid-twinscope-demo
tar -czf "$backup/volumes.tgz" -C /var/lib/docker/volumes objectid-digital-twin_command-data/_data objectid-digital-twin-webview_webview-data/_data objectid-twinscope-demo_twinscope-data/_data objectid-digital-twin_mosquitto-config/_data objectid-digital-twin_simulator-data/_data
tar -tzf "$backup/sources.tgz" >/dev/null
tar -tzf "$backup/volumes.tgz" >/dev/null
docker tag objectid/digital-twin-integration-server:v1 objectid/digital-twin-integration-server:pre-device-20260908
docker tag objectid/digital-twin-webview:latest objectid/digital-twin-webview:pre-device-20260908
docker tag objectid/twinscope-demo:latest objectid/twinscope-demo:pre-device-20260908
docker tag objectid/mqtt-digital-twin-simulator:v1 objectid/mqtt-digital-twin-simulator:pre-device-20260908
sha256sum "$backup/sources.tgz" "$backup/volumes.tgz"
tar -xzf /tmp/is-device-release.tgz -C /root/digital-twin-integration-server
tar -xzf /tmp/dt-device-release.tgz -C /root/digital-twin-webview
tar -xzf /tmp/ts-device-release.tgz -C /root/objectid-twinscope-demo
identity=$(docker exec objectid-digital-twin-webview-webview-1 printenv IOTA_IDENTITY_PACKAGE_ID)
test -n "$identity"
docker run --rm -i --network none --user 0 --entrypoint node -e IDENTITY_PACKAGE_ID="$identity" -v /root/digital-twin-integration-server/secrets:/task-secrets objectid/digital-twin-integration-server:pre-device-20260908 --input-type=module < /tmp/configure-device-identity.mjs
printf 'Backup and source staging completed. Mainnet untouched.\n'
