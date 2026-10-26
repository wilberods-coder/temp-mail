FROM node:22-alpine
WORKDIR /app
COPY package.json server.js ./
COPY public ./public
ENV HOST=0.0.0.0 PORT=5190
EXPOSE 5190
RUN mkdir -p /app/data && chown node:node /app/data
VOLUME /app/data
USER node
CMD ["node", "server.js"]
