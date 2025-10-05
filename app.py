from flask import Flask, request, Response, jsonify, send_from_directory
from flask_cors import CORS
from vosk import Model, KaldiRecognizer
import wave, os, json, uuid, subprocess, requests
import azure.cognitiveservices.speech as speechsdk
import threading
import time
import queue
import yt_dlp

import env  # contains your AZURE keys

app = Flask(__name__)
CORS(app)

# --- Directories ---
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
UPLOAD_FOLDER = os.path.join(BASE_DIR, "uploads")
os.makedirs(UPLOAD_FOLDER, exist_ok=True)

# --- ASR Model ---
asr_model_path = "/home/saliniyan/Documents/git_project/python/vosk-model-small-en-us-0.15"
asr_model = Model(asr_model_path)

# --- Azure Config ---
AZURE_TRANSLATOR_KEY = env.AZURE_TRANSLATOR_KEY
AZURE_TRANSLATOR_REGION = env.AZURE_TRANSLATOR_REGION
AZURE_TRANSLATOR_ENDPOINT = "https://api.cognitive.microsofttranslator.com"
AZURE_SPEECH_KEY = env.AZURE_SPEECH_KEY
AZURE_SPEECH_REGION = env.AZURE_SPEECH_REGION

# --- Active sessions ---
active_sessions = {}

# -------------------- Utils --------------------

def azure_translate(text, to_lang="ta", from_lang="en"):
    if not text.strip(): return ""
    url = f"{AZURE_TRANSLATOR_ENDPOINT}/translate"
    headers = {
        "Ocp-Apim-Subscription-Key": AZURE_TRANSLATOR_KEY,
        "Ocp-Apim-Subscription-Region": AZURE_TRANSLATOR_REGION,
        "Content-Type": "application/json",
    }
    body = [{"Text": text}]
    try:
        r = requests.post(url, params={"api-version":"3.0","to":to_lang,"from":from_lang}, headers=headers, json=body)
        r.raise_for_status()
        return r.json()[0]["translations"][0]["text"]
    except Exception as e:
        print("Azure Translation Error:", e)
        return "[Translation failed]"

def synthesize_speech(text, out_path, voice="ta-IN-PallaviNeural"):
    try:
        speech_config = speechsdk.SpeechConfig(subscription=AZURE_SPEECH_KEY, region=AZURE_SPEECH_REGION)
        speech_config.speech_synthesis_voice_name = voice
        # Moderate speaking rate for clear but faster audio (1.15x speed)
        speech_config.set_speech_synthesis_output_format(speechsdk.SpeechSynthesisOutputFormat.Riff24Khz16BitMonoPcm)
        audio_config = speechsdk.audio.AudioOutputConfig(filename=out_path)
        synthesizer = speechsdk.SpeechSynthesizer(speech_config=speech_config, audio_config=audio_config)
        
        # Use SSML to control speech rate - moderate speed increase
        ssml = f"""
        <speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='ta-IN'>
            <voice name='{voice}'>
                <prosody rate='+15%'>{text}</prosody>
            </voice>
        </speak>
        """
        synthesizer.speak_ssml_async(ssml).get()
        return True
    except Exception as e:
        print("TTS error:", e)
        return False

def extract_audio(video_path, audio_path):
    subprocess.run([
        "ffmpeg","-y","-i",video_path,"-vn",
        "-acodec","pcm_s16le","-ar","16000","-ac","1",audio_path
    ], stdout=subprocess.PIPE, stderr=subprocess.PIPE)

# -------------------- Audio Processing --------------------

def process_audio_stream(session_id):
    session = active_sessions[session_id]
    audio_path = session["audio_path"]
    wf = wave.open(audio_path, "rb")
    rec = KaldiRecognizer(asr_model, wf.getframerate())
    rec.SetWords(True)

    buffer_chunk = ""
    chunk_start, chunk_end = None, None
    subtitle_index = 0

    chunk_size = 2000
    while session["active"]:
        data = wf.readframes(chunk_size)
        if len(data) == 0: break

        if rec.AcceptWaveform(data):
            res = json.loads(rec.Result())
            for word in res.get("result", []):
                if chunk_start is None: chunk_start = word["start"]
                chunk_end = word["end"]
                buffer_chunk += word["word"] + " "

                # Larger chunks to reduce frequent subtitle changes
                if len(buffer_chunk.split()) >= 5 or (chunk_end - chunk_start) >= 3.0:
                    translated = azure_translate(buffer_chunk.strip())
                    subtitle_index += 1

                    tts_path = os.path.join(UPLOAD_FOLDER,f"{session_id}_tts_{subtitle_index}.wav")
                    if synthesize_speech(translated, tts_path):
                        subtitle_data = {
                            "index": subtitle_index,
                            "start": chunk_start,
                            "end": chunk_end,
                            "text": translated,
                            "tts_url": f"/uploads/{os.path.basename(tts_path)}"
                        }
                        session["subtitles"].append(subtitle_data)
                        
                        # Add to real-time queue for immediate playback
                        session["tts_queue"].put(subtitle_data)

                    buffer_chunk = ""
                    chunk_start = chunk_end = None

    # Final chunk
    final_res = json.loads(rec.FinalResult())
    for word in final_res.get("result", []):
        if chunk_start is None: chunk_start = word["start"]
        chunk_end = word["end"]
        buffer_chunk += word["word"] + " "

    if buffer_chunk.strip():
        translated = azure_translate(buffer_chunk.strip())
        subtitle_index += 1
        tts_path = os.path.join(UPLOAD_FOLDER,f"{session_id}_tts_{subtitle_index}.wav")
        if synthesize_speech(translated, tts_path):
            subtitle_data = {
                "index": subtitle_index, 
                "start": chunk_start, 
                "end": chunk_end, 
                "text": translated,
                "tts_url": f"/uploads/{os.path.basename(tts_path)}"
            }
            session["subtitles"].append(subtitle_data)
            session["tts_queue"].put(subtitle_data)

    wf.close()
    session["processing_complete"] = True
    session["tts_queue"].put({"complete": True})

