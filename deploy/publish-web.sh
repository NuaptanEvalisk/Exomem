#!/usr/bin/env bash
# Runtime configuration only. Source remains identical to the Git checkout.
set -euo pipefail
if [[ $EUID -ne 0 ]]; then echo 'Run as root.' >&2; exit 1; fi
if [[ ${1:-} != --access-configured ]]; then
  echo 'First protect exomem.evalisk.org with a Cloudflare Access self-hosted application.' >&2
  echo 'Then run: deploy/publish-web.sh --access-configured' >&2
  exit 1
fi
config=/etc/cloudflared/config.yml
temporary=$(mktemp /etc/cloudflared/exomem-config.XXXXXX.yml)
trap 'rm -f "$temporary"' EXIT
python3 - "$config" "$temporary" <<'PY'
import pathlib, re, sys
source = pathlib.Path(sys.argv[1]).read_text()
hostname = 'exomem.evalisk.org'
if re.search(r'^\s*-\s*hostname:\s*' + re.escape(hostname) + r'\s*$', source, re.M):
    raise SystemExit('This hostname is already configured. Nothing was changed.')
if source.count('ingress:\n') != 1:
    raise SystemExit('Expected exactly one ingress section; nothing was changed.')
block = 'ingress:\n  - hostname: exomem.evalisk.org\n    service: http://127.0.0.1:3210\n'
pathlib.Path(sys.argv[2]).write_text(source.replace('ingress:\n', block, 1))
PY
cloudflared tunnel --config "$temporary" ingress validate
tunnel_id=$(sed -n 's/^tunnel: *//p' "$config")
cloudflared tunnel route dns "$tunnel_id" exomem.evalisk.org
cp -p "$config" "$config.before-exomem-$(date -u +%Y%m%dT%H%M%SZ)"
install -m 0600 "$temporary" "$config"
systemctl restart cloudflared.service
echo 'Published https://exomem.evalisk.org through the existing Cloudflare tunnel.'
