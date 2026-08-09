ARG NODE_IMAGE=node:24.18.0-alpine3.23@sha256:595398b0081eacda8e1c4c5b97b76cd1020e4d58a8ebcb4843b9bca1e79e7436

FROM ${NODE_IMAGE} AS dependencies
WORKDIR /usr/src/app
COPY package.json package-lock.json ./
RUN npm ci

FROM dependencies AS build
COPY tsconfig.json ./
COPY prisma ./prisma
COPY src ./src
RUN npm run prisma:generate \
    && npm run build

FROM ${NODE_IMAGE} AS production-dependencies
WORKDIR /usr/src/app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --omit=optional

FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production
WORKDIR /usr/src/app
COPY --from=production-dependencies --chown=node:node /usr/src/app/node_modules ./node_modules
COPY --from=build --chown=node:node /usr/src/app/node_modules/.prisma ./node_modules/.prisma
COPY --from=build --chown=node:node /usr/src/app/dist ./dist
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=75s --retries=3 \
  CMD node -e "const port=process.env.PORT||'3000';fetch('http://127.0.0.1:'+port+'/health/ready').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
CMD ["node", "dist/main.js"]

FROM dependencies AS init
ENV NODE_ENV=production
WORKDIR /usr/src/app
COPY --chown=node:node prisma ./prisma
COPY --from=build --chown=node:node /usr/src/app/node_modules/.prisma ./node_modules/.prisma
USER node
CMD ["npm", "run", "deploy:init"]
