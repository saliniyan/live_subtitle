import React, { useRef, useState, useEffect } from "react";
import "./App.css";

export default function VideoSubtitle() {
  const videoRef = useRef();
  const [activeSubtitles, setActiveSubtitles] = useState([]);
  const [videoFile, setVideoFile] = useState(null);
  const [fileName, setFileName] = useState("");
  const [youtubeLink, setYoutubeLink] = useState("");
  const [downloading, setDownloading] = useState(false);
  const [statusText, setStatusText] = useState(""); // Temporary message
  const abortControllerRef = useRef(null);

  // --- Handle YouTube Download ---
  const handleYoutubeDownload = async () => {
    if (!youtubeLink) return;

    setDownloading(true);
    setStatusText("Estimating download...");

    try {
      const response = await fetch("http://localhost:5000/download_youtube", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: youtubeLink }),
      });

      const data = await response.json();
      if (data.error) {
        setStatusText("Download failed: " + data.error);
        setDownloading(false);
        return;
      }

      setStatusText("Downloading video...");

      // Fetch the downloaded video as a File object
      const fileResponse = await fetch(`http://localhost:5000${data.file_url}`);
      const blob = await fileResponse.blob();
      const file = new File([blob], data.title + ".mp4", { type: "video/mp4" });

      setVideoFile(file);
      setFileName(file.name);

      if (videoRef.current) {
        videoRef.current.src = URL.createObjectURL(file);
      }

      // Show a temporary message
      setStatusText(`Downloaded "${data.title}"`);
      setTimeout(() => setStatusText(""), 4000); // Clear after 4 seconds
    } catch (err) {
      console.error("YouTube download failed:", err);
      setStatusText("YouTube download failed");
    } finally {
      setDownloading(false);
    }
  };

  // --- Handle Local File Upload ---
  const handleFileChange = (e) => {
    const file = e.target.files[0];
    setVideoFile(file);
    setFileName(file ? file.name : "");
  };

  // --- Fullscreen ---
  const goFullscreen = () => {
    const wrapper = videoRef.current.parentElement;
    if (wrapper.requestFullscreen) wrapper.requestFullscreen();
    else if (wrapper.webkitRequestFullscreen) wrapper.webkitRequestFullscreen();
    else if (wrapper.msRequestFullscreen) wrapper.msRequestFullscreen();
  };

  // --- Upload + Stream Subtitles ---
  const uploadVideo = async () => {
    if (!videoFile) return;

    if (abortControllerRef.current) abortControllerRef.current.abort();
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
        signal: abortControllerRef.current.signal,
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
                azureText: jsonData.azure_text,
                localText: jsonData.local_text,
                start: jsonData.start,
                end: jsonData.end,
              },
            ]);

            if (!videoStarted) {
              videoStarted = true;
              setTimeout(() => {
                if (videoRef.current && !videoRef.current.paused) return;
                videoRef.current.play().catch((err) => console.log("Play failed:", err));
              }, 2000);
            }
          }
        }

        buffer = events[events.length - 1];
      }
    } catch (err) {
      if (err.name !== "AbortError") console.error("Error streaming subtitles:", err);
    }
  };

 useEffect(() => {
  const interval = setInterval(() => {
    if (!videoRef.current) return;
    const currentTime = videoRef.current.currentTime;

    const visible = activeSubtitles
      .filter((s) => currentTime >= s.start && currentTime <= s.end)
      .map((s) => s.azureText || s.localText) // Show only the best
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
        <p>Upload a video or download from YouTube to get live subtitles</p>
      </div>

      {/* YouTube Section */}
      <div className="youtube-section">
        <input
          type="text"
          placeholder="Paste YouTube link here"
          value={youtubeLink}
          onChange={(e) => setYoutubeLink(e.target.value)}
          disabled={downloading}
        />
        <button onClick={handleYoutubeDownload} disabled={!youtubeLink || downloading}>
          {downloading ? "Downloading..." : "Download from YouTube"}
        </button>
        {statusText && <div className="download-info">{statusText}</div>}
      </div>

      {/* Local Upload Section */}
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
        <button className="upload-button" onClick={uploadVideo} disabled={!videoFile}>
          Upload & Play
        </button>
        <button className="upload-button" onClick={goFullscreen} disabled={!videoFile}>
          Fullscreen
        </button>
      </div>

      <div className="video-wrapper">
        <video ref={videoRef} controls controlsList="nofullscreen" className="video-player" />
        <div id="subtitle" className="subtitle-display"></div>
      </div>
    </div>
  );
}
