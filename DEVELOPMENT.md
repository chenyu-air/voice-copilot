# 皮皮语音助手 - 开发文档

## 1. 项目概述

皮皮语音助手是一个基于本地大模型的语音对话系统，前端为H5页面，后端通过WebSocket对接Ollama本地大模型，实现实时语音对话。用户通过手机浏览器访问，语音输入问题，本地大模型推理后通过语音输出结果。

### 核心特性

- **语音输入**：科大讯飞ASR实时语音识别
- **大模型推理**：Ollama本地部署，流式输出
- **语音输出**：edge-tts高质量中文语音合成
- **长文本优化**：分段合成 + 后端并发 + 前端逐段拉取播放
- **移动端适配**：支持iOS/Android，安全区域适配，连续对话模式

---

## 2. 系统架构

```
┌─────────────────────────────────────────────────────────┐
│                    手机浏览器 (H5)                        │
│  ┌──────────┐  ┌──────────┐  ┌───────────────────────┐  │
│  │ 录音采集  │  │ 文本输入  │  │ 音频播放              │  │
│  │ MediaRec │  │ TextInput│  │ Audio API             │  │
│  └────┬─────┘  └────┬─────┘  └───────────┬───────────┘  │
│       │              │                     │              │
│  ┌────▼──────────────▼─────────────────────▼───────────┐  │
│  │              WebSocket / HTTP Client                │  │
│  └────────────────────┬────────────────────────────────┘  │
└───────────────────────┼──────────────────────────────────┘
                        │ WSS (HTTPS)
                        │
┌───────────────────────▼──────────────────────────────────┐
│              Node.js 服务 (server.js :3000)              │
│                                                         │
│  ┌─────────────┐  ┌──────────────┐  ┌────────────────┐  │
│  │ WebSocket   │  │ TTS 批量接口  │  │ ASR 代理接口   │  │
│  │ 流式对话    │  │ /api/tts/*   │  │ /api/asr       │  │
│  └──────┬──────┘  └──────┬───────┘  └───────┬────────┘  │
│         │                │                   │           │
│  ┌──────▼──────┐  ┌──────▼───────┐  ┌───────▼────────┐  │
│  │ Ollama API  │  │ edge-tts CLI │  │ Python ASR服务  │  │
│  │ :11434      │  │ (spawn)      │  │ :5002          │  │
│  └─────────────┘  └──────────────┘  └───────┬────────┘  │
│                                              │           │
│                                     ┌────────▼────────┐  │
│                                     │ 讯飞 ASR WebSocket│ │
│                                     │ wss://iat-api... │  │
│                                     └─────────────────┘  │
└─────────────────────────────────────────────────────────┘
```

---

## 3. 服务拆分

### 3.1 Node.js 主服务 (server.js, 端口 3000)

核心网关，负责：
- HTTPS服务 + WebSocket流式对话
- TTS批量合成接口（调用edge-tts CLI）
- ASR代理接口（转发到Python ASR服务）
- 静态文件服务（H5页面）
- Ollama模型管理

### 3.2 Python ASR服务 (asr_service.py, 端口 5002)

独立微服务，负责：
- 接收Base64编码的WAV音频
- 剥离WAV头，提取PCM数据
- 按帧分片发送到讯飞ASR WebSocket
- 返回识别文本

### 3.3 edge-tts (CLI工具，非服务)

通过 `python -m edge_tts` 调用，不是常驻服务。Node.js通过 `child_process.spawn` 按需启动，每次生成一段MP3音频。

---

## 4. API 接口文档

### 4.1 WebSocket (流式对话)

**连接地址**: `wss://<host>:3000/`

**消息协议**:

| 方向 | type | 字段 | 说明 |
|------|------|------|------|
| → 发送 | `chat` | `model`, `messages` | 发起对话请求 |
| ← 接收 | `stream` | `content` | 流式内容片段 |
| ← 接收 | `done` | - | 本轮回复结束 |
| ← 接收 | `error` | `message` | 错误信息 |

