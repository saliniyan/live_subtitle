from flask import Flask, request, Response
from flask_cors import CORS
from vosk import Model, KaldiRecognizer
import wave, os, json, uuid, subprocess
import requests
import env

app = Flask(__name__)
CORS(app)
UPLOAD_FOLDER = "uploads"
os.makedirs(UPLOAD_FOLDER, exist_ok=True)

# Vosk ASR model
asr_model_path = "/home/saliniyan/Documents/git_project/python/vosk-model-small-en-us-0.15"
asr_model = Model(asr_model_path)

# Azure Translator
AZURE_TRANSLATOR_KEY = env.AZURE_TRANSLATOR_KEY
AZURE_TRANSLATOR_REGION = env.AZURE_TRANSLATOR_REGION
AZURE_TRANSLATOR_ENDPOINT = "https://api.cognitive.microsofttranslator.com"

# Colab-hosted local model API
LOCAL_MODEL_API = "https://new-ape-6.loca.lt/translate"  # replace with actual ngrok URL


def azure_translate(text, to_lang="ta", from_lang="en"):
    if not text.strip():
        return ""
    url = f"{AZURE_TRANSLATOR_ENDPOINT}/translate"
    params = {"api-version": "3.0", "to": to_lang, "from": from_lang}
    headers = {
        "Ocp-Apim-Subscription-Key": AZURE_TRANSLATOR_KEY,
        "Ocp-Apim-Subscription-Region": AZURE_TRANSLATOR_REGION,
        "Content-Type": "application/json"
    }
    body = [{"Text": text}]
    try:
        response = requests.post(url, params=params, headers=headers, json=body)
        response.raise_for_status()
        return response.json()[0]["translations"][0]["text"]
    except:
        return "[Azure Translation failed]"


def local_translate_api(text: str) -> str:
    """Call Colab-hosted local model API."""
    try:
        response = requests.post(LOCAL_MODEL_API, json={"text": text})
        response.raise_for_status()
        return response.json().get("predicted", "[Local model failed]")
    except Exception as e:
        print("Error calling local model API:", e)
        return "[Local model failed]"


def extract_audio(video_path, audio_path):
    cmd = ["ffmpeg", "-y", "-i", video_path, "-vn", "-acodec", "pcm_s16le", "-ar", "16000", "-ac", "1", audio_path]
    subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE)


@app.route("/stream_video", methods=["POST"])
def stream_video():
    if "video" not in request.files:
        return "No video uploaded", 400

    video_file = request.files["video"]
    video_id = str(uuid.uuid4())
    video_path = os.path.join(UPLOAD_FOLDER, f"{video_id}.mp4")
    video_file.save(video_path)

    # Extract audio
    audio_path = os.path.join(UPLOAD_FOLDER, f"{video_id}.wav")
    extract_audio(video_path, audio_path)

    def generate():
        wf = wave.open(audio_path, "rb")
        rec = KaldiRecognizer(asr_model, wf.getframerate())
        rec.SetWords(True)

        buffer_chunk = ""
        chunk_start = None
        chunk_end = None

        while True:
            data = wf.readframes(4000)
            if len(data) == 0:
                break
            if rec.AcceptWaveform(data):
                res = json.loads(rec.Result())
                for word in res.get("result", []):
                    if chunk_start is None:
                        chunk_start = word["start"]
                    chunk_end = word["end"]
                    buffer_chunk += word["word"] + " "

                    if len(buffer_chunk.split()) >= 5:  # Flush every 5 words
                        azure_text = azure_translate(buffer_chunk.strip())
                        local_text = local_translate_api(buffer_chunk.strip())
                        yield f"data: {json.dumps({'azure_text': azure_text, 'local_text': local_text, 'start': chunk_start, 'end': chunk_end})}\n\n"
                        buffer_chunk = ""
                        chunk_start = None
                        chunk_end = None

        # Final chunk
        final_res = json.loads(rec.FinalResult())
        for word in final_res.get("result", []):
            if chunk_start is None:
                chunk_start = word["start"]
            chunk_end = word["end"]
            buffer_chunk += word["word"] + " "
        if buffer_chunk.strip():
            azure_text = azure_translate(buffer_chunk.strip())
            local_text = local_translate_api(buffer_chunk.strip())
            yield f"data: {json.dumps({'azure_text': azure_text, 'local_text': local_text, 'start': chunk_start, 'end': chunk_end})}\n\n"

    return Response(generate(), mimetype="text/event-stream")


if __name__ == "__main__":
    app.run(debug=True, threaded=True)
