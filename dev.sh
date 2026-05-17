#!/usr/bin/env bash
# Build and install the OAI Chat extension into VS Code.
set -euo pipefail

cd "$(dirname "$0")"

bash build_vsix.sh
code --install-extension oai-chat-persistence-0.1.0.vsix
echo "Done. Reload VS Code (Ctrl+Shift+P -> Developer: Reload Window)."