**请求示例**:
```json
{
  "type": "chat",
  "model": "qwen2.5-7b-instruct:latest",
  "messages": [
    { "role": "user", "content": "你好" }
  ]
}
```

### 4.2 TTS 批量接口

#### POST /api/tts/batch - 批量提交

接收所有分段文本，后端并发生成音频，返回batchId。

**请求**:
```json
{
  "segments": ["第一段文本...", "第二段文本...", "..."]
}
```

**响应**:
```json
{
  "batchId": "batch_1784827059834_a17pcml2b",
  "total": 12
}
```

#### GET /api/tts/segment/:batchId/:index - 拉取单段

拉取指定段的音频，如果该段尚未生成完成，请求会阻塞等待（最长30秒）。

**响应**: `audio/mp3` 二进制数据

#### DELETE /api/tts/batch/:batchId - 清理

清理后端batch内存数据。

#### POST /api/tts - 单段TTS（兼容保留）

**请求**: `{ "text": "要合成的文本" }`
**响应**: `audio/mp3` 二进制数据

### 4.3 ASR 接口

#### POST /api/asr

**请求**:
```json
{
  "audio": "<base64编码的WAV音频>"
}
```

**响应**:
```json
{
  "text": "识别出的文字"
}
```

### 4.4 其他接口

| 接口 | 方法 | 说明 |
|------|------|------|
| `/api/models` | GET | 获取Ollama可用模型列表 |
| `/api/health` | GET | 健康检查 |

---

## 5. 关键技术实现

### 5.1 流式对话 (WebSocket + Ollama)

```
前端发送 chat 消息
    ↓
Node.js 收到后，向 Ollama /api/chat 发起 POST 请求 (stream: true)
    ↓
Ollama 逐行返回 JSON (每行一个token片段)
    ↓
Node.js 解析每行，通过 WebSocket 转发给前端:
    { type: "stream", content: "token内容" }
    ↓
Ollama 返回 done: true
    ↓
Node.js 发送: { type: "done" }
    ↓
前端收到 done → 触发 TTS 语音播放
```

