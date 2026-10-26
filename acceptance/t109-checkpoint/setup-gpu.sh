#!/bin/sh
# The GPU stage's task-local environment for the T-109 example in ENV_DIR:
# Lightning 2.5.0 as in setup.sh, with PyTorch 2.7.1 built for CUDA 12.8.
# 2.5.1 has no kernels for compute capability 12.0 (RTX 50 series); 2.7 is
# the first release line that has. Nothing is installed outside ENV_DIR; the
# driver and any system CUDA are not touched (the wheels bring their own
# CUDA libraries, the driver comes from the host).
#
#   setup-gpu.sh ENV_DIR        the CUDA 12.8 build; fails unless torch can
#                               use a visible GPU of this compute capability
#   setup-gpu.sh ENV_DIR --cpu  the same versions as a CPU build, to check
#                               without a GPU that Lightning 2.5.0 still
#                               resumes under torch 2.7.1
#
# Versions other than torch and Lightning are resolved at install time and
# listed in ENV_DIR/freeze.txt.
set -eu
ENV=$(realpath -m "$1")
case "${2:-}" in
  --cpu) TORCH='torch==2.7.1+cpu' INDEX=https://download.pytorch.org/whl/cpu ;;
  '') TORCH='torch==2.7.1+cu128' INDEX=https://download.pytorch.org/whl/cu128 ;;
  *) echo "usage: setup-gpu.sh ENV_DIR [--cpu]"; exit 2 ;;
esac
test ! -e "$ENV" || { echo "exists: $ENV"; exit 9; }
export UV_CACHE_DIR="${UV_CACHE_DIR:-$ENV.uv-cache}" UV_PYTHON_DOWNLOADS=never
uv venv --python python3.12 "$ENV"
uv pip install --python "$ENV/bin/python" --index-url "$INDEX" "$TORCH"
# lightning 2.5.0 requires pytorch-lightning without a version; keep it the same release.
uv pip install --python "$ENV/bin/python" 'lightning==2.5.0' 'pytorch-lightning==2.5.0'
uv pip freeze --python "$ENV/bin/python" > "$ENV/freeze.txt"
cat "$ENV/freeze.txt"
grep -qx "$TORCH" "$ENV/freeze.txt" || { echo "torch is not $TORCH"; exit 1; }
if [ "${2:-}" = --cpu ]; then
  if grep -iE '^(nvidia-|triton)' "$ENV/freeze.txt"; then echo "CUDA packages were installed"; exit 1; fi
  "$ENV/bin/python" -c 'import torch, lightning; print("torch", torch.__version__, "lightning", lightning.__version__)'
else
  "$ENV/bin/python" -c '
import torch, lightning
print("torch", torch.__version__, "lightning", lightning.__version__, "cuda", torch.version.cuda)
assert torch.cuda.is_available(), "torch sees no GPU"
major, minor = torch.cuda.get_device_capability(0)
print("device", torch.cuda.get_device_name(0), "capability", f"{major}.{minor}", "arch list", torch.cuda.get_arch_list())
assert f"sm_{major}{minor}" in torch.cuda.get_arch_list(), "this build has no kernels for the device"
'
fi
