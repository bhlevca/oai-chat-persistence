#!/usr/bin/env bash
# Build and install the OAI Chat extension into VS Code.
set -euo pipefail

cd "$(dirname "$0")"

VERSION=$(node -p "require('./package.json').version")

npm test
bash build_vsix.sh
code --install-extension "oai-chat-persistence-${VERSION}.vsix"
echo "Done. Reload VS Code (Ctrl+Shift+P -> Developer: Reload Window)."
