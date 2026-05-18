# AI Phone Call Translator -- 技术规格文档

> 最后更新：2026-05-18

## 1. 项目概述

**AI Phone Call Translator** 是一个基于 Twilio Media Streams 和 OpenAI Realtime API 的实时电话翻译服务。用户拨入 Twilio 号码后，系统充当一个"隐形翻译官"：说中文时播出英文翻译，说英文时播出中文翻译。端到端首字延迟约 400-500ms。

当前版本为 **MVP（单人模式）**：一个人拨入，对着 AI 说话，AI 将翻译以语音形式播回。系统预留了音色克隆和双人 Conference 模式的扩展位。

### 核心能力

| 能力 | 状态 | 说明 |
|------|------|------|
| 双语实时翻译 | 已实现 | 中英互译，语言对可通过环境变量配置 |
| 流式音频直通 | 已实现 | Twilio 与 OpenAI 共用 G.711 u-law 8kHz，零重采样 |
| 服务端 VAD | 已实现 | OpenAI 自动检测说话起止，无需自定义静音检测 |
| 回声抑制 | 已实现 | 800ms 门控防止 AI 听到自身输出 |
| 语音打断 (barge-in) | 代码存在，默认关闭 | 因真机回声消除不足，当前未启用 |
| 音色克隆 | 接口预留 | `tts-bridge.js` 已定义接口，实现为空 |
| 双人 Conference 翻译 | 架构设计完成 | 代码未实现 |

---

## 2. 技术栈

| 层 | 技术 | 版本/说明 |
|----|------|-----------|
| 运行时 | Node.js | v20+，ES Modules |
| Web 框架 | Express.js | v4.21 |
| WebSocket | ws | v8.18 |
| 环境变量 | dotenv | v16.4 |
| 电话网关 | Twilio Voice + Media Streams | 入站通话 + 双向音频流 |
| AI 引擎 | OpenAI Realtime API | gpt-4o-realtime-preview-2024-12-17 |
| 隧道（开发） | ngrok | 将本地 5050 端口暴露到公网 |
| TTS 克隆（未启用） | ElevenLabs | 预留接口 |

---

## 3. 项目结构

```
AI_phone_call/
├── src/
│   ├── server.js             # 入口：Express HTTP + WebSocket 服务
│   ├── twilio-handler.js     # Twilio Media Streams 协议桥接
│   ├── openai-client.js      # OpenAI Realtime WebSocket 客户端
│   ├── prompts.js            # 翻译官系统提示词
│   ├── tts-bridge.js         # 音色克隆接口（MVP 未启用）
│   └── config.js             # 环境变量读取 + 校验
├── docs/
│   ├── technical-spec.md     # 本文档：完整技术规格
│   ├── architecture.md       # 系统架构与数据流
│   ├── api-flow.md           # 协议细节与消息时序
│   ├── setup.md              # 部署配置指南
│   └── voice-cloning.md      # 音色克隆方案设计
├── .env.example              # 环境变量模板
├── package.json
└── README.md
```

---

## 4. 系统架构

### 4.1 总体架构

```
+-------------+       PSTN        +-------------------+       WSS        +---------------------+
|   Caller    | ◄───────────────► |   Twilio Voice    | ◄──────────────► |   Node.js Server    |
|   (Phone)   |                   |   Media Streams   |   u-law 8kHz    |   (Express + ws)    |
+-------------+                   +-------------------+   base64 JSON    +----------┬----------+
                                                                                    │
                                                                                    │ WSS
                                                                                    │ g711_ulaw
                                                                                    ▼
                                                                         +---------------------+
                                                                         |  OpenAI Realtime    |
                                                                         |  ASR + LLM + TTS    |
                                                                         +---------------------+
```

### 4.2 为什么选 OpenAI Realtime API

传统方案 "Whisper -> GPT-4 -> TTS" 需要三次 API 调用，端到端延迟 2-4 秒，且需自行实现 VAD、分句、流式拼接。OpenAI Realtime API 将 ASR、LLM、TTS 整合到一条 WebSocket 连接中，延迟压至 300-800ms，并内置了 VAD 和语音打断支持。

