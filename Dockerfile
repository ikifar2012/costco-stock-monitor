FROM oven/bun:1.4.0-alpine
WORKDIR /app
COPY --chown=bun:bun package.json ./
COPY --chown=bun:bun src ./src
RUN mkdir /data && chown bun:bun /data
USER bun
ENV NODE_ENV=production DATABASE_PATH=/data/monitor.sqlite
CMD ["bun", "run", "src/monitor.ts"]
