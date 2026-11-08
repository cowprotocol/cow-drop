#!/usr/bin/env bash
#
# Verify every contract recorded in deployments/gen$GEN/<chainId>.json.
#
#   script/verify.sh              # every chain that has a deployments file
#   script/verify.sh 1 8453       # only these chains
#   DRY_RUN=1 script/verify.sh    # print what would be submitted, submit nothing
#
# Needs ETHERSCAN_API_KEY: one Etherscan v2 key covers every supported chain.
#
# `forge script --verify --resume` only verifies what is in that chain's run-latest.json,
# and the deploy script skips any contract that already has code — so a contract deployed
# in an earlier run is never resubmitted. This reads the deployments file instead, which
# records every address regardless of which run put it there.
#
# Each address is CREATE2 with a zero salt, so before submitting anything this recomputes
# the address from the local build and the constructor args below. A mismatch means the
# local source, the compiler settings or the args differ from what is on chain; such a
# contract is reported and skipped rather than submitted to fail at the explorer.

set -uo pipefail
cd "$(dirname "$0")/.."

GEN=${GEN:-2}
DEPLOY_DIR="deployments/gen$GEN"
CREATE2_DEPLOYER=0x4e59b44847b379578588920cA78FbF26c0B4956C
SALT=0x0000000000000000000000000000000000000000000000000000000000000000

# From script/DropConfig.sol. The deployments file does not record these, and `deploy()`
# lets three of them be overridden per chain, so override them here the same way if a
# chain was deployed that way. The CREATE2 check below catches it if you forget.
VAULT_RELAYER=0xC92E8bdf79f0507f65a392b0ab4667716BFE0110
TWAP_HANDLER=${TWAP_HANDLER:-0x6cF1e9cA41f7611dEf408122793c358a3d11E5a5}
TIMESTAMP_FACTORY=${TIMESTAMP_FACTORY:-0x52eD56Da04309Aca4c3FECC595298d80C2f16BAc}
STOP_LOSS_HANDLER=${STOP_LOSS_HANDLER:-0x412c36e5011CD2517016D243a2dfB37f73A242E7}

lower() { printf '%s' "$1" | tr '[:upper:]' '[:lower:]'; }

# Recorded for reference, but CoW's contracts rather than ours — nothing here to verify.
EXTERNAL="settlement composableCow"

ok=0; already=0; skipped=0; failed=0

# verify <jsonKey> <path:Name> <constructorArgTypes> [argValues...]
verify() {
  key=$1; target=$2; sig=$3; shift 3
  handled="$handled $key"

  addr=$(jq -r --arg k "$key" '.[$k] // empty' "$FILE")
  if [ -z "$addr" ]; then
    printf '  %-18s not in %s, skipping\n' "$key" "$FILE"; skipped=$((skipped + 1)); return
  fi

  args=""
  if [ -n "$sig" ]; then
    args=$(cast abi-encode "constructor($sig)" "$@") || { printf '  %-18s could not encode args\n' "$key"; failed=$((failed + 1)); return; }
  fi

  # The recorded address must be the CREATE2 address of exactly what we are about to submit.
  init=$(forge inspect "$target" bytecode 2>/dev/null)
  if [ -z "$init" ]; then
    printf '  %-18s %s  no local build for %s\n' "$key" "$addr" "$target"; failed=$((failed + 1)); return
  fi
  hash=$(cast keccak "${init}${args#0x}")
  computed=$(cast create2 --deployer "$CREATE2_DEPLOYER" --salt "$SALT" --init-code-hash "$hash" | awk '{print $1}')
  if [ "$(lower "$computed")" != "$(lower "$addr")" ]; then
    printf '  %-18s %s  MISMATCH: local build is %s, skipping\n' "$key" "$addr" "$computed"
    skipped=$((skipped + 1)); return
  fi

  if [ -n "${DRY_RUN:-}" ]; then
    printf '  %-18s %s  would verify %s%s\n' "$key" "$addr" "$target" "${args:+ --constructor-args $args}"
    ok=$((ok + 1)); return
  fi

  set -- "$addr" "$target" --chain "$CHAIN" --watch
  [ -n "$args" ] && set -- "$@" --constructor-args "$args"
  out=$(forge verify-contract "$@" 2>&1)

  if printf '%s' "$out" | grep -qi "already verified"; then
    printf '  %-18s %s  already verified\n' "$key" "$addr"; already=$((already + 1))
  elif printf '%s' "$out" | grep -qi "successfully verified"; then
    printf '  %-18s %s  verified\n' "$key" "$addr"; ok=$((ok + 1))
  else
    printf '  %-18s %s  FAILED\n' "$key" "$addr"
    printf '%s\n' "$out" | sed 's/^/      /'
    failed=$((failed + 1))
  fi
}

