# Runs the FindSaunaPlunge MCP server outside Cloudflare, against the public feed.
# Default: JSON-RPC over stdio (what registries and inspectors expect from a
# container). For HTTP: docker run -p 8080:8080 <image> node src/serve.ts
FROM node:24-alpine
WORKDIR /app
COPY package.json server.json README.md LICENSE ./
COPY src ./src
ENV NODE_ENV=production
CMD ["node", "src/serve.ts", "--stdio"]
