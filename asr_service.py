from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
import websocket
import json
import base64
import time
import hmac
import hashlib
import urllib.parse
import ssl
import os
from dotenv import load_dotenv

load_dotenv()

app = FastAPI(title="iFlytek ASR Service")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# 从环境变量读取讯飞 API 配置（参考 .env.example）
IFLYTEK_APP_ID = os.getenv('IFLYTEK_APP_ID', '')
IFLYTEK_API_KEY = os.getenv('IFLYTEK_API_KEY', '')
IFLYTEK_API_SECRET = os.getenv('IFLYTEK_API_SECRET', '')


class ASRRequest(BaseModel):
    audio: str


def generate_auth_url():
    url = 'wss://iat-api.xfyun.cn/v2/iat'
    host = 'iat-api.xfyun.cn'
    date = time.strftime('%a, %d %b %Y %H:%M:%S GMT', time.gmtime())
    algorithm = 'hmac-sha256'
    headers = f'host: {host}\ndate: {date}\nGET /v2/iat HTTP/1.1'

    signature = hmac.new(
        IFLYTEK_API_SECRET.encode('utf-8'),
        headers.encode('utf-8'),
        digestmod=hashlib.sha256
    ).digest()
    signature = base64.b64encode(signature).decode('utf-8')

    authorization_origin = f'api_key="{IFLYTEK_API_KEY}", algorithm="{algorithm}", headers="host date request-line", signature="{signature}"'
    auth_str = base64.b64encode(authorization_origin.encode('utf-8')).decode('utf-8')

    return f'{url}?authorization={urllib.parse.quote(auth_str)}&date={urllib.parse.quote(date)}&host={urllib.parse.quote(host)}'


def recognize_audio(audio_base64):
    audio_data = base64.b64decode(audio_base64)

    if len(audio_data) > 44 and audio_data[:4] == b'RIFF':
        pcm_data = audio_data[44:]
        print(f"Stripped WAV header, PCM size: {len(pcm_data)}")
    else:
        pcm_data = audio_data
        print(f"No WAV header found, using raw data, size: {len(pcm_data)}")

    frame_size = 1280
    frames = []
    for i in range(0, len(pcm_data), frame_size):
        frames.append(pcm_data[i:i + frame_size])

    print(f"Total frames to send: {len(frames)}")

    result_text = ""
    is_done = False
    error_info = None

    def on_message(ws, message):
        nonlocal result_text, is_done, error_info
        try:
            print(f"Received message: {message[:200]}...")
            response = json.loads(message)
            print(f"Response code: {response.get('code')}")
            
            if response['code'] != 0:
                error_info = f"ASR error: {response['code']} {response.get('message', '')}"
                print(f"ASR error: {error_info}")
                is_done = True
                ws.close()
                return

            if response['data'] and response['data'].get('result'):
                result = response['data']['result']
                if result.get('ws'):
                    for w in result['ws']:
                        if w.get('cw') and len(w['cw']) > 0:
                            result_text += w['cw'][0]['w']
                print(f"Partial result: {result_text}")

            if response['data'] and response['data']['status'] == 2:
                print("ASR completed")
                is_done = True
                ws.close()
        except Exception as e:
            error_info = f"Parse error: {str(e)}"
            print(f"Parse error: {error_info}")
            is_done = True
            ws.close()

    def on_error(ws, error):
        nonlocal is_done, error_info
        error_info = f"WebSocket error: {str(error)}"
        print(f"WebSocket error: {error_info}")
        is_done = True

    def on_close(ws, close_status_code, close_msg):
        nonlocal is_done
        print(f"WebSocket closed, status: {close_status_code}, message: {close_msg}")
        is_done = True

    def on_open(ws):
        print("WebSocket connection opened")
        try:
            for index, frame in enumerate(frames):
                status = 0 if index == 0 else 1
                frame_base64 = base64.b64encode(frame).decode('utf-8')
                payload = {
                    'common': {'app_id': IFLYTEK_APP_ID},
                    'business': {
                        'language': 'zh_cn',
                        'domain': 'iat',
                        'accent': 'mandarin',
                        'vad_eos': 5000
                    },
                    'data': {
                        'status': status,
                        'format': 'audio/L16;rate=16000',
                        'audio': frame_base64,
                        'encoding': 'raw'
                    }
                }
                ws.send(json.dumps(payload))
                
                if index % 50 == 0:
                    print(f"Sent frame {index}/{len(frames)}")

            ws.send(json.dumps({
                'data': {
                    'status': 2,
                    'format': 'audio/L16;rate=16000',
                    'audio': '',
                    'encoding': 'raw'
                }
            }))
            print("Sent final frame (status=2)")
        except Exception as e:
            error_info = f"Send error: {str(e)}"
            print(f"Send error: {error_info}")
            is_done = True
            ws.close()

    auth_url = generate_auth_url()
    print(f"Connecting to: {auth_url[:100]}...")
    
    ws = websocket.WebSocketApp(
        auth_url,
        on_message=on_message,
        on_error=on_error,
        on_close=on_close,
        on_open=on_open
    )

    try:
        ws.run_forever(
            ping_interval=30,
            ping_timeout=10,
            sslopt={"cert_reqs": ssl.CERT_NONE}
        )
    except Exception as e:
        error_info = f"Run forever error: {str(e)}"
        print(f"Run forever error: {error_info}")

    print(f"Final result: '{result_text}'")

    if error_info:
        raise HTTPException(status_code=500, detail=error_info)

    return result_text


@app.post("/asr")
async def speech_recognition(request: ASRRequest):
    if not request.audio or len(request.audio.strip()) == 0:
        raise HTTPException(status_code=400, detail="音频数据不能为空")

    print(f"\n=== ASR request received ===")
    print(f"Audio base64 length: {len(request.audio)}")

    if not IFLYTEK_APP_ID or not IFLYTEK_API_KEY or not IFLYTEK_API_SECRET:
        raise HTTPException(status_code=500, detail="讯飞配置未完成")

    try:
        result = recognize_audio(request.audio)
        print(f"ASR success, result: '{result}'")
        return {"text": result}
    except HTTPException:
        raise
    except Exception as e:
        print(f"ASR exception: {type(e).__name__}: {str(e)}")
        import traceback
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=f"ASR失败: {str(e)}")


@app.get("/")
async def health_check():
    return {"status": "ok", "service": "iflytek-asr"}


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=5002)