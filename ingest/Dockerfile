# ingest/Dockerfile
FROM node:18
WORKDIR /app

# copy package files first to leverage Docker cache
COPY package*.json ./

# install dependencies inside the container (linux builds native modules correctly)
RUN npm install --production

# copy app sources (will not overwrite node_modules if .dockerignore excludes it)
COPY . .

# expose port (optional, your compose may map this)
EXPOSE 3000

CMD ["node", "index.js"]
