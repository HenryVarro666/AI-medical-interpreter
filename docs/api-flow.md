# API 协议与消息时序

排查 bug 和做二次开发时的参考手册。

## 1. Twilio 侧

### 1.1 TwiML（我们的 HTTP 响应）

Twilio 打来 `POST /twilio/incoming-call` 时，我们返回：

```xml
<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="Polly.Zhiyu" language="zh-CN">正在接入 AI 实时翻译，请开始讲话。</Say>
  <Connect>
    <Stream url="wss://your-host/twilio/media-stream" />
  </Connect>
</Response>
```

- `<Say>` 用 Twilio 自带 TTS 放提示音，**不**走 OpenAI。可以删掉。
- `<Connect><Stream>` 让 Twilio 主动连一条 WebSocket 到我们，把通话音频双向打进这个 WS。通话持续期间 WS 保持打开。

### 1.2 Media Streams WS — 入站消息

Twilio 会在 WS 上按顺序发这些 JSON 消息：

```jsonc
// 1) 连接建立
{ "event": "connected", "protocol": "Call", "version": "1.0.0" }

// 2) 流开始
{
  "event": "start",
  "sequenceNumber": "1",
  "start": {
    "streamSid": "MZ...",
    "accountSid": "AC...",
    "callSid": "CA...",
    "tracks": ["inbound"],
    "mediaFormat": {
      "encoding": "audio/x-mulaw",
      "sampleRate": 8000,
      "channels": 1
    }
  },
  "streamSid": "MZ..."
}

// 3) 音频帧（每 20ms 一条，即每秒 50 条）
{
  "event": "media",
  "sequenceNumber": "2",
  "media": {
    "track": "inbound",
    "chunk": "1",
    "timestamp": "20",
    "payload": "<base64 of 160 bytes μ-law>"
  },
  "streamSid": "MZ..."
}

// 4) 通话结束
{ "event": "stop", "streamSid": "MZ..." }
```

### 1.3 Media Streams WS — 出站消息（我们发给 Twilio）

```jsonc
// 播放翻译音频给对方
{
  "event": "media",
  "streamSid": "MZ...",
  "media": { "payload": "<base64 μ-law>" }
}

// 清空 Twilio 播放队列（barge-in 用）
{ "event": "clear", "streamSid": "MZ..." }

// 打 mark，用于测量播放进度（MVP 未用）
{
  "event": "mark",
  "streamSid": "MZ...",
  "mark": { "name": "translation-end-42" }
}
```

[官方文档](https://www.twilio.com/docs/voice/media-streams/websocket-messages)

## 2. OpenAI Realtime 侧

### 2.1 连接

```
wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview-2024-12-17
Headers:
  Authorization: Bearer sk-...
  OpenAI-Beta:   realtime=v1
```

### 2.2 出站事件（我们发给 OpenAI）

```jsonc
// 会话配置（连接后立即发）
{
  "type": "session.update",
  "session": {
    "modalities": ["text", "audio"],
    "instructions": "... 翻译官提示词 ...",
    "voice": "alloy",
    "input_audio_format":  "g711_ulaw",
    "output_audio_format": "g711_ulaw",
    "input_audio_transcription": { "model": "whisper-1" },
    "turn_detection": {
      "type": "server_vad",
      "threshold": 0.5,
      "prefix_padding_ms": 300,
      "silence_duration_ms": 500
    },
    "temperature": 0.6
  }
}

// 推送用户音频（把 Twilio 的 payload 直接转发即可）
{
  "type": "input_audio_buffer.append",
  "audio": "<base64 μ-law>"
}
```

### 2.3 入站事件（OpenAI 发给我们）

按时序大致是：

```
session.created
session.updated
input_audio_buffer.speech_started          ← 用户开始说话
input_audio_buffer.speech_stopped          ← 用户停顿
conversation.item.input_audio_transcription.completed
                                           ← 原文（调试用）
response.created
response.output_item.added
response.content_part.added
response.audio_transcript.delta            ← 翻译文本（流式）
response.audio.delta                       ← 翻译音频（流式，base64 μ-law）
response.audio_transcript.delta            ...
response.audio.delta                       ...
response.audio.done
response.audio_transcript.done             ← 完整翻译文本
response.content_part.done
response.output_item.done
response.done
```

- 我们只**必须**处理 `response.audio.delta`（转发到 Twilio）和 `input_audio_buffer.speech_started`（触发 clear）。
- 其他事件用来打日志 / 观测。

[官方事件列表](https://platform.openai.com/docs/guides/realtime/events)

## 3. 完整消息时序图（一次问答）

```
 Caller        Twilio         Our Server          OpenAI Realtime
   │             │                 │                    │
   │  dial       │                 │                    │
   ├────────────▶│                 │                    │
   │             │ POST /incoming  │                    │
   │             ├────────────────▶│                    │
   │             │  TwiML(Stream)  │                    │
   │             │◀────────────────┤                    │
   │             │  WS connect     │                    │
   │             ├────────────────▶│                    │
   │             │                 │   WS connect       │
   │             │                 ├───────────────────▶│
   │             │                 │   session.update   │
   │             │                 ├───────────────────▶│
   │             │                 │◀───session.updated─┤
   │  "你好"     │                 │                    │
   ├────────────▶│  media (μ-law)  │                    │
   │             ├────────────────▶│ input_audio_buffer │
   │             │                 ├───────────────────▶│
   │             │                 │                    │ (VAD)
   │             │                 │◀─speech_started────┤
   │             │                 │◀─speech_stopped────┤
   │             │                 │◀─response.audio────┤
   │             │  media (μ-law)  │   .delta           │
   │             │◀────────────────┤                    │
   │ "hello"     │                 │                    │
   │◀────────────┤                 │                    │
   │  ...        │                 │                    │
```

## 4. 调试技巧

- **看不到任何 OpenAI 入站事件**：通常是 WS URL 写错或 key 无权限。打开 `console.log(data.toString())` 全量打印。
- **音频听起来像噪音**：格式不匹配。确认 `input_audio_format` 和 `output_audio_format` 都是 `g711_ulaw`，不是 `pcm16`。
- **翻译"断断续续"**：`silence_duration_ms` 太短，VAD 把一句话切成多段。调大到 700–1000。
- **AI 一直不说话**：`speech_stopped` 没触发。对着电话说长一点再停。或者把 `threshold` 降到 0.3（更敏感）。
- **要看完整事件日志**：在 `src/openai-client.js` 的 `_handleEvent` 开头加 `console.log('[raw]', event.type)`。

## 5. 安全提醒（生产环境必做）

- Twilio webhook 要校验签名（`X-Twilio-Signature`），否则任何人都能伪造请求触发你的 OpenAI 消耗。
- OpenAI key 不要写进前端或客户端。
- 做速率限制和通话时长上限，防止恶意拨入跑爆账单。
