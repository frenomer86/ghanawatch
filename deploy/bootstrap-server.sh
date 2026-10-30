#!/usr/bin/env bash
# One-time preparation of a fresh Ubuntu 24.04 VPS (run as root over SSH).
# Installs Docker if missing, enables the firewall (SSH, HTTP, HTTPS only),
# turns on unattended security updates, and creates /opt/ghanawatch.
set -euo pipefail

if ! command -v docker >/dev/null 2>&1; then
  curl -fsSL https://get.docker.com | sh
fi
apt-get update -y
DEBIAN_FRONTEND=noninteractive apt-get install -y ufw unattended-upgrades fail2ban
ufw allow OpenSSH
ufw allow 80/tcp
ufw allow 443/tcp
ufw allow 443/udp
ufw --force enable
dpkg-reconfigure -f noninteractive unattended-upgrades
systemctl enable --now fail2ban
# Swap helps the Next.js build on small plans.
if ! swapon --show | grep -q /swapfile; then
  fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile
  echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi
mkdir -p /opt/ghanawatch
echo "Server ready: docker $(docker --version | cut -d' ' -f3) and firewall enabled."
