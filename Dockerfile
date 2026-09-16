FROM node:22-alpine

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY outputs ./outputs

ENV NODE_ENV=production
ENV PORT=18080
ENV DATA_DIR=/var/data
EXPOSE 18080

CMD ["npm", "start"]
