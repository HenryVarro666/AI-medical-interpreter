# AI Medical Interpreter — 技术规格文档

> 最后更新：2026-05-19

## 1. 项目概述

基于 **Twilio Media Streams + OpenAI Realtime API (GA)** 的实时医疗电话翻译与问诊服务。

**两种运营模式：**

| 模式 | 功能 | AI 角色 |
|------|------|---------|
| **Translator** | 双向实时翻译 | 隐形翻译官，用户感觉在直接对话 |
| **Intake** | 结构化医疗问诊 | 主动引导患者，收集完整病历信息 |

**核心能力：**

- 端到端首字延迟 ~400-800ms（音频格式直通，零重采样）
- 实时 Web 转录仪表盘（WebSocket 推送）
- 通话结束自动生成 SOAP 格式医疗文档
- 混合语言（code-switching）支持
- HIPAA 合规审计日志
- 通话保护（速率限制 / 时长上限 / 静音检测自动挂断）
- Session 持久化（通话记录 + 文档自动保存到磁盘）
- 一键 Twilio Webhook 同步（无需手动登录 Twilio Console）

---

## 2. 技术栈

| 层 | 技术 |
|----|------|
| 运行时 | Node.js 20+，ES Modules |
| Web 框架 | Express 4 |
| WebSocket | ws 8 |
| 电话网关 | Twilio Voice + Media Streams |
| AI 实时翻译/对话 | OpenAI Realtime API (GA) |
| AI 文档生成 | OpenAI GPT-4o Chat Completions |
| AI 转录清洗 | OpenAI GPT-4o-mini（可选） |
| 前端 | 原生 HTML/JS/CSS（无框架） |
| 部署 | Docker / AWS EC2 + nginx |

---

## 3. 项目结构

```
AI_phone_call/
├── src/
│   ├── server.js              # Express + 双 WebSocket 入口
│   ├── twilio-handler.js      # Twilio Media Streams 桥接 + 参数传递
│   ├── openai-client.js       # OpenAI Realtime 客户端（多模型/多模式）
│   ├── session-manager.js     # 会话管理 + 转录广播 + 磁盘持久化
│   ├── dashboard-handler.js   # 仪表盘 WebSocket
│   ├── call-guard.js          # 速率限制 / 时长上限 / 静音检测
│   ├── twilio-sync.js         # Twilio Webhook URL 自动同步
│   ├── doc-generator.js       # GPT-4o SOAP 文档生成
│   ├── medical-prompts.js     # SOAP 文档提示词
│   ├── prompts.js             # Translator 模式提示词
│   ├── intake-prompts.js      # Intake 模式提示词
│   ├── transcript-cleaner.js  # 混合语言 ASR 纠错（可选）
│   ├── audit-logger.js        # HIPAA 审计日志
│   ├── tts-bridge.js          # 音色克隆预留接口
│   └── config.js              # 环境变量 + 校验
├── public/
│   ├── index.html             # 仪表盘页面
│   ├── dashboard.js           # 仪表盘前端逻辑
│   └── styles.css             # 样式
├── data/                      # 审计日志 + session 持久化（gitignore）
├── docs/                      # 技术文档
├── Dockerfile                 # 容器部署
└── CLAUDE.md                  # Claude Code 开发指南
```

---

## 4. 系统架构