代价是音色选择有限（8 个预设），因此项目预留了 `tts-bridge.js` 扩展位。

### 4.3 音频格式直通

这是低延迟的关键设计：Twilio Media Streams 使用 **u-law (G.711) 8kHz 单声道**，OpenAI Realtime 原生支持 `g711_ulaw` 格式。两端格式完全一致，服务器只做 **base64 字符串透传**，不做任何编解码或重采样。

```
Twilio 发: u-law 8kHz → base64 JSON   ──► 服务器透传 ──►  OpenAI (g711_ulaw)
OpenAI 回: g711_ulaw → base64         ──► 服务器透传 ──►  Twilio 播放
```

---

## 5. 模块详细设计

### 5.1 `server.js` -- 入口

| 端点 | 类型 | 功能 |
|------|------|------|
| `GET /health` | HTTP | 健康检查，返回 `{ ok: true }` |
| `POST /twilio/incoming-call` | HTTP | Twilio Webhook，返回 TwiML 指令 |
| `GET /twilio/incoming-call` | HTTP | 便于浏览器调试 |
| `/twilio/media-stream` | WebSocket | Twilio 双向音频流 |

服务启动时打印监听端口、语言对、音色等信息。默认端口 5050。

### 5.2 `twilio-handler.js` -- Twilio 桥接

两个核心函数：

**`handleIncomingCall(req, res)`**
- 生成 TwiML XML 响应
- 包含 `<Say>` 提示音（"正在接入 AI 实时翻译"）
- 包含 `<Connect><Stream>` 指令，让 Twilio 建立 WebSocket 连接

**`handleMediaStream(ws)`**
- 处理 Twilio WebSocket 生命周期事件：
  - `connected`: 连接确认
  - `start`: 获取 `streamSid`，创建 `OpenAIRealtimeClient` 实例并连接
  - `media`: 接收音频帧（每 20ms 一帧），转发给 OpenAI
  - `stop`: 通话结束，关闭 OpenAI 连接
- 监听 OpenAI 事件：
  - `audio`: 翻译音频到达，封装为 Twilio media 消息发回
  - `speech_started`: 用户开口，清空 Twilio 播放队列（barge-in）

### 5.3 `openai-client.js` -- OpenAI Realtime 客户端

继承 `EventEmitter`，封装 OpenAI Realtime WebSocket 协议。

**核心方法：**

| 方法 | 功能 |
|------|------|
| `connect()` | 建立 WSS 连接，带 Bearer Token 认证 |
| `_configureSession()` | 发送 `session.update`，配置翻译模式 |
| `sendAudio(base64)` | 转发音频到 OpenAI（经过回声抑制门控） |
| `close()` | 关闭连接 |

**Session 配置参数：**

```javascript
{
  modalities: ['text', 'audio'],
  voice: 'alloy',                           // 可通过 VOICE 环境变量更换
  input_audio_format: 'g711_ulaw',
  output_audio_format: 'g711_ulaw',
  input_audio_transcription: { model: 'whisper-1' },
  turn_detection: {
    type: 'server_vad',
    threshold: 0.65,
    prefix_padding_ms: 300,
    silence_duration_ms: 700
  },
  temperature: 0.6,
  instructions: TRANSLATOR_INSTRUCTIONS      // 翻译官提示词
}
```

**回声抑制机制：**

当 AI 正在通过 Twilio 播放翻译音频时，电话听筒的回声可能被麦克风拾取并送回 OpenAI，导致 AI "听到自己"并产生无限循环。解决方案：

1. AI 开始说话时设置 `aiSpeaking = true`
2. `sendAudio()` 检查此标志，若为 `true` 则丢弃入站音频
3. AI 说完后延迟 800ms 再释放门控，覆盖尾部回声

