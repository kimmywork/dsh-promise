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

1. Install the package into the profile (run this yourself).
   dsh-promise is a bundle (package.json -> dsh.bundle), so after this it shows
   up in the sidebar 插件 page as an installed bundle you can toggle:

     cd "$PROFILE_DIR"
     pnpm add --force "file:$PKG_DIR"

   Restart DSH, open 插件 -> 已安装插件 -> dsh-promise, then turn it on.
   (Without restart, the plugin manager may not see the new bundle manifest.)

2. Manual alternative (skip the 插件 page and enable by YAML):

   Add "dsh-promise" to dsh.profile.bundles in $PROFILE_DIR/package.json,
   or paste this row into $PROFILE_DIR/cordis.patch.yml (top-level list):

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
  echo "==> pnpm add --force file:$PKG_DIR (in $PROFILE_DIR)"
  (cd "$PROFILE_DIR" && pnpm add --force "file:$PKG_DIR")
  echo "==> installed. Restart DSH, then enable it in the sidebar 插件 page (or use the YAML fallback above)."
fi