```
来电 ──► Twilio POST /twilio/incoming-call
              │
              ├─ TwiML: <Say> 提示音 + <Stream> + <Parameter mode/model>
              │
              ▼
         Twilio WS ──► /twilio/media-stream
              │
         ┌────┴────┐
         │ server  │ on('upgrade') → 路由到 twilioWss 或 dashboardWss
         │  .js    │ 剥离 sec-websocket-extensions（防 ngrok 压缩冲突）
         └────┬────┘
              │
    ┌─────────┴─────────┐
    │ twilio-handler.js │
    │                   │
    │ start event:      │
    │  customParameters │ ← mode + model 从 <Parameter> 读取
    │  → createSession()│
    │  → new OpenAI     │
    │     RealtimeClient│
    │     (mode, model) │
    │                   │
    │ media event:      │
    │  → callGuard      │ ← 速率限制 / 静音检测
    │  → sendAudio()    │ ← echo gate 过滤
    │                   │
    │ stop/close:       │
    │  → endSession()   │ ← 触发 SOAP 生成 + 磁盘保存
    └─────────┬─────────┘
              │
    ┌─────────┴─────────┐
    │ openai-client.js  │
    │                   │
    │ 三种模型分支:      │
    │ ├─ conversation   │ → /v1/realtime (gpt-realtime, gpt-realtime-2)
    │ ├─ translate      │ → /v1/realtime/translations (gpt-realtime-translate)
    │ └─ whisper        │ → /v1/realtime/transcriptions (ASR only)
    │                   │
    │ 三种事件处理器:    │
    │ ├─ _handleConversationEvent() → response.output_audio.delta
    │ ├─ _handleTranslateEvent()    → session.output_audio.delta
    │ └─ _handleWhisperEvent()      → transcript.delta
    └───────────────────┘
              │
    ┌─────────┴─────────┐
    │ session-manager   │ → 转录存储 + WS 广播 + 磁盘持久化
    │   ↓               │
    │ dashboard WS      │ → 浏览器实时显示
    │   ↓               │
    │ doc-generator     │ → GPT-4o 生成 SOAP note
    │   ↓               │
    │ audit-logger      │ → 合规日志
    └───────────────────┘
```

---

## 5. OpenAI GA API 关键差异

项目使用 **GA API**（非 beta）。与旧文档/示例的区别：

| 项目 | GA API | 旧 Beta API |
|------|--------|-------------|
| 认证 | `Authorization: Bearer` | 需额外 `OpenAI-Beta: realtime=v1` |
| Session 类型 | `session.type: 'realtime'` | 不需要 |
| 音频格式 | `audio.input.format: { type: 'audio/pcmu' }` | `input_audio_format: 'g711_ulaw'` |
| 音色 | `audio.output.voice` | `voice`（顶层） |
| 模态 | `output_modalities` | `modalities` |
| 发送音频 | `input_audio_buffer.append`（conversation）/ `session.input_audio_buffer.append`（translate） | `input_audio_buffer.append` |
| 音频事件 | `response.output_audio.delta` | `response.audio.delta` |
| 转录事件 | `response.output_audio_transcript.done` | `response.audio_transcript.done` |

### Translate 模型特殊性

`gpt-realtime-translate` 使用完全不同的端点和事件体系：

- 端点: `/v1/realtime/translations`（非 `/v1/realtime`）
- 无 `instructions`、`voice`、`temperature` 参数
- 用 `audio.output.language` 指定目标语言
- 所有事件带 `session.` 前缀（如 `session.output_audio.delta`）
- 音频发送: `session.input_audio_buffer.append`（多一个 `session.` 前缀）
- 不支持 `audio/pcmu` 输入格式设置（需要原始 PCM16）— **当前不兼容 Twilio**

---

## 6. 两种模式详细对比

### 6.1 Translator 模式

| 配置项 | 值 |
|--------|-----|
| 提示词 | `TRANSLATOR_INSTRUCTIONS`（纯翻译，不回答问题） |
| 模型 | `gpt-realtime`（默认） |
| VAD threshold | 0.65 |
| silence_duration_ms | 700 |
| echo gate tail | 800ms |
| AI 先说话 | 否（等用户开口） |

**提示词核心规则：**
- 检测主导语言 → 翻译成另一种
- 混合语言：抓意思，保留药名/专有名词
- 绝不回答问题，只翻译
- 听不清就沉默

### 6.2 Intake 模式

