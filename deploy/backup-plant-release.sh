#!/bin/sh
set -eu
umask 077
backup=/root/backups/plant-release-20260907
mkdir -p "$backup"
test ! -e "$backup/sources.tgz"
tar -czf "$backup/sources.tgz" --exclude=node_modules --exclude=.git --exclude=graphify-out --exclude=dist --exclude=.cache -C /root digital-twin-integration-server digital-twin-integration-server-mainnet digital-twin-webview digital-twin-webview-mainnet objectid-twinscope-demo
tar -czf "$backup/volumes.tgz" -C /var/lib/docker/volumes objectid-digital-twin_command-data/_data objectid-digital-twin-integration-mainnet_command-data/_data objectid-digital-twin-webview_webview-data/_data objectid-digital-twin-mainnet_webview-data/_data objectid-twinscope-demo_twinscope-data/_data objectid-digital-twin_mosquitto-config/_data objectid-digital-twin-integration-mainnet_mosquitto-config/_data
docker tag objectid/digital-twin-integration-server:v1 objectid/digital-twin-integration-server:pre-plant-20260907-testnet
docker tag objectid/digital-twin-integration-server:mainnet objectid/digital-twin-integration-server:pre-plant-20260907-mainnet
docker tag objectid/digital-twin-webview:latest objectid/digital-twin-webview:pre-plant-20260907-testnet
docker tag objectid/digital-twin-webview:mainnet objectid/digital-twin-webview:pre-plant-20260907-mainnet
docker tag objectid/twinscope-demo:latest objectid/twinscope-demo:pre-plant-20260907
sha256sum "$backup/sources.tgz" "$backup/volumes.tgz"
tar -tzf "$backup/volumes.tgz" >/dev/null
printf 'Backup verified: %s\n' "$backup"
