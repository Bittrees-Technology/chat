# Build dependencies separately; package managers and shell tools do not ship.
FROM node:24.22.1-trixie-slim@sha256:43b9ba1142b8dcf33fa8f922ca1be85714adc444e0586c7cf7726daaeabc1bea AS dependencies
WORKDIR /app
COPY selfhost/gate.package.json ./package.json
COPY selfhost/gate.package-lock.json ./package-lock.json
RUN npm ci --omit=dev --no-fund && npm audit --omit=dev --audit-level=moderate
COPY packages/core /gate-source/packages/core
COPY server/room-join.js server/server-utils.js server/ops-utils.js server/gate-client.js server/gate-resume-config.js server/gate-storage.js server/gate-config.js server/gate-queue.js server/gate-membership.js server/gate-membership-worker.js server/native-origins.js server/gate-health.js server/gate-role-authority.js /gate-source/server/
COPY selfhost/gate-server.mjs selfhost/gate-snapshot.mjs selfhost/register-gate-once.mjs /gate-source/selfhost/
RUN chmod -R u=rwX,go=rX /gate-source
RUN install -d -o 65532 -g 65532 -m 0700 /data \
    && install -d -o 65532 -g 65532 -m 0755 /home/nonroot

# The chiseled Ubuntu runtime supplies glibc, CA certificates, and the patched
# system libraries required by the native XMTP SDK. Node remains pinned above.
FROM mcr.microsoft.com/dotnet/runtime-deps:8.0-noble-chiseled@sha256:f5647b6da1c1c4b49e2867121bacb3a366e092c15afea801ba575446a48968df
# Keep the runtime shell-free and retain the established Node executable path.
COPY --from=dependencies /usr/local/bin/node /nodejs/bin/node
COPY --from=dependencies /usr/local/LICENSE /nodejs/LICENSE
WORKDIR /app
COPY --from=dependencies /app/package.json /app/package-lock.json ./
COPY --from=dependencies /app/node_modules ./node_modules
COPY --from=dependencies --chown=65532:65532 --chmod=0700 /data /data
COPY --from=dependencies --chown=65532:65532 /home/nonroot /home/nonroot
COPY --from=dependencies /gate-source/ ./
ENV GATE_PORT=8788 GATE_BIND_HOST=0.0.0.0 GATE_DATA_DIR=/data NODE_ENV=production PATH=/nodejs/bin HOME=/home/nonroot
EXPOSE 8788
VOLUME ["/data"]
USER 65532:65532
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD ["/nodejs/bin/node", "-e", "fetch('http://127.0.0.1:'+(process.env.GATE_PORT||8788)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
ENTRYPOINT ["/nodejs/bin/node"]
CMD ["selfhost/gate-server.mjs"]
