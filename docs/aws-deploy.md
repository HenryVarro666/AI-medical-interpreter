# AWS 部署指南（Demo 展示）

最简方案：一台 EC2 + nginx 反代 + Let's Encrypt 证书。月成本约 $15-20。

## 方案对比

| 方案 | 成本/月 | 复杂度 | WebSocket 支持 | 适合 |
|------|---------|--------|---------------|------|
| **EC2 + nginx** | ~$15 | 低 | 原生 | Demo / 面试展示 |
| ECS Fargate + ALB | ~$30 | 中 | 需配置 | 生产原型 |
| Lightsail | ~$5 | 最低 | 需配置 | 最省钱 |
| Lambda | ~$0 (按调用) | 高 | 不支持 WS | 不适合本项目 |

## EC2 部署步骤

### 1. 启动实例

```bash
# AMI: Amazon Linux 2023 或 Ubuntu 22.04
# 实例类型: t3.small (2 vCPU, 2 GB RAM)
# 安全组: 开放 22 (SSH), 80 (HTTP), 443 (HTTPS)
```

### 2. 安装依赖

```bash
# Node.js 20
curl -fsSL https://rpm.nodesource.com/setup_20.x | sudo bash -
sudo yum install -y nodejs git nginx

# PM2 进程管理
sudo npm install -g pm2
```

### 3. 部署代码

```bash
cd /home/ec2-user
git clone <your-repo> ai-phone-call
cd ai-phone-call
npm install --production

# 配置环境变量
cp .env.example .env
# 编辑 .env:
#   OPENAI_API_KEY=sk-...
#   PUBLIC_HOST=your-demo.com
#   DEBUG_LOG_TRANSCRIPTS=false
```

### 4. nginx 反向代理（WebSocket 支持）

```nginx
# /etc/nginx/conf.d/ai-translator.conf

server {
    listen 80;
    server_name your-demo.com;

    location / {
        proxy_pass http://127.0.0.1:5050;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_read_timeout 86400;   # WebSocket 长连接
    }
}
```

### 5. HTTPS（Let's Encrypt）

```bash
# 安装 certbot
sudo yum install -y certbot python3-certbot-nginx  # Amazon Linux
# 或
sudo apt install -y certbot python3-certbot-nginx   # Ubuntu

# 生成证书
sudo certbot --nginx -d your-demo.com

# 自动续期
sudo certbot renew --dry-run
```

### 6. 启动服务

```bash
cd /home/ec2-user/ai-phone-call
pm2 start src/server.js --name ai-translator
pm2 save
pm2 startup   # 开机自启
```

### 7. 配置 Twilio

将 Twilio 号码的 Voice Webhook 指向：
```
https://your-demo.com/twilio/incoming-call  (POST)
```

### 8. 验证

```bash
# 健康检查
curl https://your-demo.com/health

# 浏览器打开仪表盘
open https://your-demo.com/

# 拨打 Twilio 号码测试
```

## 环境变量管理（生产建议）

不要把 `.env` 文件放服务器上。用 AWS Secrets Manager 或 SSM Parameter Store：

```bash
# 存入 SSM
aws ssm put-parameter --name "/ai-translator/OPENAI_API_KEY" \
  --value "sk-..." --type SecureString

# 启动时注入
export OPENAI_API_KEY=$(aws ssm get-parameter \
  --name "/ai-translator/OPENAI_API_KEY" \
  --with-decryption --query "Parameter.Value" --output text)
```

## 域名（可选）

- **Route 53** 注册域名（$12/年 for .com）
- **ACM** 免费 SSL 证书（如果用 ALB）
- 或者直接用 EC2 的公网 IP + Let's Encrypt

## 监控

```bash
# PM2 日志
pm2 logs ai-translator

# 审计日志
tail -f data/audit.log | jq .

# PM2 监控面板
pm2 monit
```

## 成本明细

| 资源 | 月成本 |
|------|--------|
| EC2 t3.small | ~$15 |
| EBS 20GB gp3 | ~$2 |
| Route 53 域名 | ~$1 |
| 弹性 IP | $0（关联实例时免费） |
| **基础设施合计** | **~$18** |
| Twilio 号码 | ~$1 |
| Twilio 通话 | ~$0.013/分钟 |
| OpenAI Realtime | ~$0.30/分钟 |
| OpenAI GPT-4o（SOAP） | ~$0.01/次 |

Demo 展示（每天几通测试电话）月总成本约 **$20-25**。
