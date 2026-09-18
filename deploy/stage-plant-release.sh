#!/bin/sh
set -eu
umask 077
backup=/root/backups/plant-release-20260907
test -s "$backup/sources.tgz"
test -s "$backup/volumes.tgz"
for root in /root/digital-twin-integration-server /root/digital-twin-integration-server-mainnet; do
  test -f "$root/Dockerfile"
  tar -xzf /tmp/is-plant-release.tgz -C "$root"
done
for root in /root/digital-twin-webview /root/digital-twin-webview-mainnet; do
  test -f "$root/Dockerfile"
  tar -xzf /tmp/dt-plant-release.tgz -C "$root"
  cp /tmp/dt-plant-App.jsx "$root/src/App.jsx"
done
tar -xzf /tmp/ts-plant-release.tgz -C /root/objectid-twinscope-demo
docker run --rm -i --network none --user 0 --entrypoint node \
  -v /root/digital-twin-integration-server-mainnet/secrets:/task-secrets \
  objectid/digital-twin-integration-server:mainnet --input-type=module < /tmp/configure-plant-key.mjs
cp /root/digital-twin-integration-server-mainnet/secrets/credentials.json "$backup/mainnet-credentials-with-plant-key.json"
chmod 600 "$backup/mainnet-credentials-with-plant-key.json"
sha256sum /tmp/is-plant-release.tgz /tmp/dt-plant-release.tgz /tmp/ts-plant-release.tgz /tmp/dt-plant-App.jsx > "$backup/release-sha256.txt"
printf 'Source release staged; runtime containers not yet changed.\n'
