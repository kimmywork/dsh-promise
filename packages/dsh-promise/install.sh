#!/usr/bin/env bash
# Install dsh-promise into a DSH profile without editing the profile for you.
#
#   ./install.sh                          print the steps (local checkout)
#   ./install.sh --from npm               print the steps for the npm package
#   ./install.sh --apply                  install from this checkout (default)
#   ./install.sh --apply --from npm       install dsh-promise from the npm registry
#   ./install.sh --apply --profile web    target a different profile
#
# The script never edits cordis.patch.yml: it prints the exact row to paste.
set -euo pipefail

PKG_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DSH_HOME="${DSH_HOME:-$HOME/.dsh}"
PROFILE_NAME="desktop"
APPLY=0
FROM="file"

usage() {
  sed -n '2,10p' "$0"
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --apply) APPLY=1 ;;
    --from)
      FROM="${2:?missing npm|file value}"
      shift
      ;;
    --from=*)
      FROM="${1#--from=}"
      ;;
    --profile)
      PROFILE_NAME="${2:?missing profile name}"
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "unknown argument: $1" >&2
      exit 2
      ;;
  esac
  shift
done

case "$FROM" in
  npm|file) ;;
  *)
    echo "invalid --from value: $FROM (expected \"npm\" or \"file\")" >&2
    exit 2
    ;;
esac

PROFILE_DIR="$DSH_HOME/profiles/$PROFILE_NAME"

if [[ "$FROM" == "npm" ]]; then
  SOURCE_LINE="  source  : npm registry (@kenpusney/dsh-promise@experimental)"
  INSTALL_CMD='pnpm add --force @kenpusney/dsh-promise@experimental'
  SOURCE_NOTE='   Published on the "experimental" dist-tag; there is no "latest" tag until
   the first stable release, so always pin the tag when installing.'
else
  SOURCE_LINE="  source  : local checkout ($PKG_DIR)"
  INSTALL_CMD="pnpm add --force \"file:$PKG_DIR\""
  SOURCE_NOTE="   Installs this checkout; no registry access is required."
fi

cat <<EOF
@kenpusney/dsh-promise — profile "$PROFILE_NAME"
$SOURCE_LINE
  profile : $PROFILE_DIR

1. Install the package into the profile (run this yourself):
$SOURCE_NOTE

     cd "$PROFILE_DIR"
     $INSTALL_CMD

   @kenpusney/dsh-promise is a bundle (package.json -> dsh.bundle), so after this it shows
   up in the sidebar 插件 page as an installed bundle you can toggle.
   Restart DSH, open 插件 -> 已安装插件 -> dsh-promise, then turn it on.
   (Without restart, the plugin manager may not see the new bundle manifest.)

2. Manual alternative (skip the 插件 page and enable by YAML):

   Add "@kenpusney/dsh-promise" to dsh.profile.bundles in $PROFILE_DIR/package.json,
   or paste this row into $PROFILE_DIR/cordis.patch.yml (top-level list):

  - id: promise
    name: "@kenpusney/dsh-promise"
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
  - If you previously installed the unscoped dsh-promise, remove it first:
    cd "$PROFILE_DIR" && pnpm remove dsh-promise
  - To switch install source: ./install.sh --from npm [--apply], or
    ./install.sh --from file [--apply] (default).
  - Data lives in \$DSH_HOME/promise (ledger.jsonl + snapshot.json).
EOF

if [[ "$APPLY" == "1" ]]; then
  if [[ ! -f "$PROFILE_DIR/package.json" ]]; then
    echo "profile has no package.json: $PROFILE_DIR" >&2
    exit 1
  fi
  echo
  if [[ "$FROM" == "npm" ]]; then
    echo "==> pnpm add --force @kenpusney/dsh-promise@experimental (in $PROFILE_DIR)"
    (cd "$PROFILE_DIR" && pnpm add --force @kenpusney/dsh-promise@experimental)
  else
    echo "==> pnpm add --force file:$PKG_DIR (in $PROFILE_DIR)"
    (cd "$PROFILE_DIR" && pnpm add --force "file:$PKG_DIR")
  fi
  echo "==> installed. Restart DSH, then enable it in the sidebar 插件 page (or use the YAML fallback above)."
fi
