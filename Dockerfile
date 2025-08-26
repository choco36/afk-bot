FROM node:20-alpine
WORKDIR /app
COPY package.json .
RUN npm install --production
COPY public public
COPY server.js server.js
EXPOSE 3000
ENV NODE_ENV=production
CMD ["npm","start"]
