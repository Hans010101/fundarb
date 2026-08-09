FROM node:22-alpine
WORKDIR /app
COPY server.mjs ./server.mjs
ENV NODE_ENV=production
USER node
EXPOSE 8788
CMD ["node", "server.mjs"]
