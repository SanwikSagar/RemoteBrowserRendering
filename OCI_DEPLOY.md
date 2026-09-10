# Oracle Cloud ARM deployment

The application does not need a separate browser installation when deployed with
the included Dockerfile: the image installs the ARM64 Chromium package and
Puppeteer is configured to use it.

## 1. Create the VM

In OCI Console, create an Ubuntu ARM64 VM in your home region. Choose an
Ampere A1 shape within the Always Free quota, assign a public IPv4 address, and
allow inbound TCP `22` and `3000` in the subnet security list. For production,
allow only `22` and `80/443` and put Caddy or Nginx in front of the app.

## 2. Install Docker and deploy

SSH to the VM, then run:

```bash
sudo apt-get update
sudo apt-get install -y git docker.io docker-compose-plugin
sudo systemctl enable --now docker
sudo usermod -aG docker "$USER"
exit
```

Reconnect, clone this repository, and start the service:

```bash
git clone YOUR_REPOSITORY_URL remote-browser-rendering
cd remote-browser-rendering
docker compose -f docker-compose.oracle.yml up -d --build
curl http://127.0.0.1:3000/health
```

Open `http://PUBLIC_IP:3000` for the first smoke test. The VM firewall and OCI
security list must both allow the port.

## 3. Recommended public deployment

Use a DNS name and a reverse proxy with HTTPS rather than exposing port 3000.
Cloudflare Tunnel is a convenient option because it avoids opening inbound web
ports; keep SSH restricted to your own IP. The app automatically uses `wss://`
when served over HTTPS.

The first startup can take longer while Chromium initializes. Keep
`MAX_BROWSERS=1`; each additional browser is expensive on memory.
