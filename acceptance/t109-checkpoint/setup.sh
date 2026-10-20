#!/bin/sh
# A task-local environment for the T-109 example: CPU PyTorch and Lightning
# 2.5.0 in ENV_DIR, with uv's cache beside it. Nothing is installed elsewhere.
# Usage: setup.sh ENV_DIR
set -eu
ENV=$(realpath -m "$1")
test ! -e "$ENV" || { echo "exists: $ENV"; exit 9; }
export UV_CACHE_DIR="$ENV.uv-cache" UV_PYTHON_DOWNLOADS=never
uv venv --python python3.12 "$ENV"
uv pip install --python "$ENV/bin/python" --index-url https://download.pytorch.org/whl/cpu 'torch==2.5.1+cpu'
uv pip install --python "$ENV/bin/python" 'lightning==2.5.0'
"$ENV/bin/python" -c 'import torch, lightning; print("torch", torch.__version__, "lightning", lightning.__version__, "cuda", torch.cuda.is_available())'
