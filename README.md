# HYFVE Deploy
**Developed by HYFVE (Joshua Lewis)**

> **© 2026 HYFVE (Joshua Lewis). All Rights Reserved.**
> 
> Unauthorized copying of this file, via any medium is strictly prohibited. Proprietary and confidential. No distribution or reselling without permission.

A lightweight, self-hosted Platform-as-a-Service (PaaS) built with Node.js, Docker, and Traefik v3. 

This repository sets up a `webhook-listener` service that listens for GitHub Push events. When a push to the production branch occurs, it automatically:
1. Clones/pulls the repository.
2. Builds the Docker image from the repository's `Dockerfile`.
3. Stops the old container.
4. Deploys the new container attached to Traefik, making it instantly available at `https://<repo-name>.<DOMAIN_NAME>` with full Let's Encrypt SSL.

## Requirements
- A server with **Docker** and **Docker Compose** installed.
- A registered domain name pointing to your server's IP address.
- Port `80` and `443` open on your firewall (or routed securely via an external proxy like Nginx Proxy Manager).

## Environment Variables

The bundled `install.js` Interactive Setup Wizard will automatically generate a highly secure `.env` file in the root directory for you. Here is an example of what it autonomously configures:

```ini
# Required: Your email for Let's Encrypt SSL certificates (Traefik)
EMAIL_ADDRESS=admin@yourdomain.com

# Required: The base domain name for your deployments (e.g., mydomain.com)
# A repository named "my-api" will be deployed to "my-api.mydomain.com"
DOMAIN_NAME=yourdomain.com

# Required: A secret string used to verify GitHub webhook payloads
GITHUB_WEBHOOK_SECRET=your_super_secret_string

# Optional: The branch to listen to (defaults to refs/heads/main)
PRODUCTION_BRANCH=refs/heads/main

# Optional: GitHub Personal Access Token if pulling from private repositories. 
# This requires "repo" or "content" read scopes.
GITHUB_TOKEN=ghp_your_github_token

# Required: Telegram Bot variables
TELEGRAM_BOT_TOKEN=8395091873:asdasdasdasdqhrMjR4Bl9YEfU6tM
TELEGRAM_ALLOWED_NUMBER=+44 12345678

# Dynamic Ports (Auto-assigned by the Setup Wizard)
TRAEFIK_HTTP_PORT=80
TRAEFIK_HTTPS_PORT=443
WEBHOOK_PORT=3000

# Proxy Configuration (Bypasses internal Traefik Let's Encrypt for NPM coexistence)
EXTERNAL_SSL_PROXY=false
```

## Setup & Deployment

1. **Run the Interactive Bootstrap Installer:**
   Instead of installing dependencies manually, simply run the bundled `install.sh` script. This script will automatically:
   - Install **Docker** & **Docker Compose v2** (Extracting official GitHub binaries)
   - Install **Node.js 18.x** & **NPM**
   - Launch the highly interactive Node CLI Wizard (`install.js`)

   ```bash
   chmod +x install.sh
   ./install.sh
   ```

   **The Setup Wizard dynamically features:**
   - **Port Scanning:** Automatically detects if `80`, `443`, or `3000` are blocked and prevents installation failures by dynamically routing alternative ports.
   - **External Proxy Intelligence:** If Port 80 is blocked by Nginx Proxy Manager (or similar), it seamlessly dials back Traefik and enables `EXTERNAL_SSL_PROXY` mode to completely prevent Let's Encrypt domain collisions.
   - **NPM API Automation:** Natively authenticates with Nginx Proxy Manager via local REST API (`fetch`) to organically generate your wildcard proxy routes identically in the background!
   - **Upgrade Persistence:** The installer quietly parses your existing `.env` file so you can safely rerun it at any time to upgrade or migrate ports without losing your tokens or domains.

2. **Spin up the Infrastructure:**
   If you didn't auto-start the container in the setup script, you can run it manually:
   ```bash
   docker compose up -d
   ```
3. **Connect to Telegram:**
   - Open Telegram and search for your newly created bot to start a conversation.
   - Send `/start` and press the "Share My Phone Number" button on the keyboard to authenticate your identity strictly against your phone number.
   - You will start receiving prompt buttons whenever a new push arrives.

4. **Expose the Webhook Listener:**
   By default, the webhook listener is exposed on port `3000`. You can route a subdomain to it (e.g., `webhook.yourdomain.com` -> `http://127.0.0.1:3000`) or access it publicly via `http://YOUR_SERVER_IP:3000/webhook`.

4. **Configure GitHub Webhooks:**
   - Go to your application repository on GitHub -> **Settings** -> **Webhooks** -> **Add webhook**.
   - **Payload URL**: `http://YOUR_SERVER_IP:3000/webhook` (or your reverse-proxied subdomain).
   - **Content type**: `application/json`.
   - **Secret**: The exact value you set for `GITHUB_WEBHOOK_SECRET`.
   - **Which events would you like to trigger this webhook?**: Just the `push` event.

When you push code to your `PRODUCTION_BRANCH`, the webhook listener will build and deploy the application automatically. You can view the logs cleanly using:
```bash
docker logs -f webhook-listener
```
