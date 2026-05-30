#!/usr/bin/env bash
set -euo pipefail

: "${R2_S3_ENDPOINT:?R2_S3_ENDPOINT must be set, for example https://<account-id>.r2.cloudflarestorage.com}"
: "${AWS_ACCESS_KEY_ID:?AWS_ACCESS_KEY_ID must be set}"
: "${AWS_SECRET_ACCESS_KEY:?AWS_SECRET_ACCESS_KEY must be set}"

if ! command -v aws >/dev/null 2>&1; then
  echo "aws CLI is required for R2 cleanup." >&2
  exit 1
fi

if [[ $# -ne 2 ]]; then
  echo "Usage: clear-r2-prefix.sh <bucket> <prefix>" >&2
  exit 2
fi

bucket="$1"
prefix="${2#/}"
prefix="${prefix%/}"

if [[ -z "$bucket" || -z "$prefix" ]]; then
  echo "Bucket and non-empty prefix are required." >&2
  exit 2
fi

echo "Removing r2://$bucket/$prefix/"
aws s3 rm "s3://$bucket/$prefix/" \
  --recursive \
  --endpoint-url "$R2_S3_ENDPOINT" \
  --region "${AWS_DEFAULT_REGION:-auto}" \
  --only-show-errors
