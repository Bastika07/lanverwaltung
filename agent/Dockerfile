# LAN-Client für CS2-Matches (agent/tmt2-agent.js). Gleiche fixierte Basis wie das Hauptimage.
FROM node:22-alpine@sha256:fe4f6d74e20370acb04ad889077d14d0f64a9c8ea6a42bc60cddf1e844699914

LABEL org.opencontainers.image.title="LAN-Verwaltung TMT2-Client" \
      org.opencontainers.image.description="Verbindet TMT2 im LAN mit der LAN-Verwaltung (nur ausgehende Verbindungen)" \
      org.opencontainers.image.licenses="MIT"

ENV NODE_ENV=production
WORKDIR /app
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack /opt/yarn-v* \
    && rm -f /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack /usr/local/bin/yarn /usr/local/bin/yarnpkg
COPY LICENSE NOTICE ./
COPY agent/tmt2-agent.js ./agent/

USER node
CMD ["node", "agent/tmt2-agent.js"]
