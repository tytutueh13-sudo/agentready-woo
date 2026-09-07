FROM apify/actor-node:22
COPY package*.json ./
RUN npm --quiet install --omit=dev --omit=optional
COPY . ./
CMD ["node", "--experimental-strip-types", "main.ts"]
