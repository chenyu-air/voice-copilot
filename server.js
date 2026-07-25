require('dotenv').config();
const express = require('express');
const http = require('http');
const https = require('https');
const fs = require('fs');
const WebSocket = require('ws');
const cors = require('cors');
const path = require('path');
const { exec } = require('child_process');

const app = express();

const useHttps = true;
let server;

if (useHttps) {
    const options = {
        key: fs.readFileSync(path.join(__dirname, 'certs', 'key.pem')),
        cert: fs.readFileSync(path.join(__dirname, 'certs', 'cert.pem'))
    };
    server = https.createServer(options, app);
} else {
    server = http.createServer(app);
}

const wss = new WebSocket.Server({ 
    server,
    perMessageDeflate: {
        zlibDeflateOptions: {
            chunkSize: 1024,
            memLevel: 7,
            level: 3
        },
        zlibInflateOptions: {
            chunkSize: 10 * 1024
        },
        clientNoContextTakeover: true,
        serverNoContextTakeover: true,
        serverMaxWindowBits: 10,
        concurrencyLimit: 10,
        threshold: 1024
    }
});

const OLLAMA_HOST = process.env.OLLAMA_HOST || 'http://localhost:11434';

app.use(cors({
    origin: '*',
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    credentials: true
}));

let availableModels = [];
let DEFAULT_MODEL = '';

async function loadModelsFromOllama() {
    return new Promise((resolve) => {
        console.log('\n📦 正在加载Ollama模型列表...');
        
        exec('ollama list', (error, stdout, stderr) => {
            if (error) {
                console.error('❌ 执行ollama list失败:', error.message);
                resolve(false);
                return;
            }
            
            if (stderr) {
                console.error('❌ ollama list输出错误:', stderr);
            }
            
            const lines = stdout.trim().split('\n');
            const models = [];
            
            for (let i = 1; i < lines.length; i++) {
                const parts = lines[i].split(/\s+/);
                if (parts.length > 0 && parts[0]) {
                    const modelName = parts[0];
                    models.push(modelName);
                    console.log(`   ✅ ${modelName}`);
                }
            }
            
            availableModels = models;
            
            if (models.length > 0) {
                DEFAULT_MODEL = models[0];
                console.log(`\n🎯 默认模型设置为: ${DEFAULT_MODEL}`);
                resolve(true);
            } else {
                console.log('\n⚠️ 未找到任何Ollama模型，请先拉取模型');
                DEFAULT_MODEL = process.env.DEFAULT_MODEL || 'Qwen3.5:latest';
                resolve(false);
            }
        });
    });
}

app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public'), {
    etag: false,
    lastModified: false,
    setHeaders: (res) => {
        res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
        res.setHeader('Pragma', 'no-cache');
        res.setHeader('Expires', '0');
    }
}));

const crypto = require('crypto');

// 从环境变量读取讯飞 API 配置（参考 .env.example）
const IFLYTEK_APP_ID = process.env.IFLYTEK_APP_ID || '';
const IFLYTEK_API_KEY = process.env.IFLYTEK_API_KEY || '';
const IFLYTEK_API_SECRET = process.env.IFLYTEK_API_SECRET || '';

function generateIflytekAuthUrl() {
    const url = 'wss://tts-api.xfyun.cn/v2/tts';
    const host = 'tts-api.xfyun.cn';
    const date = new Date().toUTCString();
    const algorithm = 'hmac-sha256';
    const headers = `host: ${host}\ndate: ${date}\nGET /v2/tts HTTP/1.1`;
    
    const hmac = crypto.createHmac('sha256', IFLYTEK_API_SECRET);
    hmac.update(headers);
    const signature = hmac.digest('base64');
    
    const authorizationOrigin = `api_key="${IFLYTEK_API_KEY}", algorithm="${algorithm}", headers="host date request-line", signature="${signature}"`;
    const authStr = Buffer.from(authorizationOrigin).toString('base64');
    
    return `${url}?authorization=${encodeURIComponent(authStr)}&date=${encodeURIComponent(date)}&host=${encodeURIComponent(host)}`;
}

const EDGE_TTS_URL = 'http://localhost:5001';
const IFLYTEK_ASR_URL = 'http://localhost:5002';