| 配置项 | 值 |
|--------|-----|
| 提示词 | `INTAKE_INSTRUCTIONS`（结构化问诊） |
| 模型 | `gpt-realtime`（默认） |
| VAD threshold | 0.75（更高 → 忽略咳嗽/噪音） |
| prefix_padding_ms | 500（短脉冲不算说话） |
| silence_duration_ms | 1500（给患者更多思考时间） |
| idle_timeout_ms | 15000（15 秒无输入自动 reprompt） |
| echo gate tail | 2000ms（长问候需要更长 tail） |
| AI 先说话 | 是（发送 `response.create` 触发问候） |
| 初始 echo lock | 是（`aiSpeaking=true` 在问候前就设置） |

**问诊流程（17 步，每步一个问题）：**
1. 英语问候 + 语言选择
2. 全名
3. 姓名确认（中文用参考字确认，英文逐字拼写）
4. 出生日期
5. 主诉（今天怎么了）
6-8. 疼痛详情（程度/时间/加重缓解因素）
9. 用药
10. 过敏
11. 既往史/手术
12. 家族史（不理解时用大白话解释）
13. 烟酒
14. 总结确认
15. 还有其他吗
16. 告别

**特殊处理：**
- 噪音/咳嗽：不回应，等清晰语言
- "不知道"：接受并跳过，不重复问
- 临时语言切换："Can you explain in English?" → 英文解释后回到中文
- 永久语言切换："Let's use English" → 此后全用英文
- 60 秒沉默 → 系统警告；120 秒 → 自动挂断

---

## 7. 通话保护（call-guard.js）

| 层级 | 触发条件 | 动作 |
|------|---------|------|
| 并发限制 | 超过 `MAX_CONCURRENT_CALLS` | TwiML `<Hangup>` |
| 速率限制 | 同一号码超频 | TwiML `<Hangup>` |
| 时长上限 | 超过 `MAX_CALL_DURATION_MIN` | Twilio REST API 挂断 |
| 静音警告 | 60 秒无语音 | Dashboard 显示 system 警告 |
| 静音挂断 | 120 秒无语音 | Twilio REST API 挂断 |

---

## 8. 会话生命周期与持久化

```
active → ended → documenting → completed
  │                    │              │
  │ 转录累积中          │ GPT-4o       │ 保存到 data/sessions/<id>.json
  │ WS 实时广播        │ 生成 SOAP    │ Dashboard 显示文档
  │                    │              │
  │              失败时也设 completed（记录错误）
```

- 内存: `Map<sessionId, Session>`
- 磁盘: `data/sessions/<uuid>.json`（JSON，含转录 + 文档）
- 启动时: `_loadFromDisk()` 恢复历史 session
- 清理: 每 60 秒清除超过 TTL 的已结束 session

---

## 9. 仪表盘

### HTTP 端点

| 路径 | 方法 | 功能 |
|------|------|------|
| `/` | GET | 仪表盘页面（static） |
| `/health` | GET | 健康检查 + 活跃通话数 |
| `/api/sessions` | GET | 所有 session 列表 |
| `/api/sessions/:id` | GET | Session 详情 + 完整转录 |
| `/api/sessions/:id/document` | GET | SOAP 文档 |
| `/api/models` | GET | 可用模型列表 |
| `/api/public-host` | GET | 当前 ngrok 公网地址 |
| `/api/twilio-sync` | POST | 自动更新 Twilio Webhook URL |
| `/api/twilio-config` | GET | Twilio 凭证配置状态 |
| `/api/demo` | POST | 创建模拟 session（本地测试用） |

### WebSocket

| 路径 | 功能 |
|------|------|
| `/twilio/media-stream` | Twilio 音频流 |
| `/dashboard/ws?sessionId=<id>` | 实时转录推送 |

### Dashboard 功能

- 模式/模型选择 → 一键 Sync to Twilio
- Session 下拉菜单（新通话自动跳转）
- 实时转录（caller 蓝色 / translation 绿色 / system 黄色）
- 流式 delta 显示（逐词出现）
- 通话结束后自动显示 SOAP 文档
- Duration 计时器（session 非 active 时停止）

---

## 10. SOAP 文档生成

通话结束后，完整转录发送给 GPT-4o Chat Completions API，生成结构化 JSON：

