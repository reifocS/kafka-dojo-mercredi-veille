FROM node:22-slim
WORKDIR /app
COPY shared/package.json ./package.json
RUN npm install --production
COPY . .
