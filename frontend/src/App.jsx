import React, { useRef, useState, useEffect } from "react";
import "./App.css";

export default function VideoSubtitle() {
  const videoRef = useRef();
  const [activeSubtitles, setActiveSubtitles] = useState([]);
  const [videoFile, setVideoFile] = useState(null);
  const [fileName, setFileName] = useState("");
  const abortControllerRef = useRef(null);

  const handleFileChange = (e) => {
    const file = e.target.files[0];
    setVideoFile(file);
    setFileName(file ? file.name : "");
  };

  const uploadVideo = async () => {
    if (!videoFile) {
      alert("Select a video");
      return;
    }

    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
    }

    setActiveSubtitles([]);

    if (videoRef.current) {
      videoRef.current.pause();
      videoRef.current.currentTime = 0;
    }

    const formData = new FormData();
    formData.append("video", videoFile);

    const videoURL = URL.createObjectURL(videoFile);
    videoRef.current.src = videoURL;
    
    let videoStarted = false;
    abortControllerRef.current = new AbortController();

    try {
      const response = await fetch("http://localhost:5000/stream_video", {
        method: "POST",
        body: formData,
        signal: abortControllerRef.current.signal
      });

      const reader = response.body.getReader();
      const decoder = new TextDecoder("utf-8");
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const events = buffer.split("\n\n");

        for (let i = 0; i < events.length - 1; i++) {
          if (events[i].startsWith("data: ")) {
            const jsonData = JSON.parse(events[i].substring(6));
            
            setActiveSubtitles((prev) => [
              ...prev,
              {
                text: jsonData.tamil_text,
                start: jsonData.start,
                end: jsonData.end,
              }
            ]);

            if (!videoStarted) {
              videoStarted = true;
              setTimeout(() => {
                if (videoRef.current && !videoRef.current.paused) return;
                videoRef.current.play().catch(err => console.log("Play failed:", err));
              }, 2000);
            }
          }
        }

        buffer = events[events.length - 1];
      }
    } catch (err) {
      if (err.name === 'AbortError') {
        console.log("Previous upload aborted");
      } else {
        console.error("Error streaming subtitles:", err);
      }
    }
  };

  useEffect(() => {
    const interval = setInterval(() => {
      if (!videoRef.current) return;
      const currentTime = videoRef.current.currentTime;

      const visible = activeSubtitles
        .filter((s) => currentTime >= s.start && currentTime <= s.end)
        .map((s) => s.text)
        .join("\n");

      const subtitleEl = document.getElementById("subtitle");
      if (subtitleEl) subtitleEl.innerText = visible;
    }, 100);

    return () => clearInterval(interval);
  }, [activeSubtitles]);

  return (
    <div className="video-subtitle-container">
      <div className="header">
        <h1>Real-Time Tamil Subtitles</h1>
        <p>Upload your video and get live subtitles instantly</p>
      </div>

      <div className="upload-section">
        <div className="file-input-wrapper">
          <input 
            type="file" 
            accept="video/*" 
            onChange={handleFileChange}
            id="video-upload"
          />
          <label htmlFor="video-upload" className="file-input-label">
            {fileName || "Choose Video"}
          </label>
        </div>
        <button 
          className="upload-button" 
          onClick={uploadVideo}
          disabled={!videoFile}
        >
          Upload & Play
        </button>
      </div>

      <div className="video-wrapper">
        <video
          ref={videoRef}
          controls
          className="video-player"
        />
        <div id="subtitle" className="subtitle-display"></div>
      </div>
    </div>
  );
}