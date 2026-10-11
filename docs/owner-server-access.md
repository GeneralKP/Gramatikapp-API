# Server access (SSH): owner guide

SSH lets your Mac securely open a text console on the server running Gramatik’s API. It is for maintenance; students continue using the web and mobile apps normally.

## How it was set up

On 11 October 2026, we enabled the server’s existing `debian` account. Your Mac holds a private access key; the server holds its matching public key. The Mac’s connection settings are in `~/.ssh/config`, under `gramatik-vps`.

Both server and OVH firewalls allow SSH (port 22) only from your approved internet address. Root login through SSH is disabled.

## Connect

1. On this Mac, press **⌘ Space**, type **Terminal**, and open it.
2. Paste `ssh gramatik-vps` and press **Enter**.
3. You are connected when the prompt starts with `debian@vps-0f140ad8`.

Type `exit` to disconnect.

Administrator commands require `su -` and the **Linux root password**, separate from your OVH website password. **Status: normal SSH access works. Root password access is currently locked, so administrator access needs a one-time setup through the OVH console.**

## Change access

- **Different internet connection or VPN:** your address may change and SSH may stop working. Ask Codex: “Update SSH access for my current internet address.” This requires the OVH console and updates both firewalls and the server’s key restriction.
- **New Mac or replacement key:** ask Codex to create a new key, add its public half to the server, and remove the old access when appropriate. The private key stays on your Mac.
- **Change the server or account:** ask Codex to update the `gramatik-vps` entry in `~/.ssh/config`.

If access fails, use **OVH → your VPS → KVM** to reach the server and repair it. Keep passwords out of this guide.