// edge-tts 生成单段音频（返回Buffer），含重试
function generateEdgeTTS(text) {
    const fs = require('fs');
    const { spawn } = require('child_process');
    const path = require('path');

    return new Promise((resolve, reject) => {
        const tempFile = path.join(__dirname, `temp_tts_${Date.now()}_${Math.random().toString(36).substr(2, 9)}.mp3`);

        const args = [
            '--text', text,
            '--voice', 'zh-CN-XiaoyiNeural',
            '--rate', '+0%',
            '--volume', '+0%',
            '--write-media', tempFile
        ];

        const child = spawn('python', ['-m', 'edge_tts', ...args]);

        child.on('close', (code) => {
            try {
                if (code === 0) {
                    fs.readFile(tempFile, (err, data) => {
                        try { if (fs.existsSync(tempFile)) fs.unlinkSync(tempFile); } catch (e) {}
                        if (err) {
                            reject(new Error('Failed to read audio file'));
                        } else {
                            resolve(data);
                        }
                    });
                } else {
                    try { if (fs.existsSync(tempFile)) fs.unlinkSync(tempFile); } catch (e) {}
                    reject(new Error(`edge-tts CLI failed with code ${code}`));
                }
            } catch (e) {
                reject(new Error('Unexpected error: ' + e.message));
            }
        });

        child.on('error', (err) => {
            try { if (fs.existsSync(tempFile)) fs.unlinkSync(tempFile); } catch (e) {}
            reject(new Error('Failed to spawn edge-tts: ' + err.message));
        });
    });
}

async function generateEdgeTTSWithRetry(text, index, batchId) {
    for (let attempt = 1; attempt <= 2; attempt++) {
        try {
            const buffer = await generateEdgeTTS(text);
            console.log(`[Batch ${batchId}] 段${index + 1} 合成成功 (第${attempt}次)，size=${buffer.length}`);
            return buffer;
        } catch (e) {
            console.error(`[Batch ${batchId}] 段${index + 1} 第${attempt}次失败: ${e.message}`);
            if (attempt < 2) {
                await new Promise(r => setTimeout(r, 1000));
            } else {
                console.error(`[Batch ${batchId}] 段${index + 1} 重试耗尽，标记为失败`);
                return null;
            }
        }
    }
}

// 批量TTS存储
const ttsBatches = new Map();

// 自动清理过期batch（5分钟）
setInterval(() => {
    const now = Date.now();
    for (const [id, batch] of ttsBatches) {
        if (now - batch.createdAt > 300000) {
            ttsBatches.delete(id);
            console.log(`[Batch ${id}] 已过期，自动清理`);
        }
    }
}, 60000);

