from fastapi import FastAPI, HTTPException
from pydantic import BaseModel
import edge_tts
import asyncio
import re

app = FastAPI(title="Edge-TTS Service")

class TTSRequest(BaseModel):
    text: str
    voice: str = "zh-CN-XiaoyiNeural"
    rate: str = "+0%"
    volume: str = "+0%"

def split_text(text):
    sentences = re.split(r'([。！？；.!?;\n])', text)
    result = []
    for i in range(0, len(sentences), 2):
        sentence = sentences[i]
        if i + 1 < len(sentences):
            sentence += sentences[i + 1]
        sentence = sentence.strip()
        if sentence:
            result.append(sentence)
    return result

async def generate_audio(text, voice, rate, volume):
    communicate = edge_tts.Communicate(text=text, voice=voice, rate=rate, volume=volume)
    chunks = []
    async for chunk in communicate.stream():
        if chunk["type"] == "audio":
            chunks.append(chunk["data"])
    if not chunks:
        raise Exception("No audio received")
    return b''.join(chunks)

@app.post("/tts")
async def text_to_speech(request: TTSRequest):
    try:
        if not request.text or len(request.text.strip()) == 0:
            raise HTTPException(status_code=400, detail="文本不能为空")
        
        text = request.text.strip()
        print(f"TTS request, text length: {len(text)}, voice: {request.voice}, rate: {request.rate}")
        print(f"Text: {text}")
        
        if len(text) <= 50:
            print("Short text, generating directly")
            audio_data = await generate_audio(text, request.voice, request.rate, request.volume)
            return {"audio": audio_data.hex()}
        
        sentences = split_text(text)
        print(f"Long text, split into {len(sentences)} sentences")
        
        all_audio = []
        for i, sentence in enumerate(sentences):
            print(f"Processing sentence {i+1}/{len(sentences)}, length: {len(sentence)}")
            try:
                audio_data = await generate_audio(sentence, request.voice, request.rate, request.volume)
                all_audio.append(audio_data)
            except Exception as e:
                print(f"Error processing sentence {i+1}: {str(e)}")
        
        combined_audio = b''.join(all_audio)
        print(f"All sentences completed, total audio size: {len(combined_audio)} bytes")
        return {"audio": combined_audio.hex()}
    
    except Exception as e:
        print(f"TTS error: {str(e)}")
        import traceback
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=str(e))

@app.get("/voices")
async def list_voices():
    try:
        voices = await edge_tts.list_voices()
        chinese_voices = [
            {
                "name": v["ShortName"],
                "language": v["Locale"],
                "gender": v["Gender"],
                "friendly_name": v["FriendlyName"]
            }
            for v in voices
            if v["Locale"].startswith("zh")
        ]
        return {"voices": chinese_voices}
    except Exception as e:
        print(f"List voices error: {str(e)}")
        return {"voices": []}

@app.get("/")
async def health_check():
    return {"status": "ok", "service": "edge-tts"}

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=5001)
