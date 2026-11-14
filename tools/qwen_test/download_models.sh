#!/usr/bin/env bash
# Download the stable-diffusion.cpp runner and the Qwen-Image-2.1 weights (resumable).
#   bash tools/qwen_test/download_models.sh q4     runner + VAE + vision file + 4-bit model (~12 GB)
#   bash tools/qwen_test/download_models.sh q8     8-bit model and text encoder (~16 GB)
#   bash tools/qwen_test/download_models.sh agent  llama.cpp server + SAM 2.1 weights for agent_edit.py (~1.6 GB)
# Files land in tools/qwen_test/models and tools/qwen_test/bin (both git-ignored).
set -u
here="$(cd "$(dirname "$0")" && pwd)"
mkdir -p "$here/models" "$here/bin" "$here/outputs"
HF=https://huggingface.co
SD=https://github.com/leejet/stable-diffusion.cpp/releases/download/master-1094-3bad892

get() {  # url, destination
  local tries=0
  until curl -L --fail -sS -C - --retry 5 --retry-delay 5 -o "$2" "$1"; do
    rc=$?
    [ $rc -eq 33 ] || [ $rc -eq 22 ] && [ -s "$2" ] && break   # already complete
    tries=$((tries + 1)); [ $tries -ge 5 ] && { echo "FAILED $2"; return 1; }
    sleep 5
  done
  echo "done $(basename "$2") $(du -h "$2" | cut -f1)"
}

case "${1:-q4}" in
  q4)
    get "$SD/sd-master-3bad892-bin-win-cuda12-x64.zip" "$here/bin/sd-win-cuda12.zip" &
    get "$SD/cudart-sd-bin-win-cu12-x64.zip" "$here/bin/cudart-win-cu12.zip" &
    get "$HF/unsloth/Qwen-Image-2.1-FP8/resolve/main/vae/qwen_image_2.1_vae_bf16.safetensors" "$here/models/qwen_image_2.1_vae_bf16.safetensors" &
    get "$HF/unsloth/Qwen3-VL-8B-Instruct-GGUF/resolve/main/mmproj-F16.gguf" "$here/models/Qwen3-VL-8B-Instruct-mmproj-F16.gguf" &
    wait
    get "$HF/unsloth/Qwen-Image-2.1-GGUF/resolve/main/qwen-image-2.1-Q4_K_M.gguf" "$here/models/qwen-image-2.1-Q4_K_M.gguf" &
    get "$HF/unsloth/Qwen3-VL-8B-Instruct-GGUF/resolve/main/Qwen3-VL-8B-Instruct-UD-Q4_K_XL.gguf" "$here/models/Qwen3-VL-8B-Instruct-UD-Q4_K_XL.gguf" &
    wait ;;
  q8)
    get "$HF/unsloth/Qwen-Image-2.1-GGUF/resolve/main/qwen-image-2.1-Q8_0.gguf" "$here/models/qwen-image-2.1-Q8_0.gguf" &
    get "$HF/unsloth/Qwen3-VL-8B-Instruct-GGUF/resolve/main/Qwen3-VL-8B-Instruct-Q8_0.gguf" "$here/models/Qwen3-VL-8B-Instruct-Q8_0.gguf" &
    wait ;;
  agent)   # for agent_edit.py: llama.cpp server (runs Qwen3-VL as a chat model) and SAM 2.1 weights (~1.6 GB)
    LL=https://github.com/ggml-org/llama.cpp/releases/download/b12380
    get "$LL/llama-b12380-bin-win-cuda-12.4-x64.zip" "$here/bin/llama-win-cuda12.zip" &
    get "$LL/cudart-llama-bin-win-cuda-12.4-x64.zip" "$here/bin/llama-cudart-cu12.zip" &
    get "https://dl.fbaipublicfiles.com/segment_anything_2/092824/sam2.1_hiera_large.pt" "$here/models/sam2.1_hiera_large.pt" &
    wait
    mkdir -p "$here/bin/llama"
    unzip -q -o "$here/bin/llama-win-cuda12.zip" -d "$here/bin/llama"
    unzip -q -o "$here/bin/llama-cudart-cu12.zip" -d "$here/bin/llama" ;;
esac
ls -la "$here/models" "$here/bin"
