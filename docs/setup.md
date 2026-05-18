# 部署指南

逐步走完这份文档，你会拿到一个可以实拨的 Twilio 号码，用手机打进去就能触发 AI 实时翻译。

## 1. 前置要求

- Node.js ≥ 20
- OpenAI API Key（账户需要有 Realtime API 访问权限）
- Twilio 账户（新账户一般送 $15 试用额度）
- ngrok 或 Cloudflare Tunnel（本地开发用）

## 2. 拿到 API Keys

### 2.1 OpenAI

1. 到 https://platform.openai.com/api-keys 创建一个 key。
2. 确认账户有 Realtime API 访问权限（在 https://platform.openai.com/settings/organization/limits 看 model access）。
3. 复制到 `.env` 的 `OPENAI_API_KEY`。

### 2.2 Twilio

1. 注册 https://www.twilio.com/try-twilio。
2. 在 Console 里购买一个支持 Voice 的号码（美区 $1/月）。
   - **注意**：国内手机号打美国 Twilio 号费用较高，测试时可考虑买一个英国或加拿大号。
3. 获取 Account SID 和 Auth Token（本项目 MVP 不调用 Twilio 的出站 API，所以暂时不需要写进 `.env`；后续做 Conference / 拨出功能时再用）。

## 3. 本地启动

```bash
git clone <this repo>
cd AI_phone_call

npm install

cp .env.example .env
# 编辑 .env：
#   OPENAI_API_KEY=sk-...
#   VOICE=alloy
#   SPEAKER_A_LANG=Chinese
#   SPEAKER_B_LANG=English

npm run dev
```

控制台应该看到：

```
────────────────────────────────────────────────────────────
  AI Phone Call Translator listening on :5050
  TwiML webhook : POST /twilio/incoming-call
  Media stream  : WS   /twilio/media-stream
  Languages     : Chinese  ⇄  English
  Voice         : alloy  (clone bridge: off)
────────────────────────────────────────────────────────────
```

健康检查：
```bash
curl http://localhost:5050/health
# -> {"ok":true,"service":"ai-phone-call-translator"}
```

## 4. 暴露到公网

Twilio 需要能从公网 HTTPS/WSS 访问到你的机器。最简单是 ngrok：

```bash
# 装一次
brew install ngrok   # 或 https://ngrok.com/download

# 首次运行要登录并填 authtoken
ngrok config add-authtoken <your-token>

# 起隧道
ngrok http 5050
```

拿到形如 `https://abcd-1234.ngrok-free.app` 的 URL。

> **生产环境**：部署到 Fly.io / Render / Railway / AWS / 自己的 VPS 都可以，只要 HTTPS 和 WSS 都通就行。记得把 `PUBLIC_HOST` 设为域名。

## 5. 配置 Twilio 号码

1. 进入 Twilio Console → Phone Numbers → Manage → Active numbers → 点选你的号码。
2. 在 "Voice Configuration" 部分：
   - **A call comes in**: Webhook
   - URL: `https://abcd-1234.ngrok-free.app/twilio/incoming-call`
   - HTTP: `POST`
3. 保存。

## 6. 拨号测试

用任意手机拨打你的 Twilio 号码：

1. 接通后先听到"正在接入 AI 实时翻译"。
2. 对着电话说"你好，今天天气怎么样？"
3. 大约半秒内电话里播出 "Hello, how's the weather today?"
4. 继续换语种说 "My name is Bob and I work in New York."
5. 听到："我叫 Bob，在纽约工作。"

同时服务端日志会打印：

```
[twilio] Media stream WS opened from ...
[twilio] stream started: MZ...
[openai] WS connected
[openai] session.updated
[openai] heard:      你好，今天天气怎么样？
[openai] translated: Hello, how's the weather today?
```

## 7. 常见问题

### 接通后没声音
- 看服务端日志，是否走到 `[openai] WS connected`。没连上多半是 API key 或模型访问权限问题。
- 检查 ngrok URL 是否 HTTPS（wss 依赖 https 升级）。

### AI 在"对话"而不是"翻译"
- 检查 `src/prompts.js` 的提示词有没有被改坏。
- Realtime 模型偶尔仍会"答话"，是模型限制；可以把 `temperature` 降到 0.3。

### 听到我的话被重复读了一遍（英文→英文）
- `session.update` 没发成功，模型跑在默认配置。检查日志是否有 `[openai] session.updated`。

### 延迟感觉很大（> 2s）
- ngrok 免费版节点可能在欧美，亚洲用户会明显感觉慢。换付费区域节点或部署到离用户近的服务器。
- OpenAI Realtime 边缘节点主要在北美。

### 音色想换
- `.env` 里 `VOICE=` 支持：`alloy ash ballad coral echo sage shimmer verse`。
- 要换成你自己的声音 → 看 [voice-cloning.md](voice-cloning.md)。

## 8. 下一步

- 读 [api-flow.md](api-flow.md) 了解协议细节，以便排查 bug。
- 读 [voice-cloning.md](voice-cloning.md) 规划音色克隆落地。
- 如果要做生产部署，加上：结构化日志（pino）、监控（Sentry）、速率限制、Twilio 签名校验。
