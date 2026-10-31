# Image for unattended agent sessions: Claude Code, git, gh and Playwright's Chromium, behind a
# default-deny egress firewall that the container applies to itself at startup. See README.md.
FROM node:24-bookworm

ENV DISABLE_AUTOUPDATER=1 \
    CLAUDE_CODE_PLUGIN_PREFER_HTTPS=1 \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

RUN set -eux; \
    install -d -m 0755 /etc/apt/keyrings; \
    curl -fsSL -o /etc/apt/keyrings/githubcli-archive-keyring.gpg \
      https://cli.github.com/packages/githubcli-archive-keyring.gpg; \
    chmod 0644 /etc/apt/keyrings/githubcli-archive-keyring.gpg; \
    echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
      >/etc/apt/sources.list.d/github-cli.list; \
    apt-get update; \
    apt-get install -y --no-install-recommends \
      ca-certificates curl dnsutils gh git iproute2 ipset iptables jq openssh-client procps tmux \
      util-linux; \
    rm -rf /var/lib/apt/lists/*; \
    test -x /usr/bin/setpriv

# The browsers live outside /home/node, which the home volume shadows, and are not writable by node.
ARG PLAYWRIGHT_VERSION=1.64.1
RUN set -eux; \
    npx -y "playwright@${PLAYWRIGHT_VERSION}" install --with-deps chromium; \
    rm -rf /var/lib/apt/lists/* /root/.npm

# Installed as root into /usr/local, so node cannot update or replace it. The npm link gives way to
# claude-guard.sh, which runs the real binary through /usr/local/libexec/claude-code.
ARG CLAUDE_CODE_VERSION=2.1.309
RUN set -eux; \
    npm install -g "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}"; \
    rm -rf /root/.npm; \
    test -L /usr/local/bin/claude; \
    install -d -m 0755 /usr/local/libexec; \
    ln -s "$(readlink -f /usr/local/bin/claude)" /usr/local/libexec/claude-code; \
    rm /usr/local/bin/claude; \
    /usr/local/libexec/claude-code --version

COPY init-firewall.sh entrypoint.sh claude-guard.sh /usr/local/bin/
RUN set -eux; \
    cd /usr/local/bin; \
    mv claude-guard.sh claude; \
    chown root:root init-firewall.sh entrypoint.sh claude; \
    chmod 0755 init-firewall.sh entrypoint.sh claude

# Root, so the entrypoint can apply the firewall; sessions run as node through docker exec.
WORKDIR /home/node
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
