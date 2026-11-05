#!/bin/bash
#SBATCH --job-name=volume_viewer_build
#SBATCH --partition=minilab-cpu
#SBATCH --cpus-per-task=2
#SBATCH --mem=8G
#SBATCH --time=12:00:00
#SBATCH --output=/midtier/paetzollab/scratch/ads4015/vscode-volume-viewer/logs/build_%j.out

set -euo pipefail
cd /midtier/paetzollab/scratch/ads4015/vscode-volume-viewer

module load node-js/22.4.0-gnnohjy
# The spack node module is built --without-npm, so fetch npm into the project.
NPM_DIR=/midtier/paetzollab/scratch/ads4015/vscode-volume-viewer/.tools/npm
if [ ! -f "$NPM_DIR/bin/npm-cli.js" ]; then
  echo "== fetching npm"
  mkdir -p "$NPM_DIR"
  curl -sSL -m 120 https://registry.npmjs.org/npm/-/npm-10.8.2.tgz | tar -xz -C "$NPM_DIR" --strip-components=1
fi
npm() { node "$NPM_DIR/bin/npm-cli.js" "$@"; }
npx() { node "$NPM_DIR/bin/npx-cli.js" "$@"; }
echo "node: $(node -v)  npm: $(npm -v)  host: $(hostname)"

echo "== npm install"
npm install --no-audit --no-fund

echo "== niivue API check"
grep -rn "loadFromArrayBuffer" node_modules/@niivue/niivue --include=*.d.ts | head -5 || echo "loadFromArrayBuffer not found in d.ts"

echo "== icon"
/midtier/paetzollab/scratch/ads4015/conda/envs/monai-env1/bin/python scripts/make_icon.py docs/icon_source.png media/icon.png

echo "== typecheck"
npx tsc -p tsconfig.json

echo "== bundle"
npm run build
ls -la dist

echo "== package"
npm run package
ls -la vscode-volume-viewer.vsix
echo "BUILD OK"
