# Codespaces / VS Code Dev Containers for Mindcraft.
# Node.js 24 matches .nvmrc, package.json engines, CI, and the project Dockerfile.
FROM mcr.microsoft.com/devcontainers/javascript-node:1-24-bookworm

# Native build prerequisites for the optional headless-rendering stack
# (gl / node-canvas / node-canvas-webgl), mirroring the project Dockerfile.
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
    python3 \
    python-is-python3 \
    xvfb \
    xauth \
    libgl1-mesa-dev \
    libgles2-mesa-dev \
    libosmesa6-dev \
    build-essential \
    libcairo2-dev \
    libpango1.0-dev \
    libjpeg-dev \
    libgif-dev \
    librsvg2-dev \
    libxi-dev \
    libxinerama-dev \
    libxrandr-dev \
    && rm -rf /var/lib/apt/lists/*