# -------------------- Flask Routes --------------------

@app.route("/uploads/<path:filename>")
def serve_file(filename):
    return send_from_directory(UPLOAD_FOLDER, filename)

@app.route("/download_youtube", methods=["POST"])
def download_youtube():
    """Download video from YouTube URL"""
    data = request.get_json()
    url = data.get("url")
    if not url:
        return jsonify({"error": "No URL provided"}), 400

    try:
        video_id = str(uuid.uuid4())
        file_template = os.path.join(UPLOAD_FOLDER, f"{video_id}.mp4")

        ydl_opts = {
            'format': 'best[ext=mp4]',
            'outtmpl': file_template,
            'noplaylist': True,
            'quiet': True,
            'merge_output_format': 'mp4',
        }

        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            info = ydl.extract_info(url, download=True)

        if not os.path.exists(file_template):
            return jsonify({"error": "File not found after download"}), 500

        filename = os.path.basename(file_template)
        return jsonify({
            "message": "Download completed",
            "title": info.get('title', 'video'),
            "file_url": f"/uploads/{filename}"
        })

    except Exception as e:
        print("YouTube download error:", e)
        return jsonify({"error": str(e)}), 500

@app.route("/start_live_processing", methods=["POST"])
def start_live_processing():
    if "video" not in request.files:
        return jsonify({"error":"No video uploaded"}),400

    video_file = request.files["video"]
    session_id = str(uuid.uuid4())
    video_path = os.path.join(UPLOAD_FOLDER,f"{session_id}.mp4")
    video_file.save(video_path)

    audio_path = os.path.join(UPLOAD_FOLDER,f"{session_id}.wav")
    extract_audio(video_path, audio_path)

    active_sessions[session_id] = {
        "active": True,
        "video_path": video_path,
        "audio_path": audio_path,
        "subtitles": [],
        "tts_queue": queue.Queue(),
        "processing_complete": False
    }

    threading.Thread(target=process_audio_stream, args=(session_id,)).start()

    return jsonify({
        "session_id": session_id,
        "video_url": f"/uploads/{os.path.basename(video_path)}"
    })

@app.route("/get_next_tts/<session_id>")
def get_next_tts(session_id):
    """Stream TTS chunks as they become available"""
    session = active_sessions.get(session_id)
    if not session:
        return jsonify({"error": "Session not found"}), 404
    
    def generate():
        # Wait for initial buffer (3-4 chunks for better audio quality)
        initial_chunks = []
        timeout_count = 0
        while len(initial_chunks) < 3 and timeout_count < 100:  # Max 10 second wait
            try:
                chunk = session["tts_queue"].get(timeout=0.1)
                if chunk.get("complete"):
                    break
                initial_chunks.append(chunk)
                yield f"data: {json.dumps(chunk)}\n\n"
            except queue.Empty:
                timeout_count += 1
                continue
        
        # Now stream remaining chunks in real-time
        while session["active"] or not session["tts_queue"].empty():
            try:
                chunk = session["tts_queue"].get(timeout=1.0)
                if chunk.get("complete"):
                    yield "data: {\"complete\":true}\n\n"
                    break
                yield f"data: {json.dumps(chunk)}\n\n"
            except queue.Empty:
                if session["processing_complete"]:
                    yield "data: {\"complete\":true}\n\n"
                    break
                continue
    
    return Response(generate(), mimetype="text/event-stream")

@app.route("/get_session_data/<session_id>")
def get_session_data(session_id):
    """Get all subtitles and TTS data for the session"""
    session = active_sessions.get(session_id)
    if not session:
        return jsonify({"error": "Session not found"}), 404
    
    return jsonify({
        "subtitles": session["subtitles"],
        "processing_complete": session.get("processing_complete", False)
    })

if __name__ == "__main__":
    app.run(debug=True, threaded=True)