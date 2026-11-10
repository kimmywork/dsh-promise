#!/usr/bin/env bash
# Install dsh-promise into a DSH profile without editing the profile for you.
#
#   ./install.sh                      print the steps
#   ./install.sh --apply              run `pnpm add file:<this package>` in the profile
#   ./install.sh --apply --profile web
#
# The script never edits cordis.patch.yml: it prints the exact row to paste.
set -euo pipefail

PKG_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DSH_HOME="${DSH_HOME:-$HOME/.dsh}"
PROFILE_NAME="desktop"
APPLY=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --apply) APPLY=1 ;;
    --profile) PROFILE_NAME="${2:?missing profile name}"; shift ;;
    -h|--help)
      sed -n '2,8p' "$0"
      exit 0
      ;;
    *)
      echo "unknown argument: $1" >&2
      exit 2
      ;;
  esac
  shift
done

PROFILE_DIR="$DSH_HOME/profiles/$PROFILE_NAME"

cat <<EOF
dsh-promise — profile "$PROFILE_NAME"
  package : $PKG_DIR
  profile : $PROFILE_DIR

1. Install the package into the profile (run this yourself):

     cd "$PROFILE_DIR"
     pnpm add "file:$PKG_DIR"

2. Add this row to $PROFILE_DIR/cordis.patch.yml (top-level list):

  - id: promise
    name: dsh-promise
    config:
      enabled: true
      jev:
        enabled: true
        apiKeyEnv: TYPESAFE_API_KEY
        model: jev-1.14.0

3. Provide the key to the DSH process (not to this script):

     export TYPESAFE_API_KEY=...        # or put it in the app environment

4. Restart DSH. Then ask the agent to call promise_inspect; it should report
   "promises: 0" and no errors. Declare a few promises, run work, and check
   promise_inspect({what:"trust"}).

Notes
  - Without TYPESAFE_API_KEY the plugin runs L1-only and logs one warning.
  - Model-declared shell checks are inert until checks.allowModelDeclared=true.
  - Data lives in \$DSH_HOME/promise (ledger.jsonl + snapshot.json).
EOF

if [[ "$APPLY" == "1" ]]; then
  if [[ ! -f "$PROFILE_DIR/package.json" ]]; then
    echo "profile has no package.json: $PROFILE_DIR" >&2
    exit 1
  fi
  echo
  echo "==> pnpm add file:$PKG_DIR (in $PROFILE_DIR)"
  (cd "$PROFILE_DIR" && pnpm add "file:$PKG_DIR")
  echo "==> installed. Paste the cordis.patch.yml row above, then restart DSH."
fi
