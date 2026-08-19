#!/usr/bin/env bash
# Vendors the local embedding model (plan C6) into vendor/models/, verified against the
# COMMITTED manifest vendor/models/MANIFEST.sha256.
#
# WHY THIS EXISTS. Embeddings run LOCALLY — the broker's business knowledge must not
# leave her deployment (RA 10173), so the runtime never fetches a model: the embedder
# (crm/src/kb/embedder.ts) sets allowRemoteModels=false and refuses to start without
# these files, naming THIS script as the fix. The weights are ~560MB and are NOT
# committed to git (.gitignore); the manifest is, so what this script installs is exactly
# what was reviewed — a digest mismatch (upstream re-upload, MITM, truncated download)
# fails HARD and installs nothing.
#
# PINNED BY REVISION HASH, never a tag: tags and `main` move; the 40-hex commit below
# cannot. Changing the model or revision means editing BOTH this pin and the manifest,
# together, deliberately.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HF_REPO="Xenova/multilingual-e5-large"
REVISION="00fc3aeb3dbb95842de2ac1961d33c6319acf57b"
DIR_NAME="multilingual-e5-large@${REVISION}"
MODELS_ROOT="${REPO_ROOT}/vendor/models"
MANIFEST="${MODELS_ROOT}/MANIFEST.sha256"
DEST="${MODELS_ROOT}/${DIR_NAME}"

if [[ ! -f "${MANIFEST}" ]]; then
  echo "fetch-embedding-model: manifest not found at ${MANIFEST} — it is committed;" >&2
  echo "a missing manifest means a broken checkout, not a file to regenerate." >&2
  exit 1
fi

# The manifest is the single source of truth for WHICH files make up the model.
FILES=$(grep -E "^[0-9a-f]{64}  ${DIR_NAME}/" "${MANIFEST}" | sed "s|^[0-9a-f]\{64\}  ${DIR_NAME}/||")
if [[ -z "${FILES}" ]]; then
  echo "fetch-embedding-model: no manifest entries for ${DIR_NAME} — pin and manifest disagree." >&2
  exit 1
fi

verify() { # $1 = directory that CONTAINS $DIR_NAME
  (cd "$1" && grep -E "^[0-9a-f]{64}  ${DIR_NAME}/" "${MANIFEST}" | shasum -a 256 -c --status)
}

if [[ -d "${DEST}" ]] && verify "${MODELS_ROOT}"; then
  echo "fetch-embedding-model: ${DIR_NAME} already vendored and verified — nothing to do."
  exit 0
fi

STAGING="$(mktemp -d "${MODELS_ROOT}/.staging.XXXXXX")"
trap 'rm -rf "${STAGING}"' EXIT
mkdir -p "${STAGING}/${DIR_NAME}"

echo "fetch-embedding-model: downloading ${DIR_NAME} (~560MB) from huggingface.co at pinned revision..."
while IFS= read -r rel; do
  mkdir -p "${STAGING}/${DIR_NAME}/$(dirname "${rel}")"
  curl -sSL --fail --retry 3 \
    -o "${STAGING}/${DIR_NAME}/${rel}" \
    "https://huggingface.co/${HF_REPO}/resolve/${REVISION}/${rel}"
done <<< "${FILES}"

echo "fetch-embedding-model: verifying against the committed manifest..."
if ! verify "${STAGING}"; then
  echo "fetch-embedding-model: 🚨 SHA-256 MISMATCH — the downloaded files are NOT the" >&2
  echo "reviewed ones (upstream changed, or the transfer was corrupted/tampered)." >&2
  echo "NOTHING was installed. Do not weaken the manifest; investigate the mismatch." >&2
  exit 1
fi

rm -rf "${DEST}"
mv "${STAGING}/${DIR_NAME}" "${DEST}"
echo "fetch-embedding-model: installed and verified at ${DEST}"
