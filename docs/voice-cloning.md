# 音色克隆集成方案

OpenAI Realtime 目前只支持 8 个预设音色（alloy / echo / shimmer 等）。
要用**你自己的声音**或**任意克隆音色**，需要把 TTS 这一环从 OpenAI 拆出来。
本文档给两条路线，推荐路线 A。

## 路线 A：文本分流 → 克隆 TTS（推荐）

### 思路

1. OpenAI Realtime **只当 ASR + LLM**，把音频输出关掉，只订阅 `response.text.delta`（或 `response.audio_transcript.delta`）。
2. 把生成的翻译**文本流**送到支持克隆音色 + 流式输出的 TTS（ElevenLabs Streaming、Cartesia、Fish Audio、Coqui XTTS 自托管均可）。
3. TTS 返回的音频（一般是 PCM 16-bit 24 kHz）重采样到 **μ-law 8 kHz**，base64 编码，塞回 Twilio。

```
 Twilio ──μ-law──▶ OpenAI Realtime (ASR + LLM only)
                        │
                        │ response.text.delta (流式文本)
                        ▼
                   ElevenLabs / Cartesia (cloned voice, streaming)
                        │
                        │ PCM 24 kHz
                        ▼
                   resample → μ-law 8 kHz → base64
                        │
                        ▼
                     Twilio ──▶ Caller
```

### 优点
- 音色可以是真·克隆（上传 3 分钟样本即可）。
- 文本分流，切 TTS 供应商很方便（ElevenLabs / Cartesia / 自建随便换）。
- 容错好：TTS 挂了不影响翻译逻辑。

### 缺点
- 比 OpenAI Realtime 内置音频多一段网络：**额外 100–300 ms 延迟**。
- 成本叠加（ElevenLabs Turbo 约 $0.09 / 1k 字符）。

### 落地步骤

1. 改 `src/openai-client.js` 的 `session.update`：
   ```js
   modalities: ['text'],         // 只要文本
   // 删掉 voice / output_audio_format
   ```
2. 订阅 `response.text.delta` 事件，作为文本片段推送给 TTS：
   ```js
   case 'response.text.delta':
     this.emit('text_delta', event.delta);
     break;
   case 'response.text.done':
     this.emit('text_done');
     break;
   ```
3. 实现 `src/tts-bridge.js`。ElevenLabs 流式示例（WebSocket 模式）：
   ```js
   // POST wss://api.elevenlabs.io/v1/text-to-speech/{voice_id}/stream-input
   //      ?model_id=eleven_turbo_v2_5
   //      &output_format=ulaw_8000       ← 重点：让 TTS 直接吐 μ-law 8 kHz
   //
   // 消息：
   //   { text: " ", voice_settings: { stability: 0.5, similarity_boost: 0.75 } }
   //   { text: "你好" }   ← 每来一段 delta 就发一次
   //   { text: "" }       ← 结束
   ```
   `output_format=ulaw_8000` 让 ElevenLabs 直接返回 μ-law 8 kHz，**省掉重采样**，这是减延迟的关键。
4. 在 `twilio-handler.js` 里把音频来源从 `openai.on('audio')` 改成 `ttsBridge.on('audio')`。

### 克隆音色怎么来
- ElevenLabs：Instant Voice Clone 上传 1–3 分钟清晰单人录音，几秒钟出 voice_id。
- 自建：XTTS v2 / OpenVoice v2 / F5-TTS 都可以自托管，输入一段参考音频实时克隆，但延迟通常高于 ElevenLabs。

## 路线 B：Voice Conversion（音频转音色）

### 思路

保留 OpenAI Realtime 的音频输出，把音频塞进一个**实时 voice conversion 模型**，只改音色不改内容。

```
OpenAI Realtime (audio: alloy) ──▶ Voice Converter (→ your cloned voice) ──▶ Twilio
```

候选：
- **ElevenLabs Voice Changer**（API 有，但实时性一般）。
- **RVC (Retrieval-based Voice Conversion)**：开源，GPU 推理，单卡可做实时。
- **so-vits-svc 4.x**：同类方案。

### 优点
- 不改翻译链路，最小侵入。
- 克隆数据需求小。

### 缺点
- 实时 VC 要 GPU，部署门槛高。
- 延迟和失真比路线 A 大。
- 依然受限于 OpenAI 输出的停顿/节奏。

## 路线选择建议

| 如果你... | 选 |
|---|---|
| 只想快速落地，能接受依赖 SaaS | **A + ElevenLabs** |
| 数据敏感，要完全自托管 | **A + XTTS v2 自建**（注意延迟 & GPU 成本） |
| 已经有 RVC 声学模型、想复用 | B |
| 做商用产品，音色许可很重要 | A（ElevenLabs 有明确音色许可协议） |

## 落地最小改动 checklist（路线 A + ElevenLabs）

- [ ] `.env` 填 `ENABLE_VOICE_CLONE=true` + `ELEVENLABS_API_KEY` + `ELEVENLABS_VOICE_ID`
- [ ] `src/openai-client.js` 的 `session.update` 改成 text-only
- [ ] 实现 `src/tts-bridge.js`（保持当前 `createTTSBridge()` 接口签名）
- [ ] `src/twilio-handler.js` 里在 `event: 'start'` 分支判断 `if (bridge) { ... } else { ... }`
- [ ] 对照 [api-flow.md](api-flow.md) 调 VAD 参数（克隆 TTS 的起播延迟不同）

## 成本估算（单路 1 分钟通话）

| 组件 | 路线 A (ElevenLabs Turbo) | MVP（无克隆） |
|---|---|---|
| Twilio 语音 | $0.013 | $0.013 |
| OpenAI Realtime 输入 | $0.06 | $0.06 |
| OpenAI Realtime 输出 | $0（关闭 audio 输出） | $0.24 |
| OpenAI Realtime 文本输出 | $0.02 | — |
| ElevenLabs | ~$0.09 | — |
| **合计** | **≈ $0.18** | **≈ $0.31** |

有意思的结论：**路线 A 其实可能更便宜**，因为省掉了 OpenAI 比较贵的 audio output token。
