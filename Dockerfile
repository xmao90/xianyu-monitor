FROM node:18-alpine

WORKDIR /app

# 复制依赖文件
COPY package*.json ./

# 安装依赖（使用 --prefer-offline 加速）
RUN npm ci --prefer-offline --no-audit || npm install --prefer-offline --no-audit

# 复制源代码
COPY . .

# Railway 会设置 PORT 环境变量
EXPOSE 8080

# 健康检查
HEALTHCHECK --interval=30s --timeout=10s --start-period=15s --retries=3 \
  CMD node -e "require('http').get('http://localhost:'+process.env.PORT+'/api/health',(r)=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

CMD ["node", "server.js"]
