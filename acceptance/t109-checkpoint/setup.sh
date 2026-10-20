#!/bin/sh
# A task-local environment for the T-109 example in ENV_DIR. Nothing is
# installed elsewhere; uv's cache is UV_CACHE_DIR, by default beside ENV_DIR.
#
#   setup.sh ENV_DIR            install exactly PINS below: CPU PyTorch,
#                               Lightning 2.5.0 and the versions they were
#                               resolved with, and nothing else (--no-deps)
#   setup.sh ENV_DIR --resolve  resolve afresh from the top-level pins and print
#                               the result, to update PINS from
#
# Either way it fails if a CUDA package (nvidia-*, triton) is installed.
set -eu
ENV=$(realpath -m "$1")
CPU=https://download.pytorch.org/whl/cpu
# Resolved by --resolve on Python 3.12. lightning 2.5.0 requires
# pytorch-lightning without a version; it is kept at the same release.
PINS='aiohappyeyeballs==2.7.1
aiohttp==3.14.5
aiosignal==1.4.0
attrs==26.1.0
filelock==3.32.3
frozenlist==1.8.0
fsspec==2025.12.0
idna==3.20
jinja2==3.1.6
lightning==2.5.0
lightning-utilities==0.15.3
markupsafe==3.0.3
mpmath==1.3.0
multidict==7.1.0
networkx==3.6.1
numpy==2.5.4
packaging==24.2
propcache==0.5.4
pytorch-lightning==2.5.0
pyyaml==6.0.3
setuptools==78.1.0
sympy==1.13.1
torch==2.5.1+cpu
torchmetrics==1.9.0
tqdm==4.70.1
typing-extensions==4.16.0
yarl==1.25.1'
test ! -e "$ENV" || { echo "exists: $ENV"; exit 9; }
export UV_CACHE_DIR="${UV_CACHE_DIR:-$ENV.uv-cache}" UV_PYTHON_DOWNLOADS=never
uv venv --python python3.12 "$ENV"
if [ "${2:-}" = --resolve ]; then
  uv pip install --python "$ENV/bin/python" --index-url "$CPU" 'torch==2.5.1+cpu'
  # lightning 2.5.0 requires pytorch-lightning without a version; keep it the same release.
  uv pip install --python "$ENV/bin/python" 'lightning==2.5.0' 'pytorch-lightning==2.5.0'
else
  # torch's +cpu build is only on the CPU index; every other pin is on PyPI.
  printf '%s\n' "$PINS" > "$ENV/requirements.lock"
  uv pip install --python "$ENV/bin/python" --no-deps --index-strategy unsafe-best-match \
    --index-url https://pypi.org/simple --extra-index-url "$CPU" -r "$ENV/requirements.lock"
fi
uv pip freeze --python "$ENV/bin/python" > "$ENV/freeze.txt"
cat "$ENV/freeze.txt"
if grep -iE '^(nvidia-|triton)' "$ENV/freeze.txt"; then echo "CUDA packages were installed"; exit 1; fi
"$ENV/bin/python" -c 'import torch, lightning; print("torch", torch.__version__, "lightning", lightning.__version__, "cuda", torch.cuda.is_available())'
