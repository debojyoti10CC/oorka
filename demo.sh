#!/usr/bin/env bash
# One command local demo: anvil chain + Oorka deploy + frontend.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
PORT_RPC=8545

command -v forge >/dev/null || { echo "Foundry not found. Install: curl -L https://foundry.paradigm.xyz | bash && foundryup"; exit 1; }
command -v npm >/dev/null || { echo "Node.js (npm) not found. Install Node 18+."; exit 1; }

if [ ! -d "$ROOT/contracts/lib/v4-periphery" ]; then
  echo "Installing Uniswap v4 dependencies…"
  (cd "$ROOT/contracts" && forge install Uniswap/v4-periphery@c6e4754dab11bd38c6f08ac51c3c868569e93d64 --no-git)
fi
if [ ! -d "$ROOT/contracts/lib/forge-std" ]; then
  (cd "$ROOT/contracts" && forge install foundry-rs/forge-std --no-git)
fi
if [ ! -d "$ROOT/contracts/lib/reactive-lib" ]; then
  (cd "$ROOT/contracts" && forge install Reactive-Network/reactive-lib --no-git)
fi

echo "Starting anvil on :$PORT_RPC"
pkill -f "anvil --port $PORT_RPC" 2>/dev/null || true
anvil --port $PORT_RPC --silent &
ANVIL_PID=$!
trap 'kill $ANVIL_PID 2>/dev/null || true' EXIT
sleep 2

echo "Building and deploying contracts"
(cd "$ROOT/contracts" && mkdir -p deployments && forge build >/dev/null && \
  forge script script/DeployLocal.s.sol --rpc-url http://127.0.0.1:$PORT_RPC --broadcast >/dev/null)

PY="$(command -v python3 || command -v python)"
"$PY" "$ROOT/scripts/export_abi.py"
mkdir -p "$ROOT/frontend/public"
cp "$ROOT/contracts/deployments/local.json" "$ROOT/frontend/public/deployments.json"

echo "Starting the frontend"
cd "$ROOT/frontend"
[ -d node_modules ] || npm install --no-audit --no-fund
echo ""
echo "  Open http://localhost:5173"
echo ""
npx vite --port 5173
