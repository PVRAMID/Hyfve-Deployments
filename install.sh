#!/bin/bash

# ==========================================================
# HYFVE DEPLOY - Mini PaaS Bootstrap Installer
# Developed by HYFVE (Joshua Lewis)
# Copyright (c) 2026 HYFVE. All rights reserved.
# No distribution or reselling without permission.
# ==========================================================

set -e

echo -e "\e[35m=======================================\e[0m"
echo -e "\e[1m\e[32m  HYFVE Deploy - Bootstrap Installer\e[0m"
echo -e "\e[36m  Developed by Joshua Lewis\e[0m"
echo -e "\e[35m=======================================\e[0m\n"

# 1. Check and Install Node.js
if ! command -v node &> /dev/null
then
    echo -e "\e[33m[!] Node.js not found. Installing Node.js...\e[0m"
    curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
    sudo apt-get install -y nodejs
else
    echo -e "\e[32m[✓]\e[0m Node.js is already installed."
fi

# 2. Check and Install Docker
if ! command -v docker &> /dev/null
then
    echo -e "\e[33m[!] Docker not found. Installing Docker...\e[0m"
    curl -fsSL https://get.docker.com -o get-docker.sh
    sudo sh get-docker.sh
    sudo usermod -aG docker $USER
    rm get-docker.sh
    echo -e "\e[33m[i] Note: You might need to log out and back in later to use Docker without sudo.\e[0m"
else
    echo -e "\e[32m[✓]\e[0m Docker is already installed."
fi

# 3. Check and Install Docker Compose (v2 plugin)
if ! docker compose version &> /dev/null
then
    echo -e "\e[33m[!] Docker Compose not found. Installing Docker Compose via official binary...\e[0m"
    DOCKER_CONFIG=${DOCKER_CONFIG:-$HOME/.docker}
    mkdir -p $DOCKER_CONFIG/cli-plugins
    curl -SL https://github.com/docker/compose/releases/download/v2.24.6/docker-compose-linux-x86_64 -o $DOCKER_CONFIG/cli-plugins/docker-compose
    chmod +x $DOCKER_CONFIG/cli-plugins/docker-compose
    
    # Fallback to system-wide installation if local fails to be picked up
    if ! docker compose version &> /dev/null; then
        sudo mkdir -p /usr/local/lib/docker/cli-plugins
        sudo curl -SL https://github.com/docker/compose/releases/download/v2.24.6/docker-compose-linux-x86_64 -o /usr/local/lib/docker/cli-plugins/docker-compose
        sudo chmod +x /usr/local/lib/docker/cli-plugins/docker-compose
    fi
else
    echo -e "\e[32m[✓]\e[0m Docker Compose is already installed."
fi

echo -e "\n\e[36m--- Installing Project Dependencies ---\e[0m"
# Check if package.json exists
if [ -f "package.json" ]; then
    npm install
else
    echo -e "\e[31m[!] package.json not found. Please run this script from the project root.\e[0m"
    exit 1
fi

echo -e "\n\e[36m--- Starting Interactive Setup Wizard ---\e[0m"
npm run setup