```
用户说话 ──► 正常转发 ──► OpenAI 处理
AI 说话   ──► aiSpeaking=true ──► 丢弃入站音频
AI 说完   ──► 等 800ms ──► aiSpeaking=false ──► 恢复转发
```

**处理的 OpenAI 事件：**

| 事件 | 处理 |
|------|------|
| `session.created` / `session.updated` | 日志 |
| `response.audio.delta` | 发射 `audio` 事件（翻译音频块） |
| `input_audio_buffer.speech_started` | 发射 `speech_started`，标记 AI 停止说话 |
| `input_audio_buffer.speech_stopped` | 日志 |
| `response.audio_transcript.done` | 日志打印完整翻译文本 |
| `input_audio_buffer.committed` | 标记 AI 开始说话 |
| `error` | 错误日志 |

### 5.4 `prompts.js` -- 翻译官提示词

系统提示词将 OpenAI Realtime 模型锁定为纯翻译官模式，核心规则：

1. 检测输入语言，输出对应翻译
2. **绝不回答问题**，只翻译问题本身
3. 不加"翻译："等前缀
4. 保留语气和情感
5. 保留专有名词不译
6. 即使是短语（"hello"、"嗯"）也翻译
7. 听不清时保持沉默
8. 上下文足够时立即开始输出

语言对通过 `SPEAKER_A_LANG` 和 `SPEAKER_B_LANG` 环境变量注入。

### 5.5 `config.js` -- 配置管理

启动时读取 `.env` 并校验必填项。缺少 `OPENAI_API_KEY` 立即 `process.exit(1)`。

### 5.6 `tts-bridge.js` -- 音色克隆预留

定义了 `createTTSBridge()` 工厂函数接口。当前实现仅抛出错误提示未实现。详细集成方案见 `docs/voice-cloning.md`。

---

## 6. 数据流：一次完整翻译的生命周期

```
时间线        Caller           Twilio              Server              OpenAI
────────────────────────────────────────────────────────────────────────────────
  t=0ms      拨号 ──────────►
                              POST /incoming ────►
                              ◄──── TwiML(Stream)
                              WS connect ────────►
                                                  WS connect ────────►
                                                  session.update ────►
                                                  ◄──── session.updated

  t+Xms      说"你好" ──────►
                              media(u-law) ──────►
                              (每20ms一帧)        sendAudio() ────────►
                                                  (透传 base64)

  t+300ms                                         ◄── speech_started
  t+700ms    停顿                                 ◄── speech_stopped

  t+350ms                                         ◄── response.audio.delta
                              ◄── media(u-law)    (翻译音频块)
             听到"Hello" ◄──

  t+500ms                                         ◄── response.audio.delta
                              ◄── media(u-law)    (更多音频块...)
             继续播放 ◄──

  t+800ms                                         ◄── response.audio.done
                                                  ◄── response.audio_transcript.done
                                                  日志: "translated: Hello"

  挂机       ──────────────►
                              stop ──────────────►
                                                  openai.close()
```

---

## 7. 环境变量

| 变量 | 必填 | 默认值 | 说明 |
|------|------|--------|------|
| `OPENAI_API_KEY` | 是 | -- | OpenAI API 密钥 |
| `PORT` | 否 | `5050` | 服务监听端口 |
| `OPENAI_MODEL` | 否 | `gpt-4o-realtime-preview-2024-12-17` | Realtime 模型 |
| `VOICE` | 否 | `alloy` | TTS 音色 (alloy/ash/ballad/coral/echo/sage/shimmer/verse) |
| `PUBLIC_HOST` | 否 | 从请求头自动获取 | 公网主机名（用于 TwiML 中的 WebSocket URL） |
| `SPEAKER_A_LANG` | 否 | `Chinese` | 第一语言 |
| `SPEAKER_B_LANG` | 否 | `English` | 第二语言 |
| `ENABLE_VOICE_CLONE` | 否 | `false` | 启用音色克隆（未实现） |
| `ELEVENLABS_API_KEY` | 否 | -- | ElevenLabs API 密钥 |
| `ELEVENLABS_VOICE_ID` | 否 | -- | ElevenLabs 音色 ID |

