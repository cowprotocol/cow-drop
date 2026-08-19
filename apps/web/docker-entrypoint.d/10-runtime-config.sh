#!/bin/sh
# Write the deployment's configuration into the static bundle, before nginx starts.
#
# The bundle is built once and configured here, so the same image can be promoted between
# environments. Both values are optional: with no KEEPER_URL the page runs keeper-less (the "Hand to
# keeper" button hides itself), and with no RPC_URL it uses its built-in public endpoints.
#
# nginx's entrypoint runs this via `sh`, so keep it POSIX. `set -u` is deliberately not used: these
# variables are expected to be absent.

set -e

escape() {
    # JSON string body: backslashes first, then quotes, then anything that would break out of the line.
    printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g' | tr -d '\n\r'
}

cat > /usr/share/nginx/html/config.js <<CONFIG
window.__COW_DROP_CONFIG__ = {
  keeperUrl: "$(escape "${KEEPER_URL:-}")",
  rpcUrl: "$(escape "${RPC_URL:-}")",
}
CONFIG

# The RPC URL routinely carries an API key in its path, so log only whether one was given.
if [ -n "${RPC_URL:-}" ]; then rpc_state="<set>"; else rpc_state="<unset>"; fi
echo "cow-drop: runtime config written (keeperUrl=${KEEPER_URL:-<unset>}, rpcUrl=$rpc_state)"
