#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export PI_HUMANIZE="${PI_HUMANIZE:-1}"
exec "$SCRIPT_DIR/pi-test.sh" "$@"
