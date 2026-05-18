# 技术架构

## 1. 一图看懂

```
                                        +---------------------+
                                        |   OpenAI Realtime   |
                                        |   (ASR + LLM + TTS) |
                                        +----------▲----------+
                                                   │ WSS
                                                   │ g711_ulaw 8kHz
                                                   │
  +-----------+        PSTN         +--------------┴--------------+
  |  Caller   | ─────────────────▶  |  Twilio Voice               |
  |   📱      |  ◀─────────────────  |  + Media Streams (WS)       |
  +-----------+                     +--------------┬--------------+
                                                   │ WSS
                                                   │ μ-law 8kHz (base64)
                                                   │
                                        +----------▼----------+
                                        |  Our Node.js Server |
                                        |  (Express + ws)     |
                                        |                     |
                                        |  twilio-handler.js  |
                                        |  openai-client.js   |
                                        |  tts-bridge.js(*)   |
                                        +---------------------+

(*) tts-bridge.js 是音色克隆预留位，MVP 未启用。
```

## 2. 为什么选 OpenAI Realtime 而不是 "Whisper → GPT → TTS" 三段式？

| 方案 | 端到端延迟 | 开发复杂度 | 音色自然度 |
|---|---|---|---|
| Whisper → GPT-4 → ElevenLabs | 2–4s | 高（要自己做 VAD、分句、流式拼接） | 高 |
| **OpenAI Realtime API** | **300–800ms** | 低（一条 WS 搞定） | 中-高 |
| Twilio + Gemini Live | 类似 | 低 | 类似 |

Realtime API 在服务端做了 VAD、语音打断、流式 TTS，省掉大量胶水代码；缺点是目前只支持 8 个预设音色——这就是为什么需要 `tts-bridge.js` 扩展位。

## 3. 关键设计点

### 3.1 音频格式一路直通

Twilio Media Streams 用 **μ-law 8 kHz**（电话标准），OpenAI Realtime 支持 `g711_ulaw` 作为输入输出格式。两端格式完全一致，我们只要**透传 base64 字符串**，不做任何编解码或重采样。这是延迟能压到亚秒级的关键。

> 一旦启用音色克隆（走 PCM 的第三方 TTS），就必须做 μ-law ↔ PCM16 的转换，延迟会涨 100–300 ms——详见 [voice-cloning.md](voice-cloning.md)。

### 3.2 服务端 VAD + 支持打断

`session.update` 里开启了 `turn_detection: server_vad`。OpenAI 会自己判断说话何时开始/结束，我们只管推音频。

当用户在 AI 还在说话时开口（barge-in），`input_audio_buffer.speech_started` 事件会触发，我们立刻给 Twilio 发 `{ event: "clear" }` 丢掉还没播的翻译音频——这是打断体验流畅的关键。

```js
// src/twilio-handler.js
openai.on('speech_started', () => {
  clearTwilioPlayback();
});
```

### 3.3 翻译而不是对话：提示词是关键

Realtime 模型默认"健谈"，给它一句音频它会当作问题回答。我们用系统提示词**把它锁死成翻译官**（见 `src/prompts.js`）。测试里容易出现的坑：

- 用户说"What's your name?" → 模型回答名字，而不是翻译这句问题。提示词里必须明示"translate the QUESTION, do not answer it"。
- 用户说"hello" → 模型可能直接当招呼回。提示词里列了短语例子强制翻译。
- 模型主动加"译文是..."前缀 → 明确禁止。

## 4. 模块职责

| 文件 | 职责 |
|---|---|
| `src/server.js` | HTTP + WS 监听入口；路由挂载；启动日志 |
| `src/twilio-handler.js` | TwiML 生成、Twilio Media Streams 协议解析、事件路由 |
| `src/openai-client.js` | OpenAI Realtime WebSocket 连接、`session.update` 配置、事件转发 |
| `src/tts-bridge.js` | 音色克隆接口占位；当前抛错提醒未实现 |
| `src/prompts.js` | 翻译官系统提示词（语言对可通过 env 配置） |
| `src/config.js` | `.env` 解析 + 必填项校验 |

## 5. 数据流（单次"用户说一句话"的生命周期）

```
[0ms]    用户开口说"你好"
[20ms]   Twilio 把 μ-law 音频分片发到 our WS  ─┐
                                              │ (每 20ms 一片)
[20ms+]  we forward each chunk to OpenAI     ─┘
[~300ms] 用户停顿，OpenAI 服务端 VAD 判定句末
[~320ms] OpenAI 触发 input_audio_buffer.speech_stopped
[~350ms] 模型开始生成英文翻译（流式）
[~400ms] 第一个 response.audio.delta 到达
         → 直接 forward 回 Twilio
[~420ms] 用户手机听到 "hello"
```

端到端首字延迟约 400–500ms，视网络情况。

## 6. 未来: 双人 Conference 模式

当前 MVP 是单人对 AI。要实现"A 说中文 B 听英文、B 说英文 A 听中文"的真·双人通话：

```
+--------+                               +--------+
|   A    |                               |   B    |
+---┬----+                               +----┬---+
    │ 中文                                    │ 英文
    ▼                                         ▼
+-------------------------------------------------+
|              Twilio Conference                  |
|  (两路通话汇入一个 conference room)             |
+----┬-------------------------------------┬------+
     │ fork-stream                         │ fork-stream
     │ 只听 A                              │ 只听 B
     ▼                                     ▼
+---------------+                  +---------------+
| Realtime #1   |                  | Realtime #2   |
| zh → en       |                  | en → zh       |
+-------┬-------+                  +-------┬-------+
        │ 英文 TTS                         │ 中文 TTS
        ▼                                  ▼
     注入给 B                           注入给 A
```

技术要点：
- Twilio 的 `<Stream track="inbound_track">` 可以只录取某一方的音频。
- 输出用 `<Dial><Conference>` + `WhisperUrl` 或者 `<Play>` 到指定参与者。
- 两条 Realtime 会话独立运行，互不干扰。
- 核心挑战：保证 B 听到的英文不会被 A 的中文 passthrough 覆盖（需要把 A 的原音静音掉，只放翻译）。

这是后续迭代方向，当前代码没有实现。