**关键代码**: [server.js L384-L472](file:///e:/AI/trae_projects/pipi_copilot/server.js#L384-L472)

### 5.2 语音识别 (科大讯飞 ASR)

#### 流程

```
前端 MediaRecorder 录制 WAV → Base64编码 → POST /api/asr
    ↓
Node.js 转发到 Python ASR服务 (:5002)
    ↓
Python服务:
  1. Base64解码 → WAV数据
  2. 剥离WAV头 (前44字节) → PCM原始数据
  3. 按1280字节/帧分片
  4. 连接讯飞WebSocket (wss://iat-api.xfyun.cn/v2/iat)
  5. 逐帧发送 (首帧 status=0, 中间帧 status=1, 末帧 status=2)
  6. 接收识别结果，拼接文本
  7. 返回 { text: "识别结果" }
```

**鉴权**: HMAC-SHA256签名，Base64编码后URL编码

**关键文件**: [asr_service.py](file:///e:/AI/trae_projects/pipi_copilot/asr_service.py)

### 5.3 语音合成 (edge-tts)

#### 基本调用

```javascript
spawn('python', ['-m', 'edge_tts',
    '--text', text,
    '--voice', 'zh-CN-XiaoyiNeural',
    '--rate', '+0%',
    '--volume', '+0%',
    '--write-media', tempFile
]);
```

- **音色**: `zh-CN-XiaoyiNeural`（小艺，女声）
- **输出格式**: MP3
- **临时文件**: 唯一命名 `temp_tts_<timestamp>_<random>.mp3`，读入内存后立即删除

#### 重试机制

每段TTS生成最多重试2次，失败间隔1秒：
```javascript
async function generateEdgeTTSWithRetry(text, index, batchId) {
    for (let attempt = 1; attempt <= 2; attempt++) {
        try {
            return await generateEdgeTTS(text);
        } catch (e) {
            if (attempt < 2) await delay(1000);
            else return null;  // 标记为失败
        }
    }
}
```

---

## 6. 长文本TTS方案（核心）

### 6.1 方案演进

经历了三个阶段：

| 阶段 | 方案 | 问题 |
|------|------|------|
| V1 | 整段文本一次性合成 | 长文本延迟大，edge-tts易超时 |
| V2 | 按标点逐句合成 + 串行播放 | 句间停顿明显，延迟累积 |
| V3 | ≥40字分段 + 滑动窗口预取 | 前端内存堆积，偶发段超时 |
| **V4 (最终)** | **≥40字分段 + 后端并发 + 前端逐段拉取** | **稳定，内存最优** |

### 6.2 最终方案架构 (V4)

```
┌─────────────── 前端 ───────────────────┐
│                                       │
│  1. 文本按≥40字分段                     │
│  2. POST /api/tts/batch (发送所有分段)  │
│  3. 逐段拉取播放:                      │
│                                       │
│     GET /segment/batchId/0            │
│     → 播放段1 (9.5s)                   │
│     GET /segment/batchId/1            │
│     → 播放段2 (14.7s)                  │
│     ...                               │
│     GET /segment/batchId/N            │
│     → 播放段N                         │
│                                       │
│  4. DELETE /api/tts/batch/batchId     │
│     清理后端内存                       │
│                                       │
│  ★ 前端内存中始终只有1个Blob           │
└───────────────────────────────────────┘
         │ HTTP
┌────────▼────────── 后端 ──────────────┐
│                                       │
│  POST /api/tts/batch 收到后:          │
│                                       │
│  并发spawn N个edge-tts进程:           │
│  ┌─────┐ ┌─────┐ ┌─────┐ ┌─────┐    │
│  │段1  │ │段2  │ │段3 │ │段N  │    │
│  │tts  │ │tts  │ │tts │ │tts  │    │
│  └──┬──┘ └──┬──┘ └──┬──┘ └──┬──┘    │
│     │       │       │       │        │
│     ▼       ▼       ▼       ▼        │
│  promises[0..N] 存储在Map中          │
│                                       │
│  GET /segment/batchId/index:          │
│  → await promises[index]              │
│  → 就绪则立即返回Buffer               │
│  → 未就绪则阻塞等待                    │
│                                       │
│  ★ 每段失败自动重试1次                │
└───────────────────────────────────────┘
```

### 6.3 文本分段算法

**规则**: 累积字符 ≥40 时，遇到句子结束符（。！？.!?;\n）才分割

```javascript
function splitTextToSegments(text) {
    const result = [];
    let buffer = '';

    for (let i = 0; i < text.length; i++) {
        buffer += text[i];

        if (buffer.length >= 40 && /[。！？.!?;\n]/.test(text[i])) {
            const segment = buffer.trim();
            if (segment) result.push(segment);
            buffer = '';
        }
    }

    const remaining = buffer.trim();
    if (remaining) result.push(remaining);

    return result;
}
```

**示例**:
```
输入: "从前有一个村庄，村子里住着许多善良的村民们。一天晚上天气格外寒冷。"

输出: ["从前有一个村庄，村子里住着许多善良的村民们。一天晚上天气格外寒冷。"]
(整段不到40字+结束符，合并为1段)
```

### 6.4 后端批量生成实现

```javascript
// 批量TTS存储
const ttsBatches = new Map();

// 自动清理过期batch（5分钟）
setInterval(() => {
    const now = Date.now();
    for (const [id, batch] of ttsBatches) {
        if (now - batch.createdAt > 300000) {
            ttsBatches.delete(id);
        }
    }
}, 60000);

// 批量接口 - 并发生成所有分段
app.post('/api/tts/batch', async (req, res) => {
    const { segments } = req.body;
    const batchId = `batch_${Date.now()}_${Math.random()...}`;

    // 并发发起所有分段，每段失败自动重试
    const promises = segments.map((text, index) =>
        generateEdgeTTSWithRetry(text, index, batchId)
    );

    // 存储Promise（不是Buffer），实现"就绪即返回"
    ttsBatches.set(batchId, { promises, total: segments.length, createdAt: Date.now() });
    res.json({ batchId, total: segments.length });
});

// 拉取接口 - await Promise，就绪即返回
app.get('/api/tts/segment/:batchId/:index', async (req, res) => {
    const batch = ttsBatches.get(req.params.batchId);
    const buffer = await batch.promises[parseInt(req.params.index)];

    if (!buffer) return res.status(500).json({ error: 'segment generation failed' });

    res.set('Content-Type', 'audio/mp3');
    res.send(buffer);
});
```

**关键设计**: 存储 `Promise` 而非 `Buffer`，这样拉取接口 `await promise` 时：
- 已完成 → 立即返回
- 未完成 → 自动阻塞等待，无需轮询

### 6.5 前端逐段拉取播放

```javascript
async function tryBackendTTS(text) {
    // 1. 分段
    const segments = splitTextToSegments(text);

    // 2. 批量提交
    const { batchId, total } = await fetch('/api/tts/batch', {
        method: 'POST',
        body: JSON.stringify({ segments })
    }).then(r => r.json());

    // 3. 逐段拉取播放
    for (let i = 0; i < total; i++) {
        const blob = await fetchSegment(batchId, i);  // 拉取
        if (blob) {
            await playAudioBlob(blob, i);  // 播放（等播完再拉下一段）
        }
    }

    // 4. 清理
    fetch(`/api/tts/batch/${batchId}`, { method: 'DELETE' });
}
```

### 6.6 播放容错机制

每段播放独立try/catch + 3次重试：

```javascript
async function playAudioBlob(blob, segIndex) {
    for (let retry = 0; retry < 3; retry++) {
        try {
            await new Promise((resolve, reject) => {
                const audio = new Audio(URL.createObjectURL(blob));
                audio.onended = resolve;
                audio.onerror = () => reject(new Error(`code=${audio.error.code}`));
                audio.play().catch(reject);
            });
            return;  // 成功
        } catch (e) {
            if (retry < 2) await delay(200);
        }
    }
    throw new Error('3次重试均失败');
}
```

**主循环容错**: 一段失败不中断后续段：
```javascript
for (let i = 0; i < total; i++) {
    const blob = await fetchSegment(batchId, i);
    if (blob) {
        try {
            await playAudioBlob(blob, i);
        } catch (e) {
            log(`段${i+1} 播放失败，跳过继续`);  // 继续下一段
        }
    }
}
```

---

## 7. 前端架构

### 7.1 页面结构

```
┌─────────────────────────────┐
│  Header (安全区域适配)        │
│  [连接状态] [模型选择▼]       │
├─────────────────────────────┤
│                             │
│  Chat Area (对话区域)        │
│  ┌─────────────────────┐    │
│  │ 👤 用户消息          │    │
│  └─────────────────────┘    │
│  ┌─────────────────────┐    │
│  │ 🎤 助手回复 (流式)   │    │
│  └─────────────────────┘    │
│                             │
├─────────────────────────────┤
│  [🎤 语音输入] [文本框] [发送]│  ← 底部安全区域
└─────────────────────────────┘
```

### 7.2 移动端适配

- **viewport**: `width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no`
- **高度**: `100dvh` (动态视口高度，解决iOS地址栏问题)
- **安全区域**: `env(safe-area-inset-top/bottom)`
- **模型名称**: `max-width: 120px; text-overflow: ellipsis` (防过长挤压布局)

### 7.3 音频播放解锁

iOS要求必须在用户手势中初始化音频播放：

```javascript
function unlockAudioPlay() {
    const silentAudio = new Audio('data:audio/wav;base64,...');
    silentAudio.volume = 0.01;
    silentAudio.play().then(() => {
        audioPlayUnlocked = true;
        silentAudio.pause();
    });
}
```

在用户点击发送/语音按钮时调用。

### 7.4 连续对话模式

```javascript
// 播放结束后自动开始下一轮监听
if (isContinuousMode) {
    setTimeout(() => startListening(), 300);
}
```

---

## 8. 文件结构

```
pipi_copilot/
├── server.js              # Node.js主服务 (HTTPS + WebSocket + TTS + ASR代理)
├── asr_service.py         # Python讯飞ASR微服务 (端口5002)
├── tts_service.py         # (已废弃，TTS改为Node.js直接调用CLI)
├── tts.ps1                # Windows TTS降级脚本 (已废弃)
├── package.json           # Node.js依赖配置
├── certs/
│   ├── cert.pem           # HTTPS证书
│   └── key.pem            # HTTPS密钥
└── public/
    ├── index.html         # 主H5页面
    ├── index_backup.html  # 备份
    ├── debug.html         # 调试页面
    └── *.html             # 其他测试页面
```

---

## 9. 依赖与环境

### 9.1 Node.js 依赖

```json
{
  "express": "^4.19.2",
  "cors": "^2.8.5",
  "ws": "^8.17.1",
  "node-fetch": "^3.3.2"
}
```

### 9.2 Python 依赖

```
edge-tts          # TTS语音合成 (pip install edge-tts)
fastapi           # ASR服务框架
uvicorn           # ASR服务运行器
websocket-client  # 讯飞WebSocket客户端
pydantic          # 数据模型
```

### 9.3 外部服务

| 服务 | 地址 | 说明 |
|------|------|------|
| Ollama | http://localhost:11434 | 本地大模型 |
| 讯飞ASR | wss://iat-api.xfyun.cn/v2/iat | 语音识别 |
| edge-tts | 微软在线TTS | 语音合成（免费，无需API Key） |

---

## 10. 启动指南

### 10.1 安装依赖

```bash
# Node.js依赖
cd pipi_copilot
npm install

# Python依赖
pip install edge-tts fastapi uvicorn websocket-client pydantic
```

### 10.2 配置

在 `server.js` 中配置讯飞API密钥：
```javascript
const IFLYTEK_APP_ID = 'your_app_id';
const IFLYTEK_API_KEY = 'your_api_key';
const IFLYTEK_API_SECRET = 'your_api_secret';
```

### 10.3 启动服务

```bash
# 1. 确保Ollama已运行
ollama serve

# 2. 启动ASR服务 (终端1)
python asr_service.py

# 3. 启动主服务 (终端2)
node server.js
```

### 10.4 访问

- 本地: `https://localhost:3000`
- 局域网: `https://<本机IP>:3000`

> 注意: 使用HTTPS是因为浏览器要求安全上下文才能使用MediaRecorder和Audio API。

---

## 11. 日志体系

前端所有关键环节都有日志输出，便于定位问题：

| 环节 | 日志示例 |
|------|---------|
| 分段 | `分割成 12 段` / `段3 (75字): "..."` |
| 批量提交 | `批量请求已接受，batchId=xxx，共12段` |
| 拉取 | `段1 拉取音频（超时30000ms）...` |
| 响应 | `段1 响应到达，状态=200，耗时2213ms` |
| 播放 | `段1 play()调用成功，开始播放` |
| 完成 | `段1 播放完成 ✓` |
| 失败 | `段6 ⚠️ 拉取失败: 500 ...` |
| 跳过 | `段6 无音频数据，跳过 ✗` |

后端日志示例：
```
[Batch batch_xxx] 收到 12 段文本，开始并发生成
[Batch batch_xxx] 段1 合成成功 (第1次)，size=57168
[Batch batch_xxx] 段6 第1次失败: edge-tts CLI failed with code 1
[Batch batch_xxx] 段6 合成成功 (第2次)，size=62208
```