if [ $# -gt 0 ]; then
  CHAINS="$*"
else
  CHAINS=$(ls "$DEPLOY_DIR"/*.json 2>/dev/null | xargs -n1 basename | sed 's/\.json$//')
fi
[ -n "$CHAINS" ] || { echo "no deployments found in $DEPLOY_DIR" >&2; exit 1; }

if [ -z "${DRY_RUN:-}" ] && [ -z "${ETHERSCAN_API_KEY:-}" ]; then
  echo "ETHERSCAN_API_KEY is not set" >&2; exit 1
fi

build_log=$(forge build 2>&1) || { printf '%s\n' "$build_log" >&2; exit 1; }

for CHAIN in $CHAINS; do
  FILE="$DEPLOY_DIR/$CHAIN.json"
  if [ ! -f "$FILE" ]; then echo "no $FILE" >&2; failed=$((failed + 1)); continue; fi
  echo "chain $CHAIN (generation $GEN)"
  handled=""

  SETTLEMENT=$(jq -r '.settlement' "$FILE")
  COMPOSABLE_COW=$(jq -r '.composableCow' "$FILE")
  EXECUTOR=$(jq -r '.executor' "$FILE")
  FACTORY=$(jq -r '.factory' "$FILE")
  IMPL=$(jq -r '.shedImplementation' "$FILE")

  verify shedImplementation lib/cow-shed/src/COWShedWithExecutorSigner.sol:COWShedWithExecutorSigner ""
  verify factory            lib/cow-shed/src/COWShedExecutorFactory.sol:COWShedExecutorFactory       "address" "$IMPL"
  verify guardSteps         src/steps/GuardSteps.sol:GuardSteps                                      ""
  verify tokenSteps         src/steps/TokenSteps.sol:TokenSteps                                      ""
  verify presignSteps       src/steps/PresignSteps.sol:PresignSteps     "address,address"            "$SETTLEMENT" "$VAULT_RELAYER"
  verify twapSteps          src/steps/TwapSteps.sol:TwapSteps           "address,address,address,address" "$VAULT_RELAYER" "$COMPOSABLE_COW" "$TWAP_HANDLER" "$TIMESTAMP_FACTORY"
  verify executor           src/DropExecutor.sol:DropExecutor           "address,address"            "$FACTORY" "$COMPOSABLE_COW"
  verify stopLossSteps      src/steps/StopLossSteps.sol:StopLossSteps   "address,address,address"    "$VAULT_RELAYER" "$COMPOSABLE_COW" "$STOP_LOSS_HANDLER"
  verify paymentSteps       src/steps/PaymentSteps.sol:PaymentSteps     "address,address,address"    "$SETTLEMENT" "$VAULT_RELAYER" "$EXECUTOR"
  verify convertSteps       src/steps/ConvertSteps.sol:ConvertSteps     "address,address,address"    "$SETTLEMENT" "$VAULT_RELAYER" "$EXECUTOR"
  verify cowOrderPoster     src/CowOrderPoster.sol:CowOrderPoster       "address"                    "$SETTLEMENT"
  verify bungeeReceiver     src/bridge/DropBungeeReceiver.sol:DropBungeeReceiver "address"           "$EXECUTOR"

  # The list above is written by hand, so a contract added to Deploy.s.sol and not to it would be
  # skipped in silence — which is how convertSteps went unverified. Say so instead.
  for key in $(jq -r 'to_entries[] | select(.value | type == "string" and startswith("0x")) | .key' "$FILE"); do
    case " $handled $EXTERNAL " in
      *" $key "*) ;;
      *) printf '  %-18s recorded in %s but this script has no entry for it\n' "$key" "$FILE"
         failed=$((failed + 1)) ;;
    esac
  done
  echo
done

echo "verified $ok, already verified $already, skipped $skipped, failed $failed"
[ "$failed" -eq 0 ]