---

## 8. 外部服务依赖

### 8.1 Twilio Voice

- **用途**：接入 PSTN 电话网络，提供来电接听和双向音频流
- **协议**：HTTP Webhook（来电通知） + WebSocket（Media Streams 音频流）
- **配置**：在 Twilio Console 将号码的 Voice Webhook 指向 `/twilio/incoming-call`
- **成本**：约 $0.013/分钟（美国入站） + $1/月号码租金

### 8.2 OpenAI Realtime API

- **用途**：语音识别 (ASR) + 语言翻译 (LLM) + 语音合成 (TTS)，一站式处理
- **协议**：WebSocket (`wss://api.openai.com/v1/realtime`)
- **认证**：Bearer Token + `OpenAI-Beta: realtime=v1` 请求头
- **成本**：音频输入约 $0.06/分钟，音频输出约 $0.24/分钟

### 8.3 ngrok（仅开发环境）

- **用途**：将本地 5050 端口通过 HTTPS 隧道暴露到公网
- **替代**：生产环境直接部署到云服务器（Fly.io / Render / Railway / AWS）

---

## 9. 成本估算

### 单路通话每分钟成本

| 组件 | MVP（无克隆） | 路线 A（ElevenLabs 克隆） |
|------|--------------|--------------------------|
| Twilio 语音 | $0.013 | $0.013 |
| OpenAI 音频输入 | $0.06 | $0.06 |
| OpenAI 音频输出 | $0.24 | $0（关闭音频输出） |
| OpenAI 文本输出 | -- | $0.02 |
| ElevenLabs TTS | -- | $0.09 |
| **合计** | **$0.31** | **$0.18** |

音色克隆方案反而更便宜，因为省掉了 OpenAI 较贵的音频输出 token。

---

## 10. MVP 限制与安全事项

### 当前限制

1. **单人模式**：只支持一人对 AI 翻译，不支持两人跨语言通话
2. **8 种预设音色**：不支持自定义音色（音色克隆接口已预留）
3. **语音打断已禁用**：因真机回声消除不足，barge-in 功能未启用
4. **无持久化**：无数据库、通话记录或用户管理
5. **无速率限制**：恶意拨入可能导致高额账单

### 生产环境安全清单

- [ ] **Twilio Webhook 签名校验**：验证 `X-Twilio-Signature` 防止伪造请求
- [ ] **速率限制**：限制并发通话数和单通话时长
- [ ] **API Key 保护**：OpenAI Key 仅存服务端，不暴露到客户端
- [ ] **结构化日志**：接入 pino/winston，便于排查问题
- [ ] **监控告警**：接入 Sentry/DataDog，监控错误和延迟
- [ ] **HTTPS 强制**：生产环境必须全程 HTTPS/WSS

---

## 11. 未来演进路线

### 11.1 音色克隆

两条路线，推荐路线 A（详见 `docs/voice-cloning.md`）：

- **路线 A（推荐）**：OpenAI 只做 ASR+LLM，文本流送到 ElevenLabs/Cartesia 做克隆 TTS。额外延迟 100-300ms，但音色可完全自定义。
- **路线 B**：保留 OpenAI 音频输出，过一层 Voice Conversion（RVC/so-vits）。最小侵入但需要 GPU。

### 11.2 双人 Conference 模式

A 说中文 B 听英文，B 说英文 A 听中文：

```
A (中文) ──► Realtime #1 (zh→en) ──► 注入给 B
B (英文) ──► Realtime #2 (en→zh) ──► 注入给 A
```

- 使用 Twilio Conference 汇合两路通话
- `<Stream track="inbound_track">` 隔离各方音频
- 两条 Realtime 会话独立运行
- 核心挑战：静音原音，只播翻译

### 11.3 其他规划

- 支持更多语言对
- 通话质量指标监控（延迟、丢帧率）
- 通话录音与转写存档
- 多租户支持与计费
