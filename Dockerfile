FROM node:20-slim

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --production

COPY src/ src/
COPY public/ public/

RUN mkdir -p data

EXPOSE 5050

CMD ["node", "src/server.js"]
