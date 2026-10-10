# Pentru găzduiri care construiesc din Dockerfile (ex. Render).
# Fonturile sunt necesare pentru textul de pe imaginile de Story (sharp/librsvg),
# la fel ca în nixpacks.toml.
FROM node:20-bookworm-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends fonts-dejavu-core fontconfig ca-certificates \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY . .
ENV NODE_ENV=production
CMD ["npm", "start"]
