FROM node:20-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig*.json eslint.config.js ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:20-alpine AS runtime
ENV NODE_ENV=production DTIS_CONFIG=/config/config.yaml DTIS_PROFILES_DIRECTORY=/profiles DTIS_DATA_DIRECTORY=/data
WORKDIR /app
RUN addgroup -S objectid && adduser -S -G objectid objectid && apk add --no-cache mosquitto
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY console ./console
COPY profiles /profiles
COPY config/config.example.yaml /config/config.yaml
RUN mkdir -p /secrets /data && chown -R objectid:objectid /app /config /profiles /secrets /data
USER objectid
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 CMD wget -qO- http://127.0.0.1:8080/health || exit 1
CMD ["node", "dist/index.js"]
