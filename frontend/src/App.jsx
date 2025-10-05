import React, { useRef, useState, useEffect, useCallback } from "react";

export default function VideoSubtitle() {
  const videoRef = useRef();
  const [videoFile, setVideoFile] = useState(null);
  const [fileName, setFileName] = useState("");
  const [youtubeLink, setYoutubeLink] = useState("");
  const [downloading, setDownloading] = useState(false);
  const [sessionId, setSessionId] = useState("");
  const [liveSubtitles, setLiveSubtitles] = useState([]);
  const [statusText, setStatusText] = useState("");
  const [eventSource, setEventSource] = useState(null);
  const [processing, setProcessing] = useState(false);
  const [isPlaying, setIsPlaying] = useState(false);
  const [initialBufferReady, setInitialBufferReady] = useState(false);
  const [audioDebug, setAudioDebug] = useState("");

  // Audio management
  const allSubtitlesRef = useRef([]);
  const currentAudioRef = useRef(null);
  const lastPlayedIndexRef = useRef(-1);
  const isSeekingRef = useRef(false);
  const initialBufferCountRef = useRef(0);

  // --- Handle YouTube Download ---
  const handleYoutubeDownload = async () => {
    if (!youtubeLink.trim()) {
      alert("Please enter a YouTube URL");
      return;
    }

    setDownloading(true);
    setStatusText("Downloading from YouTube...");

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

      setStatusText("Video downloaded! Preparing...");

      // Fetch the downloaded video as a File object
      const fileResponse = await fetch(`http://localhost:5000${data.file_url}`);
      const blob = await fileResponse.blob();
      const file = new File([blob], data.title + ".mp4", { type: "video/mp4" });

      setVideoFile(file);
      setFileName(data.title + ".mp4");

      // Clear previous state
      setLiveSubtitles([]);
      setIsPlaying(false);
      setInitialBufferReady(false);
      
      if (currentAudioRef.current) {
        currentAudioRef.current.pause();
        currentAudioRef.current = null;
      }
      allSubtitlesRef.current = [];
      lastPlayedIndexRef.current = -1;
      isSeekingRef.current = false;
      initialBufferCountRef.current = 0;

      setStatusText(`Successfully downloaded: ${data.title}`);
      
      setTimeout(() => {
        setStatusText("");
      }, 4000);
    } catch (err) {
      console.error("YouTube download failed:", err);
      setStatusText("YouTube download failed: " + err.message);
    } finally {
      setDownloading(false);
    }
  };

  const handleFileChange = (e) => {
    const file = e.target.files[0];
    if (!file) return;
    
    setVideoFile(file);
    setFileName(file.name);
    setLiveSubtitles([]);
    setIsPlaying(false);
    setInitialBufferReady(false);
    
    // Clear audio and data
    if (currentAudioRef.current) {
      currentAudioRef.current.pause();
      currentAudioRef.current = null;
    }
    allSubtitlesRef.current = [];
    lastPlayedIndexRef.current = -1;
    isSeekingRef.current = false;
    initialBufferCountRef.current = 0;
  };

  // Play audio for subtitle
  const playAudioForSubtitle = useCallback((subtitle) => {
    if (!subtitle || !subtitle.tts_url) return;
    if (lastPlayedIndexRef.current === subtitle.index) return;

    if (currentAudioRef.current) {
      currentAudioRef.current.pause();
      currentAudioRef.current = null;
    }

    const audioUrl = `http://localhost:5000${subtitle.tts_url}`;
    setAudioDebug(`Playing: ${subtitle.text}`);

    try {
      const audio = new Audio(audioUrl);
      audio.playbackRate = 1.1;
      currentAudioRef.current = audio;
      lastPlayedIndexRef.current = subtitle.index;
      
      audio.addEventListener('ended', () => {
        currentAudioRef.current = null;
        setAudioDebug("Audio finished");
      });
      
      audio.addEventListener('error', (e) => {
        setAudioDebug(`Error: ${audio.error?.message || 'Unknown error'}`);
        currentAudioRef.current = null;
      });
      
      audio.play().catch((error) => {
        setAudioDebug(`Play failed: ${error.message}`);
      });
    } catch (error) {
      setAudioDebug(`Error: ${error.message}`);
    }
  }, []);

  const stopAllAudio = useCallback(() => {
    if (currentAudioRef.current) {
      currentAudioRef.current.pause();
      currentAudioRef.current = null;
    }
    setAudioDebug("Stopped");
  }, []);

  const startProcessing = async () => {
    if (!videoFile) return;

    setProcessing(true);
    setStatusText("Starting processing... Please wait 5-6 seconds for initial buffer");
    const formData = new FormData();
    formData.append("video", videoFile);

    try {
      const resp = await fetch("http://localhost:5000/start_live_processing", {
        method: "POST",
        body: formData
      });
      const data = await resp.json();
      setSessionId(data.session_id);

      if (videoRef.current) {
        videoRef.current.src = `http://localhost:5000${data.video_url}`;
        videoRef.current.muted = true;
        videoRef.current.load();
      }

      setupTTSStream(data.session_id);
    } catch (error) {
      console.error("Error starting processing:", error);
      setStatusText("Error starting processing");
      setProcessing(false);
    }
  };

  const setupTTSStream = (sessionId) => {
    if (eventSource) eventSource.close();
    
    const es = new EventSource(`http://localhost:5000/get_next_tts/${sessionId}`);
    setEventSource(es);

    es.onmessage = async (event) => {
      const data = JSON.parse(event.data);
      
      if (data.complete) {
        setStatusText("Translation complete! Ready to play.");
        es.close();
        setProcessing(false);
        fetchSessionData(sessionId);
        return;
      }

      initialBufferCountRef.current++;
      
      if (initialBufferCountRef.current < 3) {
        setStatusText(`Buffering... ${initialBufferCountRef.current}/3 chunks ready`);
      } else if (initialBufferCountRef.current === 3) {
        setStatusText("Initial buffer ready! Press Play to start.");
        setInitialBufferReady(true);
        
        if (videoRef.current) {
          setTimeout(() => {
            videoRef.current.play().catch(e => console.log("Auto-play prevented:", e));
          }, 500);
        }
      } else {
        setStatusText("Processing translation...");
      }
      
      allSubtitlesRef.current = [...allSubtitlesRef.current, data];
      setLiveSubtitles(prev => [...prev, data]);
    };

    es.onerror = (error) => {
      console.error("EventSource error:", error);
      es.close();
    };
  };

  const fetchSessionData = async (sessionId) => {
    try {
      const response = await fetch(`http://localhost:5000/get_session_data/${sessionId}`);
      const data = await response.json();
      allSubtitlesRef.current = data.subtitles;
    } catch (error) {
      console.error("Error fetching session data:", error);
    }
  };

  const syncWithVideo = useCallback(() => {
    if (!videoRef.current || allSubtitlesRef.current.length === 0) return;
    
    const currentTime = videoRef.current.currentTime;
    const currentSubtitle = allSubtitlesRef.current.find(sub => 
      currentTime >= sub.start && currentTime <= sub.end
    );
    
    const subEl = document.getElementById("subtitle");
    if (subEl) {
      if (currentSubtitle) {
        subEl.innerText = currentSubtitle.text;
        if (isPlaying && !isSeekingRef.current && initialBufferReady) {
          playAudioForSubtitle(currentSubtitle);
        }
      } else {
        subEl.innerText = "";
      }
    }
  }, [isPlaying, initialBufferReady, playAudioForSubtitle]);

  const handleSeeking = useCallback(() => {
    isSeekingRef.current = true;
    stopAllAudio();
    lastPlayedIndexRef.current = -1;
  }, [stopAllAudio]);

  const handleSeeked = useCallback(() => {
    isSeekingRef.current = false;
    lastPlayedIndexRef.current = -1;
  }, []);

  const handleVideoPlay = useCallback(() => {
    setIsPlaying(true);
  }, []);

  const handleVideoPause = useCallback(() => {
    setIsPlaying(false);
    stopAllAudio();
  }, [stopAllAudio]);

  useEffect(() => {
    const videoElement = videoRef.current;
    if (!videoElement) return;

    videoElement.addEventListener('play', handleVideoPlay);
    videoElement.addEventListener('pause', handleVideoPause);
    videoElement.addEventListener('seeking', handleSeeking);
    videoElement.addEventListener('seeked', handleSeeked);

    const syncInterval = setInterval(syncWithVideo, 300);

    return () => {
      videoElement.removeEventListener('play', handleVideoPlay);
      videoElement.removeEventListener('pause', handleVideoPause);
      videoElement.removeEventListener('seeking', handleSeeking);
      videoElement.removeEventListener('seeked', handleSeeked);
      clearInterval(syncInterval);
    };
  }, [handleVideoPlay, handleVideoPause, handleSeeking, handleSeeked, syncWithVideo]);

  const goFullscreen = () => {
    const wrapper = videoRef.current?.parentElement;
    if (wrapper?.requestFullscreen) wrapper.requestFullscreen();
    else if (wrapper?.webkitRequestFullscreen) wrapper.webkitRequestFullscreen();
  };

  const togglePlayPause = () => {
    if (videoRef.current) {
      if (videoRef.current.paused) {
        videoRef.current.play();
      } else {
        videoRef.current.pause();
      }
    }
  };

  useEffect(() => {
    return () => {
      if (eventSource) eventSource.close();
      stopAllAudio();
    };
  }, [eventSource, stopAllAudio]);

  return (
    <div style={{ padding: '20px', maxWidth: '1000px', margin: '0 auto', fontFamily: 'system-ui, -apple-system, sans-serif' }}>
      {/* Header */}
      <div style={{ textAlign: 'center', marginBottom: '30px' }}>
        <h1 style={{ color: '#1a1a1a', marginBottom: '8px', fontSize: '32px' }}>Live Tamil Translation</h1>
        <p style={{ color: '#666', fontSize: '16px' }}>Upload a video or download from YouTube to get live subtitles</p>
      </div>

      {/* YouTube Download Section */}
      <div style={{ 
        marginBottom: '20px', 
        padding: '24px', 
        backgroundColor: '#fff', 
        borderRadius: '12px',
        border: '2px solid #e0e0e0',
        boxShadow: '0 2px 8px rgba(0,0,0,0.05)'
      }}>
        <h3 style={{ marginTop: 0, marginBottom: '16px', color: '#333', fontSize: '18px', fontWeight: '600' }}>
          🎬 Download from YouTube
        </h3>
        <div style={{ display: 'flex', gap: '12px', alignItems: 'stretch' }}>
          <input
            type="text"
            placeholder="Paste YouTube link here (e.g., https://youtube.com/watch?v=...)"
            value={youtubeLink}
            onChange={(e) => setYoutubeLink(e.target.value)}
            disabled={downloading}
            style={{ 
              flex: '1', 
              padding: '12px 16px', 
              borderRadius: '8px',
              border: '2px solid #ddd',
              fontSize: '15px',
              outline: 'none',
              transition: 'border-color 0.2s',
              backgroundColor: downloading ? '#f5f5f5' : 'white'
            }}
            onFocus={(e) => e.target.style.borderColor = '#007bff'}
            onBlur={(e) => e.target.style.borderColor = '#ddd'}
          />
          <button 
            onClick={handleYoutubeDownload} 
            disabled={!youtubeLink.trim() || downloading}
            style={{ 
              padding: '12px 28px', 
              cursor: (!youtubeLink.trim() || downloading) ? 'not-allowed' : 'pointer',
              backgroundColor: downloading ? '#95a5a6' : '#e74c3c',
              color: 'white',
              border: 'none',
              borderRadius: '8px',
              fontSize: '15px',
              fontWeight: '600',
              whiteSpace: 'nowrap',
              transition: 'all 0.2s',
              opacity: (!youtubeLink.trim() || downloading) ? 0.6 : 1
            }}
            onMouseOver={(e) => {
              if (!downloading && youtubeLink.trim()) {
                e.target.style.backgroundColor = '#c0392b';
                e.target.style.transform = 'translateY(-1px)';
              }
            }}
            onMouseOut={(e) => {
              e.target.style.backgroundColor = downloading ? '#95a5a6' : '#e74c3c';
              e.target.style.transform = 'translateY(0)';
            }}
          >
            {downloading ? "⏳ Downloading..." : "📥 Download"}
          </button>
        </div>
      </div>

      {/* Local Upload Section */}
      <div style={{ 
        marginBottom: '20px', 
        padding: '24px', 
        backgroundColor: '#fff', 
        borderRadius: '12px',
        border: '2px solid #e0e0e0',
        boxShadow: '0 2px 8px rgba(0,0,0,0.05)'
      }}>
        <h3 style={{ marginTop: 0, marginBottom: '16px', color: '#333', fontSize: '18px', fontWeight: '600' }}>
          📁 Or Upload Local Video
        </h3>
        <input 
          type="file" 
          accept="video/*" 
          onChange={handleFileChange} 
          disabled={processing}
          style={{ 
            display: 'block',
            width: '100%',
            padding: '12px',
            border: '2px dashed #ddd',
            borderRadius: '8px',
            cursor: 'pointer',
            fontSize: '14px',
            backgroundColor: processing ? '#f5f5f5' : 'white'
          }}
        />
        {fileName && (
          <div style={{ 
            marginTop: '12px', 
            padding: '10px 14px',
            backgroundColor: '#d4edda',
            color: '#155724',
            borderRadius: '6px',
            fontSize: '14px',
            border: '1px solid #c3e6cb'
          }}>
            ✅ Selected: <strong>{fileName}</strong>
          </div>
        )}
      </div>

      {/* Control Buttons */}
      <div style={{ display: 'flex', gap: '12px', flexWrap: 'wrap', marginBottom: '24px' }}>
        <button 
          onClick={startProcessing} 
          disabled={!videoFile || processing}
          style={{ 
            flex: '1',
            minWidth: '180px',
            padding: '14px 24px', 
            cursor: (!videoFile || processing) ? 'not-allowed' : 'pointer',
            backgroundColor: (!videoFile || processing) ? '#95a5a6' : '#27ae60',
            color: 'white',
            border: 'none',
            borderRadius: '8px',
            fontSize: '16px',
            fontWeight: '600',
            transition: 'all 0.2s',
            opacity: (!videoFile || processing) ? 0.6 : 1
          }}
        >
          {processing ? "⏳ Processing..." : "🚀 Start Translation"}
        </button>
        <button 
          onClick={togglePlayPause} 
          disabled={!videoFile || !initialBufferReady}
          style={{ 
            padding: '14px 28px', 
            cursor: (!videoFile || !initialBufferReady) ? 'not-allowed' : 'pointer',
            backgroundColor: '#3498db',
            color: 'white',
            border: 'none',
            borderRadius: '8px',
            fontSize: '16px',
            fontWeight: '600',
            opacity: (!videoFile || !initialBufferReady) ? 0.6 : 1
          }}
        >
          {isPlaying ? "⏸️ Pause" : "▶️ Play"}
        </button>
        <button 
          onClick={goFullscreen} 
          disabled={!videoFile}
          style={{ 
            padding: '14px 28px', 
            cursor: !videoFile ? 'not-allowed' : 'pointer',
            backgroundColor: '#34495e',
            color: 'white',
            border: 'none',
            borderRadius: '8px',
            fontSize: '16px',
            fontWeight: '600',
            opacity: !videoFile ? 0.6 : 1
          }}
        >
          ⛶ Fullscreen
        </button>
      </div>

      {/* Subtitle Display */}
      <div 
        id="subtitle" 
        style={{
          minHeight: '100px',
          padding: '24px',
          backgroundColor: '#000',
          color: '#fff',
          borderRadius: '12px',
          marginBottom: '20px',
          fontSize: '28px',
          textAlign: 'center',
          fontWeight: 'bold',
          lineHeight: '1.5',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          boxShadow: '0 4px 12px rgba(0,0,0,0.3)'
        }}
      >
        {liveSubtitles.length === 0 && "Subtitles will appear here..."}
      </div>

      {/* Video Player */}
      <div style={{ 
        position: 'relative', 
        backgroundColor: '#000', 
        borderRadius: '12px', 
        overflow: 'hidden',
        marginBottom: '20px',
        boxShadow: '0 4px 16px rgba(0,0,0,0.2)'
      }}>
        <video 
          ref={videoRef} 
          controls 
          style={{ width: '100%', display: 'block', maxHeight: '600px' }}
        />
      </div>

      {/* Status */}
      {statusText && (
        <div style={{ 
          marginBottom: '16px', 
          padding: '16px 20px', 
          backgroundColor: statusText.includes('failed') || statusText.includes('Error') ? '#fee' : '#e7f3ff',
          color: statusText.includes('failed') || statusText.includes('Error') ? '#c00' : '#014361',
          borderRadius: '8px', 
          fontSize: '15px',
          border: '1px solid ' + (statusText.includes('failed') || statusText.includes('Error') ? '#fcc' : '#b3d9ff'),
          fontWeight: '500'
        }}>
          {statusText}
        </div>
      )}
      
      {processing && !initialBufferReady && (
        <div style={{ 
          marginBottom: '16px', 
          padding: '16px 20px', 
          backgroundColor: '#fff9e6', 
          color: '#856404',
          borderRadius: '8px', 
          fontSize: '14px',
          border: '1px solid #ffe69c',
          fontWeight: '500'
        }}>
          ⏳ Please wait 5-6 seconds for initial audio processing...
        </div>
      )}
      
      {/* Debug info */}
      <details style={{ marginBottom: '16px' }}>
        <summary style={{ 
          padding: '12px 16px', 
          backgroundColor: '#f8f9fa', 
          borderRadius: '8px',
          cursor: 'pointer',
          fontSize: '14px',
          fontWeight: '600',
          color: '#495057'
        }}>
          🔧 Debug Information
        </summary>
        <div style={{ 
          marginTop: '8px',
          padding: '16px', 
          backgroundColor: '#f8f9fa', 
          borderRadius: '8px', 
          fontSize: '13px', 
          color: '#495057',
          fontFamily: 'monospace',
          lineHeight: '1.8'
        }}>
          <div>📊 Total subtitles: <strong>{allSubtitlesRef.current.length}</strong></div>
          <div>🎬 Buffer ready: <strong>{initialBufferReady ? '✅ Yes' : '⏳ No'}</strong></div>
          <div>▶️ Video playing: <strong>{isPlaying ? '✅ Yes' : '⏸️ No'}</strong></div>
          <div>🎵 Last played index: <strong>{lastPlayedIndexRef.current}</strong></div>
          <div>🔊 Current audio: <strong>{currentAudioRef.current ? '🔊 Playing' : '🔇 None'}</strong></div>
          <div>📝 Audio status: <strong>{audioDebug || 'Idle'}</strong></div>
        </div>
      </details>
    </div>
  );
}