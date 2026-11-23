#!/usr/bin/env bash
# Mirror the repo-root codex_ctl.py into plugin/ for standalone installs.
#
# The plugin prefers the repo-root script when it exists, so the CLI and the UI always
# share one implementation. The vendored copy exists only for `npm pack` consumers who
# receive plugin/ without the rest of the repo.
set -euo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cp "$root/codex_ctl.py" "$root/plugin/codex_ctl.py"
echo "synced codex_ctl.py -> plugin/codex_ctl.py"
