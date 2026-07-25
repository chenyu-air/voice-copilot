# 皮皮语音助手

基于本地大模型的语音对话系统，支持语音输入、流式对话和语音输出。

## 功能特性

- 🎤 语音输入：科大讯飞 ASR 实时语音识别
- 🤖 大模型推理：Ollama 本地部署，流式输出
- 🔊 语音输出：edge-tts 高质量中文语音合成
- 📱 移动端适配：支持 iOS/Android，连续对话模式

## 技术栈

- **前端**：HTML5 + CSS3 + JavaScript（原生）
- **后端**：Node.js + Express + WebSocket
- **ASR**：Python + FastAPI + 科大讯飞 WebSocket
- **TTS**：edge-tts（微软在线 TTS）
- **LLM**：Ollama（本地部署）

## 快速开始

### 1. 安装依赖

```bash
# Node.js 依赖
npm install

# Python 依赖
pip install fastapi uvicorn websocket-client pydantic edge-tts python-dotenv
```

### 2. 配置环境变量

复制 `.env.example` 为 `.env` 并填写讯飞 API 配置：

```bash
cp .env.example .env
```

### 3. 启动服务

```bash
# 1. 确保已安装并运行
ollama serve

# 2. 启动 ASR 服务（终端 1）
python asr_service.py

# 3. 启动主服务（终端 2）
node server.js
```

### 4. 访问

- 本地：`https://localhost:3000`
- 局域网：`https://<本机IP>:3000`

> 使用 HTTPS 是因为浏览器要求安全上下文才能使用麦克风和音频 API。

## 项目结构

```
pipi_copilot/
├── server.js              # Node.js 主服务（HTTPS + WebSocket + TTS + ASR 代理）
├── asr_service.py         # Python 讯飞 ASR 微服务（端口 5002）
├── package.json           # Node.js 依赖配置
├── .env.example           # 环境变量模板
├── certs/                 # HTTPS 证书（需自行生成，不包含在仓库中）
└── public/
    ├── index.html         # 主 H5 页面
    └── avatar.png         # 头像图片
```

## 环境变量

| 变量名 | 说明 | 默认值 |
|--------|------|--------|
| `IFLYTEK_APP_ID` | 讯飞应用 ID | - |
| `IFLYTEK_API_KEY` | 讯飞 API Key | - |
| `IFLYTEK_API_SECRET` | 讯飞 API Secret | - |
| `OLLAMA_HOST` | Ollama 服务地址 | `http://localhost:11434` |
| `PORT` | 主服务端口 | `3000` |

## 生成 HTTPS 证书

```bash
mkdir certs
openssl req -x509 -newkey rsa:4096 -keyout certs/key.pem -out certs/cert.pem -days 365 -nodes
```

## 许可证

MIT
