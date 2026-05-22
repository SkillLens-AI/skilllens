# SkillLens evaluation runtime image.
#
# Build with the Harbor commit pinned at build time:
#   docker build --build-arg HARBOR_SHA=<commit-sha> -t skilllens-eval .
#
# Or, if you have already filled the SHA into pyproject.toml manually,
# build without the arg:
#   docker build -t skilllens-eval .
#
# Run with API keys mounted via env file:
#   docker run --rm -it --env-file .env skilllens-eval bash

FROM python:3.12-slim

ARG HARBOR_SHA=""

ENV DEBIAN_FRONTEND=noninteractive \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    UV_LINK_MODE=copy

# System dependencies.
#   git           — for git+https Harbor install
#   ca-certificates / curl — TLS + uv installer
#   build-essential — fallback for any wheel-less native dep
RUN apt-get update && apt-get install -y --no-install-recommends \
        git \
        ca-certificates \
        curl \
        build-essential \
    && rm -rf /var/lib/apt/lists/*

# Install uv (pinned to a recent stable build).
RUN curl -LsSf https://astral.sh/uv/install.sh | sh \
    && mv /root/.local/bin/uv /usr/local/bin/uv \
    && uv --version

WORKDIR /workspace

# Copy only the metadata first so dep resolution layer caches.
COPY pyproject.toml README.md LICENSE NOTICE /workspace/

# Optional substitution of the Harbor pin.
RUN if [ -n "$HARBOR_SHA" ] && grep -q "<HARBOR_SHA>" pyproject.toml; then \
        sed -i "s/<HARBOR_SHA>/${HARBOR_SHA}/g" pyproject.toml; \
    fi

# Copy the source tree.
COPY skills_eval /workspace/skills_eval
COPY scripts /workspace/scripts

# Create venv and install.
RUN uv venv /workspace/.venv \
    && uv pip install --python /workspace/.venv/bin/python -e .

ENV PATH="/workspace/.venv/bin:${PATH}"

# Sanity entrypoint — interactive shell.  Override in `docker run` to invoke
# any of the skilllens-* console scripts directly.
CMD ["bash"]
