# 令和の競り（ライブオークション）を、1つのコンテナで動かす。
#   docker build -t reiwa-no-seri .
#   docker run -p 8080:8080 -v reiwa-data:/app/data -e POC_COOKIE_SECURE=1 -e POC_TRUST_PROXY=1 reiwa-no-seri
# データ（データベース・請求書・印鑑・書き出し）は /app/data に置く。必ず、消えない場所（ボリューム）をつなぐこと。
FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY server ./server
COPY web ./web
COPY tools ./tools
RUN mkdir -p /app/data && chown -R node:node /app
USER node
ENV PORT=8080 HOST=0.0.0.0 POC_DATA_DIR=/app/data
EXPOSE 8080
VOLUME ["/app/data"]
HEALTHCHECK --interval=30s --timeout=5s CMD node -e "fetch('http://127.0.0.1:8080/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
# 起動のたびに、外の保存先があればデータを戻し（POC_PERSIST_URL）、最初の主催者管理者がいなければ作る（すでにいれば何もしない）。そのあと、サーバーを動かす
CMD ["sh", "-c", "node tools/persist-restore.js && node tools/setup-first.js ${POC_SETUP_ARGS:-} && exec node server/src/index.js"]
