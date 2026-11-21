#!/usr/bin/env bash
set -euo pipefail

version="${1:?usage: pack.sh <version> [output-dir]}"
out_dir="${2:-dist}"
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
name="r-bots-${version}"

mkdir -p "$out_dir"
out_dir="$(cd "$out_dir" && pwd)"
stage="$(mktemp -d)"
trap 'rm -rf "$stage"' EXIT

mkdir -p "$stage/$name/infra/docker"
bun "$root/scripts/release/render-compose.ts" "$root/compose.yaml" "$stage/$name/compose.yaml" "$version"
cp -R "$root/deploy" "$stage/$name/deploy"
cp "$root/infra/docker/install.sh" "$root/infra/docker/rbots" "$stage/$name/infra/docker/"
chmod 0755 "$stage/$name/infra/docker/install.sh" "$stage/$name/infra/docker/rbots"
printf '%s\n' "$version" > "$stage/$name/VERSION"

tar -C "$stage" --owner=0 --group=0 --numeric-owner -czf "$out_dir/$name.tar.gz" "$name"
cp "$root/install.sh" "$out_dir/install.sh"
(cd "$out_dir" && sha256sum "$name.tar.gz" install.sh > SHA256SUMS)
