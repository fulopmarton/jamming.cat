FROM node:22-alpine

WORKDIR /app
COPY package.json index.js ./
COPY lib ./lib
COPY public ./public
COPY assets ./assets

ENV NODE_ENV=production PORT=3000
EXPOSE 3000
USER node

CMD ["node", "index.js"]
