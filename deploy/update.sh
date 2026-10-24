#!/usr/bin/env bash
# Run on the server. All code changes originate in local Git commits.
set -euo pipefail
project_root=${EXOMEM_ROOT:-/opt/exomem}
git_image=docker.io/library/node:24-bookworm@sha256:f9b3548b20b15b705b66aeecaeac7dd690c73d5e4661357aac02e60e3d38c88a
export HTTP_PROXY=${HTTP_PROXY:-http://127.0.0.1:17890}
export HTTPS_PROXY=${HTTPS_PROXY:-http://127.0.0.1:17890}
export NO_PROXY=localhost,127.0.0.1,::1
mkdir -p "$project_root/source"
git_cmd() {
  podman run --rm --network=host --env HTTP_PROXY --env HTTPS_PROXY --env NO_PROXY \
    -v "$project_root/source:/source:Z" -w /source --entrypoint git "$git_image" "$@"
}
if [[ ! -d "$project_root/source/.git" ]]; then
  git_cmd clone https://github.com/NuaptanEvalisk/Exomem.git .
else
  if [[ -n "$(git_cmd status --porcelain)" ]]; then
    echo 'Server checkout has changes. Refusing to overwrite them.' >&2
    exit 1
  fi
  git_cmd pull --ff-only
fi
commit=$(git_cmd rev-parse HEAD)
cd "$project_root/source"
podman build --network=host --build-arg "EXOMEM_COMMIT=$commit" -t "localhost/exomem:$commit" -f Containerfile .
if systemctl is-active --quiet exomem.service; then
  podman exec exomem node /app/backup.mjs
fi
podman tag "localhost/exomem:$commit" localhost/exomem:current
install -d -m 0750 /etc/exomem /var/lib/exomem
chown 1000:1000 /var/lib/exomem
if [[ ! -f /etc/exomem/app.env ]]; then
  printf '%s\n' 'EXOMEM_PUBLIC_ORIGIN=https://exomem.evalisk.org' > /etc/exomem/app.env
  chmod 0600 /etc/exomem/app.env
fi
install -m 0644 deploy/exomem.container /etc/containers/systemd/exomem.container
install -m 0644 deploy/exomem-backup.service deploy/exomem-backup.timer deploy/exomem-tunnel.service /etc/systemd/system/
systemctl daemon-reload
systemctl restart exomem.service
systemctl enable --now exomem-backup.timer
curl --retry 12 --retry-delay 1 --retry-connrefused --fail --silent http://127.0.0.1:3210/api/status
printf '\nDeployed Git commit %s\n' "$commit"
