#!/usr/bin/env bash
# Run interactively on the server. The key never enters shell history or arguments.
set -euo pipefail
if [[ $EUID -ne 0 ]]; then echo 'Run as root.' >&2; exit 1; fi
read -r -p 'OpenAI tunnel_id: ' exomem_tunnel_id
read -r -s -p 'OpenAI runtime API key (hidden): ' exomem_runtime_key
printf '\n'
if [[ "$exomem_tunnel_id" != tunnel_* || "$exomem_runtime_key" != sk-* ]]; then
  echo 'Expected a tunnel_... ID and an sk-... runtime API key. Nothing was changed.' >&2
  exit 1
fi
umask 077
install -d -m 0750 /etc/exomem
printf 'CONTROL_PLANE_TUNNEL_ID=%s\nCONTROL_PLANE_API_KEY=%s\n' "$exomem_tunnel_id" "$exomem_runtime_key" > /etc/exomem/tunnel.env
chmod 0600 /etc/exomem/tunnel.env
unset exomem_runtime_key
systemctl enable exomem-tunnel.service
systemctl restart exomem-tunnel.service
echo 'Tunnel service started. Waiting for readiness...'
if curl --retry 8 --retry-delay 2 --retry-connrefused --fail --silent http://127.0.0.1:3212/readyz; then
  printf '\nReady. Add this tunnel as a custom MCP plugin in ChatGPT.\n'
else
  printf '\nNot ready yet. Check: journalctl -u exomem-tunnel.service -n 40 --no-pager\n' >&2
  exit 1
fi
