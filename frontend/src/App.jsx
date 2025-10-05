import React, { useRef, useState, useEffect, useCallback } from "react";
import "./App.css";

export default function VideoSubtitle() {
  const videoRef = useRef();
  const [videoFile, setVideoFile] = useState(null);
  const [fileName, setFileName] = useState("");
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

  const handleFileChange = (e) => {
    const file = e.target.files[0];
    setVideoFile(file);
    setFileName(file?.name || "");
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

  // Play audio for subtitle - simplified version
  const playAudioForSubtitle = useCallback((subtitle) => {
    if (!subtitle || !subtitle.tts_url) {
      console.log("No subtitle or TTS URL");
      return;
    }

    // Don't replay the same subtitle
    if (lastPlayedIndexRef.current === subtitle.index) {
      return;
    }

    // Stop current audio if playing
    if (currentAudioRef.current) {
      currentAudioRef.current.pause();
      currentAudioRef.current = null;
    }

    const audioUrl = `http://localhost:5000${subtitle.tts_url}`;
    console.log("Attempting to play audio:", audioUrl, "for text:", subtitle.text);
    setAudioDebug(`Playing: ${subtitle.text}`);

    try {
      const audio = new Audio(audioUrl);
      audio.playbackRate = 1.1;
      
      currentAudioRef.current = audio;
      lastPlayedIndexRef.current = subtitle.index;
      
      audio.addEventListener('loadeddata', () => {
        console.log("Audio loaded successfully");
      });

      audio.addEventListener('canplaythrough', () => {
        console.log("Audio can play through");
      });
      
      audio.addEventListener('ended', () => {
        console.log("Audio ended");
        currentAudioRef.current = null;
        setAudioDebug("Audio finished");
      });
      
      audio.addEventListener('error', (e) => {
        console.error("Audio error:", e, audio.error);
        setAudioDebug(`Error: ${audio.error?.message || 'Unknown error'}`);
        currentAudioRef.current = null;
      });
      
      // Try to play
      const playPromise = audio.play();
      if (playPromise !== undefined) {
        playPromise
          .then(() => {
            console.log("Audio playing successfully");
            setAudioDebug(`Playing: ${subtitle.text}`);
          })
          .catch((error) => {
            console.error("Play failed:", error);
            setAudioDebug(`Play failed: ${error.message}`);
          });
      }
    } catch (error) {
      console.error("Error creating audio:", error);
      setAudioDebug(`Error: ${error.message}`);
    }
  }, []);

  // Stop all audio
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
      console.log("Session started:", data.session_id);

      // Set up video with muted original audio
      if (videoRef.current) {
        videoRef.current.src = `http://localhost:5000${data.video_url}`;
        videoRef.current.muted = true;
        videoRef.current.load();
      }

      // Start TTS streaming
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
        
        // Fetch all session data for complete timeline
        fetchSessionData(sessionId);
        return;
      }

      console.log("Received TTS chunk:", data);
      
      // Count initial buffer chunks
      initialBufferCountRef.current++;
      
      // Update status based on buffer progress
      if (initialBufferCountRef.current < 3) {
        setStatusText(`Buffering... ${initialBufferCountRef.current}/3 chunks ready`);
      } else if (initialBufferCountRef.current === 3) {
        setStatusText("Initial buffer ready! Press Play to start.");
        setInitialBufferReady(true);
        
        // Auto-play video after buffer is ready
        if (videoRef.current) {
          setTimeout(() => {
            videoRef.current.play().catch(e => console.log("Auto-play prevented:", e));
          }, 500);
        }
      } else {
        setStatusText("Processing translation...");
      }
      
      // Add to all subtitles reference
      allSubtitlesRef.current = [...allSubtitlesRef.current, data];
      
      // Add to display subtitles
      setLiveSubtitles(prev => [...prev, data]);
    };

    es.onerror = (error) => {
      console.error("EventSource error:", error);
      es.close();
    };
  };

  // Fetch all session data for complete timeline
  const fetchSessionData = async (sessionId) => {
    try {
      const response = await fetch(`http://localhost:5000/get_session_data/${sessionId}`);
      const data = await response.json();
      allSubtitlesRef.current = data.subtitles;
      console.log("Loaded all subtitles:", allSubtitlesRef.current.length);
    } catch (error) {
      console.error("Error fetching session data:", error);
    }
  };

  // Main sync function - handles both subtitle display and audio
  const syncWithVideo = useCallback(() => {
    if (!videoRef.current || allSubtitlesRef.current.length === 0) return;
    
    const currentTime = videoRef.current.currentTime;
    
    // Find current subtitle based on timeline
    const currentSubtitle = allSubtitlesRef.current.find(sub => 
      currentTime >= sub.start && currentTime <= sub.end
    );
    
    // Update displayed subtitle
    const subEl = document.getElementById("subtitle");
    if (subEl) {
      if (currentSubtitle) {
        subEl.innerText = currentSubtitle.text;
        
        // Play audio if video is playing and not seeking
        if (isPlaying && !isSeekingRef.current && initialBufferReady) {
          playAudioForSubtitle(currentSubtitle);
        }
      } else {
        // Find the nearest subtitle
        const nearestSubtitle = allSubtitlesRef.current
          .sort((a, b) => Math.abs(a.start - currentTime) - Math.abs(b.start - currentTime))[0];
        
        if (nearestSubtitle && Math.abs(nearestSubtitle.start - currentTime) < 2) {
          subEl.innerText = nearestSubtitle.text;
        } else {
          subEl.innerText = "";
        }
      }
    }
  }, [isPlaying, initialBufferReady, playAudioForSubtitle]);

  // Handle video seeking
  const handleSeeking = useCallback(() => {
    console.log("Seeking - stopping audio");
    isSeekingRef.current = true;
    stopAllAudio();
    lastPlayedIndexRef.current = -1;
  }, [stopAllAudio]);

  const handleSeeked = useCallback(() => {
    console.log("Seeked - ready to play");
    isSeekingRef.current = false;
    lastPlayedIndexRef.current = -1;
  }, []);

  // Handle play event
  const handleVideoPlay = useCallback(() => {
    console.log("Video play event - starting audio sync");
    setIsPlaying(true);
  }, []);

  const handleVideoPause = useCallback(() => {
    console.log("Video pause event - stopping audio");
    setIsPlaying(false);
    stopAllAudio();
  }, [stopAllAudio]);

  // Set up video event listeners and sync interval
  useEffect(() => {
    const videoElement = videoRef.current;
    if (!videoElement) return;

    videoElement.addEventListener('play', handleVideoPlay);
    videoElement.addEventListener('pause', handleVideoPause);
    videoElement.addEventListener('seeking', handleSeeking);
    videoElement.addEventListener('seeked', handleSeeked);

    // Sync both subtitle and audio with video timeline every 300ms
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
    const wrapper = videoRef.current.parentElement;
    if (wrapper.requestFullscreen) wrapper.requestFullscreen();
    else if (wrapper.webkitRequestFullscreen) wrapper.webkitRequestFullscreen();
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

  // Test audio function
  const testAudio = () => {
    if (allSubtitlesRef.current.length > 0) {
      const firstSub = allSubtitlesRef.current[0];
      console.log("Testing first audio:", firstSub);
      playAudioForSubtitle(firstSub);
    } else {
      alert("No subtitles available yet");
    }
  };

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (eventSource) eventSource.close();
      stopAllAudio();
    };
  }, [eventSource, stopAllAudio]);

  return (
    <div className="video-subtitle-container">
      <h1>Live Tamil Translation</h1>
      
      <div className="controls">
        <input 
          type="file" 
          accept="video/*" 
          onChange={handleFileChange} 
          disabled={processing}
        />
        <button 
          onClick={startProcessing} 
          disabled={!videoFile || processing}
        >
          {processing ? "Processing..." : "Start Live Translation"}
        </button>
        <button 
          onClick={togglePlayPause} 
          disabled={!videoFile || !initialBufferReady}
        >
          {isPlaying ? "Pause" : "Play"}
        </button>
        <button 
          onClick={testAudio} 
          disabled={allSubtitlesRef.current.length === 0}
        >
          Test Audio
        </button>
        <button onClick={goFullscreen} disabled={!videoFile}>
          Fullscreen
        </button>
      </div>

      <div id="subtitle" className="subtitle-display">
        {liveSubtitles.length === 0 && "Subtitles will appear here after initial processing..."}
      </div>

      <div className="video-wrapper">
        <video 
          ref={videoRef} 
          controls 
          className="video-player"
        />
      </div>

      <div className="status">{statusText}</div>
      {processing && !initialBufferReady && (
        <div className="info">
          <small>Please wait 5-6 seconds for initial audio processing...</small>
        </div>
      )}
      
      {/* Debug info */}
      <div className="debug-info">
        <small>Total subtitles: {allSubtitlesRef.current.length} | </small>
        <small>Buffer ready: {initialBufferReady ? 'Yes' : 'No'} | </small>
        <small>Video playing: {isPlaying ? 'Yes' : 'No'} | </small>
        <small>Last played: {lastPlayedIndexRef.current} | </small>
        <small>Current audio: {currentAudioRef.current ? 'Playing' : 'None'} | </small>
        <small>Audio debug: {audioDebug}</small>
      </div>
      
      {/* Show first few subtitle URLs for debugging */}
      {allSubtitlesRef.current.length > 0 && (
        <div className="debug-info" style={{marginTop: '10px', fontSize: '10px'}}>
          <div>First subtitle URL: {allSubtitlesRef.current[0]?.tts_url}</div>
          <div>Full URL: http://localhost:5000{allSubtitlesRef.current[0]?.tts_url}</div>
        </div>
      )}
    </div>
  );
}