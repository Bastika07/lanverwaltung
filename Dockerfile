# Digest bewusst fixiert; regelmäßig prüfen und nach Tests/Scan aktualisieren (siehe docs/security-operations.md).
FROM node:22-alpine@sha256:fe4f6d74e20370acb04ad889077d14d0f64a9c8ea6a42bc60cddf1e844699914

LABEL org.opencontainers.image.title="Turnierbaum" \
      org.opencontainers.image.description="Selbstgehosteter Turnierbaum / Turnierplan" \
      org.opencontainers.image.licenses="MIT"

ENV NODE_ENV=production \
    PORT=3000 \
    HOST=0.0.0.0 \
    DATA_DIR=/data

WORKDIR /app
# Keine Paketinstallation zur Laufzeit: unbenutzte npm-/Corepack-/Yarn-Bundles entfernen.
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack /opt/yarn-v* \
    && rm -f /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack /usr/local/bin/yarn /usr/local/bin/yarnpkg
COPY package.json server.js LICENSE NOTICE ./
COPY lib ./lib
COPY public ./public

# Datenverzeichnis gehört dem unprivilegierten Benutzer "node"
RUN mkdir -p /data && chown node:node /data
VOLUME /data

USER node
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
