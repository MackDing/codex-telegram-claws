#!/usr/bin/env bash
set -euo pipefail

CTI_HOME="${CTI_HOME:-$HOME/.codexclaw-bridge}"
CONFIG_FILE="$CTI_HOME/config.env"
EXAMPLE_FILE="$(cd "$(dirname "$0")/.." && pwd)/bridge/claude-to-im/config.env.example"

mkdir -p "$CTI_HOME"/{data,logs,runtime,data/messages}

upsert_kv() {
  local key="$1"
  local value="$2"
  local file="$3"
  local tmp="${file}.tmp"

  awk -v k="$key" -v v="$value" '
    BEGIN { updated = 0 }
    {
      if ($0 ~ ("^" k "=")) {
        print k "=" v
        updated = 1
      } else {
        print $0
      }
    }
    END {
      if (!updated) {
        print k "=" v
      }
    }
  ' "$file" > "$tmp"

  mv "$tmp" "$file"
}

if [ ! -f "$CONFIG_FILE" ]; then
  cp "$EXAMPLE_FILE" "$CONFIG_FILE"
  upsert_kv "CTI_RUNTIME" "codex" "$CONFIG_FILE"
  upsert_kv "CTI_ENABLED_CHANNELS" "feishu" "$CONFIG_FILE"
  upsert_kv "CTI_DEFAULT_WORKDIR" "$(pwd)" "$CONFIG_FILE"
  chmod 600 "$CONFIG_FILE"
  echo "Created $CONFIG_FILE from example."
else
  echo "Config already exists: $CONFIG_FILE"
fi

echo ""
echo "Next steps:"
echo "1) Edit config: ${EDITOR:-vim} $CONFIG_FILE"
echo "   Required for Feishu:"
echo "   - CTI_RUNTIME=codex"
echo "   - CTI_ENABLED_CHANNELS=feishu"
echo "   - CTI_DEFAULT_WORKDIR=$(pwd)"
echo "   - CTI_FEISHU_APP_ID=..."
echo "   - CTI_FEISHU_APP_SECRET=..."
echo "2) Install bridge deps: npm run feishu:install"
echo "3) Start bridge: npm run feishu:start"
echo "4) Check status: npm run feishu:status"