```json
{
  "metadata": { "disclaimer": "AI-generated draft..." },
  "soapNote": {
    "subjective": {
      "chiefComplaint": "头疼三天",
      "historyOfPresentIllness": "...",
      "medications": "布洛芬 400mg BID",
      "allergies": "青霉素（皮疹）"
    },
    "assessment": { "summary": "...", "differentialDiagnosis": [...] },
    "plan": { "recommendations": [...], "followUp": "..." }
  },
  "extractedEntities": {
    "symptoms": [...], "medications": [...], "allergies": [...], "diagnoses": [...]
  }
}
```

Intake 模式的转录因为是结构化问答，生成的 SOAP 文档信息更完整。

---

## 11. 混合语言处理

三层方案：

| 层 | 机制 | 延迟影响 |
|----|------|---------|
| ASR | `WHISPER_LANGUAGE_HINT` 偏向主语言 | 无 |
| Prompt | 翻译/问诊提示词含 code-switching 规则 | 无 |
| Post-clean | GPT-4o-mini 纠正 ASR 错误（可选） | +200-400ms |

已知限制：句内频繁切换仍不稳定，Whisper 可能乱转写。

---

## 12. 环境变量

| 变量 | 必填 | 默认值 | 说明 |
|------|------|--------|------|
| `OPENAI_API_KEY` | 是 | — | OpenAI API 密钥 |
| `PORT` | 否 | 5050 | 服务端口 |
| `OPENAI_MODEL` | 否 | gpt-4o-realtime-preview-2024-12-17 | 默认 Realtime 模型 |
| `VOICE` | 否 | alloy | TTS 音色 |
| `PUBLIC_HOST` | 否 | 自动检测 | ngrok 公网地址 |
| `SPEAKER_A_LANG` | 否 | Chinese | 第一语言 |
| `SPEAKER_B_LANG` | 否 | English | 第二语言 |
| `DEFAULT_MODE` | 否 | translator | 默认会话模式 |
| `TWILIO_ACCOUNT_SID` | 否 | — | Twilio 凭证（自动同步用） |
| `TWILIO_AUTH_TOKEN` | 否 | — | Twilio 凭证 |
| `TWILIO_PHONE_NUMBER` | 否 | — | Twilio 号码 |
| `MAX_CONCURRENT_CALLS` | 否 | 5 | 最大并发通话 |
| `MAX_CALL_DURATION_MIN` | 否 | 30 | 通话时长上限（分钟） |
| `MAX_SILENCE_SEC` | 否 | 60 | 静音警告阈值（秒） |
| `RATE_LIMIT_MAX_CALLS` | 否 | 10 | 速率限制上限 |
| `SESSION_TTL_MINUTES` | 否 | 60 | 已结束 session 内存保留时间 |
| `ENABLE_TRANSCRIPT_CLEANING` | 否 | false | 启用 ASR 纠错 |
| `WHISPER_LANGUAGE_HINT` | 否 | — | ASR 语言偏向 (zh/en) |
| `DEBUG_LOG_TRANSCRIPTS` | 否 | false | 控制台打印转录（含 PHI） |

---

## 13. 成本估算

| 组件 | 每分钟成本 |
|------|-----------|
| Twilio 语音 | ~$0.013 |
| OpenAI Realtime 音频输入 | ~$0.06 |
| OpenAI Realtime 音频输出 | ~$0.24 |
| OpenAI GPT-4o SOAP 生成 | ~$0.01/次 |
| **通话合计** | **~$0.31/分钟** |

Demo 用量（每天几通测试）月总成本约 $20-25（含 AWS EC2 $18）。

---

## 14. 已知限制

1. 单人模式 — 双人 Conference 已设计未实现
2. `gpt-realtime-translate` 需要 PCM16 格式，与 Twilio 的 u-law 不兼容（需格式转换）
3. 中英频繁句内切换 ASR 不稳定（Whisper 限制）
4. Intake 模式 VAD 偶尔误触发（咳嗽/背景噪音），threshold 已调高到 0.75
5. 音色克隆接口预留但未实现
6. 无用户认证（UUID 作为访问令牌）