// 批量TTS接口 - 并发生成所有分段
app.post('/api/tts/batch', async (req, res) => {
    const { segments } = req.body;
    if (!segments || !Array.isArray(segments) || segments.length === 0) {
        return res.status(400).json({ error: 'segments is empty' });
    }

    const batchId = `batch_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    console.log(`[Batch ${batchId}] 收到 ${segments.length} 段文本，开始并发生成`);

    // 并发发起所有分段，每段失败自动重试1次
    const promises = segments.map((text, index) =>
        generateEdgeTTSWithRetry(text, index, batchId)
    );

    ttsBatches.set(batchId, { promises, total: segments.length, createdAt: Date.now() });
    res.json({ batchId, total: segments.length });
});

// 拉取单段音频 - 等待就绪后返回
app.get('/api/tts/segment/:batchId/:index', async (req, res) => {
    const { batchId, index } = req.params;
    const idx = parseInt(index);

    const batch = ttsBatches.get(batchId);
    if (!batch) {
        return res.status(404).json({ error: 'batch not found' });
    }

    if (idx < 0 || idx >= batch.total) {
        return res.status(400).json({ error: 'invalid index' });
    }

    try {
        const buffer = await batch.promises[idx];
        if (!buffer) {
            return res.status(500).json({ error: 'segment generation failed' });
        }
        res.set('Content-Type', 'audio/mp3');
        res.send(buffer);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// 清理batch
app.delete('/api/tts/batch/:batchId', (req, res) => {
    const { batchId } = req.params;
    if (ttsBatches.has(batchId)) {
        ttsBatches.delete(batchId);
        console.log(`[Batch ${batchId}] 手动清理`);
    }
    res.json({ ok: true });
});

// TTS接口 - 单段（保留兼容）
app.post('/api/tts', async (req, res) => {
    const { text } = req.body;
    if (!text || !text.trim()) {
        return res.status(400).json({ error: 'text is empty' });
    }

    console.log(`TTS request: ${text.slice(0, 50)}${text.length > 50 ? '...' : ''}`);

    try {
        const buffer = await generateEdgeTTSWithRetry(text, 0, 'single');
        if (buffer) {
            res.set('Content-Type', 'audio/mp3');
            res.send(buffer);
        } else {
            res.status(500).json({ error: 'TTS failed' });
        }
    } catch (e) {
        console.error('edge-tts failed:', e.message);
        res.status(500).json({ error: 'TTS failed' });
    }
});

// 科大讯飞语音听写（ASR）鉴权
function generateIflytekAsrAuthUrl() {
    const url = 'wss://iat-api.xfyun.cn/v2/iat';
    const host = 'iat-api.xfyun.cn';
    const date = new Date().toUTCString();
    const algorithm = 'hmac-sha256';
    const headers = `host: ${host}\ndate: ${date}\nGET /v2/iat HTTP/1.1`;

    const hmac = crypto.createHmac('sha256', IFLYTEK_API_SECRET);
    hmac.update(headers);
    const signature = hmac.digest('base64');

    const authorizationOrigin = `api_key="${IFLYTEK_API_KEY}", algorithm="${algorithm}", headers="host date request-line", signature="${signature}"`;
    const authStr = Buffer.from(authorizationOrigin).toString('base64');

    return `${url}?authorization=${encodeURIComponent(authStr)}&date=${encodeURIComponent(date)}&host=${encodeURIComponent(host)}`;
}

app.post('/api/asr', async (req, res) => {
    const { audio } = req.body;
    if (!audio) {
        return res.status(400).json({ error: 'audio data is empty' });
    }

    console.log('ASR request received, audio base64 length:', audio.length);

    try {
        const asrResponse = await fetch(`${IFLYTEK_ASR_URL}/asr`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ audio })
        });

        if (!asrResponse.ok) {
            const errText = await asrResponse.text();
            throw new Error(`ASR service error: ${asrResponse.status} - ${errText}`);
        }

        const result = await asrResponse.json();
        console.log('iFlytek ASR result:', result.text);
        res.json({ text: result.text });
    } catch (e) {
        console.error('ASR failed:', e.message);
        res.status(500).json({ error: 'ASR failed: ' + e.message });
    }
});

app.get('/api/models', async (req, res) => {
    try {
        if (availableModels.length === 0) {
            await loadModelsFromOllama();
        }
        
        res.json({
            models: availableModels.map(name => ({ name })),
            defaultModel: DEFAULT_MODEL
        });
    } catch (error) {
        console.error('获取模型列表失败:', error);
        res.status(500).json({ error: '无法连接到Ollama服务', models: [], defaultModel: DEFAULT_MODEL });
    }
});

app.get('/api/health', (req, res) => {
    res.json({ 
        status: 'ok', 
        model: DEFAULT_MODEL,
        modelsCount: availableModels.length 
    });
});

let connectionIdCounter = 0;

wss.on('connection', (ws, req) => {
    const connectionId = ++connectionIdCounter;
    const clientIp = req.socket.remoteAddress;
    const timestamp = new Date().toISOString();
    
    console.log(`\n[WS-${connectionId}] 🔌 新的WebSocket连接建立`);
    console.log(`[WS-${connectionId}] 📍 客户端IP: ${clientIp}`);
    console.log(`[WS-${connectionId}] ⏰ 连接时间: ${timestamp}`);
    console.log(`[WS-${connectionId}] 👥 当前连接数: ${wss.clients.size}`);

    let currentRequest = null;

    ws.on('message', async (message) => {
        const msgTimestamp = new Date().toISOString();
        console.log(`\n[WS-${connectionId}] 📥 收到消息 [${msgTimestamp}]`);
        console.log(`[WS-${connectionId}] 📦 消息原始长度: ${message.length} 字节`);
        
        try {
            const data = JSON.parse(message.toString());
            console.log(`[WS-${connectionId}] 📋 消息类型: ${data.type}`);
            
            if (data.type === 'chat') {
                const model = data.model || DEFAULT_MODEL;
                const userMessage = data.messages?.[data.messages.length - 1]?.content || '';
                
                console.log(`[WS-${connectionId}] 🤖 使用模型: ${model}`);
                console.log(`[WS-${connectionId}] 💬 用户消息: ${userMessage.slice(0, 100)}${userMessage.length > 100 ? '...' : ''}`);
                console.log(`[WS-${connectionId}] 📝 消息历史长度: ${data.messages?.length || 0}`);
                
                if (currentRequest) {
                    console.log(`[WS-${connectionId}] ⚠️ 取消上一次请求`);
                    currentRequest.destroy();
                }

                console.log(`[WS-${connectionId}] 🚀 正在请求Ollama API: ${OLLAMA_HOST}/api/chat`);
                
                const url = new URL(`${OLLAMA_HOST}/api/chat`);
                const httpModule = url.protocol === 'https:' ? require('https') : require('http');
                
                const postData = JSON.stringify({
                    model: model,
                    messages: data.messages,
                    stream: true
                });

                const options = {
                    hostname: url.hostname,
                    port: url.port || (url.protocol === 'https:' ? 443 : 80),
                    path: url.pathname + url.search,
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Content-Length': Buffer.byteLength(postData)
                    }
                };

                let totalCharsReceived = 0;
                let buffer = '';

                const req = httpModule.request(options, (res) => {
                    console.log(`[WS-${connectionId}] ✅ Ollama API请求成功，状态码: ${res.statusCode}`);
                    console.log(`[WS-${connectionId}] 🔄 开始接收流式响应...`);

                    res.on('data', (chunk) => {
                        buffer += chunk.toString();
                        const lines = buffer.split('\n');
                        buffer = lines.pop() || '';

                        for (const line of lines) {
                            if (!line.trim()) continue;
                            
                            try {
                                const response = JSON.parse(line);
                                if (response.done) {
                                    console.log(`[WS-${connectionId}] 📤 发送完成信号`);
                                    ws.send(JSON.stringify({ type: 'done' }));
                                } else if (response.message?.content) {
                                    totalCharsReceived += response.message.content.length;
                                    console.log(`[WS-${connectionId}] 📤 发送数据片段 (累计${totalCharsReceived}字符): ${response.message.content.slice(0, 50)}${response.message.content.length > 50 ? '...' : ''}`);
                                    ws.send(JSON.stringify({
                                        type: 'stream',
                                        content: response.message.content
                                    }));
                                }
                            } catch (e) {
                                console.error(`[WS-${connectionId}] ❌ 解析Ollama响应行失败:`, e);
                                console.error(`[WS-${connectionId}] 📜 失败的行内容: ${line.slice(0, 200)}`);
                            }
                        }
                    });

                    res.on('end', () => {
                        console.log(`[WS-${connectionId}] 📭 流式响应接收完成，累计字符数: ${totalCharsReceived}`);
                    });

                    res.on('error', (e) => {
                        console.error(`[WS-${connectionId}] ❌ Ollama响应错误:`, e);
                        ws.send(JSON.stringify({ type: 'error', message: e.message }));
                    });
                });

                req.on('error', (e) => {
                    console.error(`[WS-${connectionId}] ❌ 请求Ollama失败:`, e);
                    ws.send(JSON.stringify({ type: 'error', message: e.message }));
                });

                req.write(postData);
                req.end();

                currentRequest = req;
            } else {
                console.log(`[WS-${connectionId}] ⚠️ 未知消息类型: ${data.type}`);
            }
        } catch (error) {
            console.error(`[WS-${connectionId}] ❌ WebSocket消息处理失败:`);
            console.error(`[WS-${connectionId}] 📋 错误详情:`, error);
            console.error(`[WS-${connectionId}] 📦 原始消息: ${message.toString().slice(0, 200)}`);
            
            ws.send(JSON.stringify({
                type: 'error',
                message: error.message
            }));
        }
    });

    ws.on('close', (code, reason) => {
        const closeTimestamp = new Date().toISOString();
        console.log(`\n[WS-${connectionId}] 🔒 WebSocket连接关闭 [${closeTimestamp}]`);
        console.log(`[WS-${connectionId}] 📊 关闭码: ${code}`);
        console.log(`[WS-${connectionId}] 📝 关闭原因: ${reason || '无'}`);
        console.log(`[WS-${connectionId}] 👥 当前连接数: ${wss.clients.size}`);
        
        if (currentRequest) {
            console.log(`[WS-${connectionId}] 🚫 取消正在进行的Ollama请求`);
            currentRequest.destroy();
        }
    });

    ws.on('error', (error) => {
        console.error(`\n[WS-${connectionId}] ❌ WebSocket错误:`);
        console.error(`[WS-${connectionId}] 📋 错误详情:`, error);
    });
});

const PORT = process.env.PORT || 3000;

async function startServer() {
    await loadModelsFromOllama();
    
    server.listen(PORT, '0.0.0.0', () => {
        console.log(`\n========================================`);
        console.log(`语音助手服务已启动`);
        console.log(`========================================`);
        console.log(`服务地址: http://localhost:${PORT}`);
        console.log(`局域网访问: http://192.168.xxx.xxx:${PORT}`);
        console.log(`默认模型: ${DEFAULT_MODEL}`);
        console.log(`Ollama地址: ${OLLAMA_HOST}`);
        console.log(`可用模型: ${availableModels.length} 个`);
        availableModels.forEach(m => console.log(`   - ${m}`));
        console.log(`========================================\n`);
    });
}

startServer();