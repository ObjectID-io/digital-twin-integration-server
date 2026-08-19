#!/usr/bin/env sh
set -eu

required="PACKAGE_ID SUBSCRIPTION_ADMIN_CAP_ID CUSTOMER_ID CUSTOMER_CONTROLLER_ID INTEGRATION_CONTROLLER_ID PLAN"
for name in $required; do
  eval "value=\${$name:-}"
  if [ -z "$value" ]; then echo "Missing required environment variable: $name" >&2; exit 1; fi
done

case "$PLAN" in
  base) plan_code=1 ;;
  advanced) plan_code=2 ;;
  pro) plan_code=3 ;;
  enterprise) plan_code=4 ;;
  *) echo "PLAN must be base, advanced, pro or enterprise" >&2; exit 1 ;;
esac

period_start_ms="${PERIOD_START_MS:-$(($(date +%s) * 1000))}"
period_end_ms="${PERIOD_END_MS:-$(($(date -d '+30 days' +%s) * 1000))}"
enterprise_twin_limit="${ENTERPRISE_TWIN_LIMIT:-0}"
enterprise_credit_limit="${ENTERPRISE_CREDIT_LIMIT:-0}"
gas_budget="${GAS_BUDGET:-100000000}"

result=$(iota client call \
  --package "$PACKAGE_ID" \
  --module oid_twin \
  --function create_customer_subscription \
  --args \
    "$SUBSCRIPTION_ADMIN_CAP_ID" \
    "$CUSTOMER_ID" \
    "$CUSTOMER_CONTROLLER_ID" \
    "$INTEGRATION_CONTROLLER_ID" \
    "$plan_code" \
    "$period_start_ms" \
    "$period_end_ms" \
    "$enterprise_twin_limit" \
    "$enterprise_credit_limit" \
    0x6 \
  --gas-budget "$gas_budget" \
  --json)

printf '%s\n' "$result"
subscription_id=$(printf '%s' "$result" | jq -r '.objectChanges[]? | select(.objectType | endswith("::oid_twin::SubscriptionAccount")) | .objectId' | head -n 1)
if [ -z "$subscription_id" ] || [ "$subscription_id" = "null" ]; then
  echo "Transaction completed but no SubscriptionAccount was found in objectChanges" >&2
  exit 1
fi

network="${IOTA_NETWORK:-testnet}"
owner_did="did:iota:${network}:${CUSTOMER_CONTROLLER_ID}"
api_key_credential="${TENANT_API_KEY_CREDENTIAL:-DTIS_TENANT_API_KEY}"
echo
echo "SubscriptionAccount: $subscription_id"
echo "Add this entry to DTIS_TENANTS_JSON:"
jq -n \
  --arg tenantId "$CUSTOMER_ID" \
  --arg customerId "$CUSTOMER_ID" \
  --arg ownerDid "$owner_did" \
  --arg subscriptionId "$subscription_id" \
  --arg apiKeyCredential "$api_key_credential" \
  '{tenantId:$tenantId,customerId:$customerId,ownerDid:$ownerDid,subscriptionId:$subscriptionId,apiKeyCredential:$apiKeyCredential}'
