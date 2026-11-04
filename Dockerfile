FROM node:22-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=optional && npm cache clean --force
COPY tsconfig.json ./
COPY src ./src
COPY ui ./ui
ENV HOST=0.0.0.0 PORT=8686 NODE_ENV=production
EXPOSE 8686 8687
USER node
HEALTHCHECK CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
# Web app by default; run the guard proxy with: docker run -e MANDATE=... -p 8687:8687 siege npm run proxy
CMD ["npm", "start"]
