FROM mcr.microsoft.com/playwright:v1.62.1-noble
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts
COPY src ./src
RUN mkdir -p /app/qagent-results && chown -R pwuser:pwuser /app
USER pwuser
ENV NODE_ENV=production
ENTRYPOINT ["node", "/app/src/cli.js"]
CMD ["--help"]
