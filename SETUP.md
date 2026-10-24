# Final account setup

The application runs on the Homelab server. The remaining steps connect your Cloudflare and OpenAI accounts. No source edits are needed on the server.

## 1. Protect and publish the WebUI

In Cloudflare Zero Trust, create a **self-hosted Access application** for `exomem.evalisk.org`, covering all paths, with an Allow policy for your own account. Do not use a Bypass policy.

After Access is configured, run:

```sh
ssh root@100.127.82.98
/opt/exomem/source/deploy/publish-web.sh --access-configured
```

This validates and updates the runtime ingress configuration, creates the DNS route, and restarts the existing `cloudflared.service` once. It does not modify the Git checkout. Then open [Exomem](https://exomem.evalisk.org) and sign in through Access.

## 2. Create an OpenAI Secure MCP Tunnel

Open [Platform tunnel settings](https://platform.openai.com/settings/organization/tunnels):

- Create a tunnel named **Exomem**.
- Associate the tunnel with your Platform organization and the ChatGPT workspace where you will use it.
- Copy its `tunnel_...` ID.
- Create a runtime API key whose principal has **Tunnels Read + Use**. Tunnel creation itself requires **Read + Manage**. Use a runtime key, not an organization admin key.

On the server, run the interactive setup script:

```sh
/opt/exomem/source/deploy/configure-tunnel.sh
```

It asks for the tunnel ID and then the API key with input hidden. It writes `/etc/exomem/tunnel.env` with mode 0600, starts the service, and checks readiness. Do not put the key in chat or Git. If the script does not reach readiness, inspect:

```sh
systemctl status exomem-tunnel.service
journalctl -u exomem-tunnel.service -n 40 --no-pager
```

The local tunnel health UI is on `127.0.0.1:3212`; the service sends its OpenAI traffic through mihomo at `127.0.0.1:17890`.

If OAuth discovery reports a timeout reaching `127.0.0.1:3211`, check the local MCP hop separately from the outbound proxy. A loopback-only systemd `IPAddressAllow` filter blocks Podman's bridge forwarding even though the published port uses a loopback address; the supplied unit intentionally omits that filter. `/healthz` only confirms that the tunnel process is alive; use `/readyz` to check readiness.

## 3. Connect ChatGPT and create your first memory space

In [ChatGPT Plugins](https://chatgpt.com/plugins): add a **custom MCP server**, choose **Tunnel**, select the Exomem tunnel, and select **No authentication** at the transport level. Space authorization is enforced separately by the required token argument on every memory tool. Create and install the plugin.

In the Exomem WebUI:

1. Create a space, then open **Tokens → New token**.
2. Download `token.txt` and attach it to the intended ChatGPT conversation.
3. Enable the Exomem plugin and ask ChatGPT to read the file and call `memory_bootstrap`.
4. Ask it to save a small event, then confirm that the event appears in the WebUI.

That last real ChatGPT call completes the end-to-end verification. The application has already been checked locally; account/workspace permissions can only be verified after these steps.

## Local access before publishing

For a temporary private preview, forward the admin port:

```sh
ssh -L 3210:127.0.0.1:3210 root@100.127.82.98
```

Then open `http://127.0.0.1:3210`. The production origin configuration allows this loopback preview as well.

## Later updates and backups

After code has been committed and pushed from the local development directory:

```sh
/opt/exomem/source/deploy/update.sh
```

Daily database backups are enabled. Copy `/var/lib/exomem/backups` to separate storage with your preferred encrypted backup system when ready; configuring a remote backup destination is not part of account setup.
