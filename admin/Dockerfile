ARG NODE_IMAGE=node:24.18.0-alpine3.23@sha256:595398b0081eacda8e1c4c5b97b76cd1020e4d58a8ebcb4843b9bca1e79e7436
ARG NGINX_IMAGE=nginx:1.30.4-alpine3.24

FROM ${NODE_IMAGE} AS build
WORKDIR /usr/src/admin
COPY package.json package-lock.json ./
RUN npm ci
COPY index.html tsconfig.json vite.config.ts ./
COPY src ./src
RUN npm run build

FROM ${NGINX_IMAGE} AS runtime
ENV NGINX_ENVSUBST_FILTER=^PORT$ \
    NGINX_ENVSUBST_OUTPUT_DIR=/tmp/nginx/conf.d \
    PORT=3000
COPY nginx.conf /etc/nginx/nginx.conf
COPY default.conf.template /etc/nginx/templates/default.conf.template
COPY --from=build --chown=nginx:nginx /usr/src/admin/dist /usr/share/nginx/html
USER nginx
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD wget -q -O /dev/null http://127.0.0.1:8080/healthz || exit 1

