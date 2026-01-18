import React, { useState, useRef, useEffect, useCallback } from 'react';
import { GoogleGenAI, LiveServerMessage, Modality } from '@google/genai';
import { Mic, MicOff, Camera, Video, StopCircle, Zap, Loader2 } from 'lucide-react';
import { createAudioBlob, decodeAudioData, blobToBase64 } from './utils/audioUtils';
import Visualizer from './components/Visualizer';
import { ConnectionState } from './types';
import { MODEL_NAME, SYSTEM_INSTRUCTION } from './constants';

// --- CONFIGURATION ---
// Replace this string with your actual API key if you want to hardcode it for deployment.
// Otherwise, it will try to read from environment variables.
const HARDCODED_API_KEY = "AIzaSyDCyfp1NKy2GEllfB8Sg5ofmWK9wrmzNEM"; 

const App: React.FC = () => {
  // State
  const [connectionState, setConnectionState] = useState<ConnectionState>(ConnectionState.DISCONNECTED);
  const [isCameraActive, setIsCameraActive] = useState(false);
  const [isMicActive, setIsMicActive] = useState(true); // Mic acts as mute toggle during session
  const [transcript, setTranscript] = useState<string>("");
  const [modelSpeaking, setModelSpeaking] = useState(false);
  const [userSpeaking, setUserSpeaking] = useState(false);
  
  // Refs for Audio/Video Contexts and Session
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const inputContextRef = useRef<AudioContext | null>(null);
  const nextStartTimeRef = useRef<number>(0);
  const sessionPromiseRef = useRef<Promise<any> | null>(null);
  const frameIntervalRef = useRef<number | null>(null);
  const transcriptionTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  // Initialize AI Client with robust fallback
  const getAIClient = () => {
    let key = HARDCODED_API_KEY;
    
    // Check if process.env exists (Build step environment)
    try {
        if (process.env.API_KEY && process.env.API_KEY.startsWith("AIza")) {
            key = process.env.API_KEY;
        }
    } catch(e) {
        // process is not defined in raw browser env
    }

    if (key === "YOUR_API_KEY_HERE") {
        console.warn("⚠️ API Key is missing. Please replace 'YOUR_API_KEY_HERE' in App.tsx or set process.env.API_KEY");
    }

    return new GoogleGenAI({ apiKey: key });
  };

  // --- Audio Output Handling ---
  const playAudioChunk = async (base64Audio: string) => {
    if (!audioContextRef.current) return;
    const ctx = audioContextRef.current;

    // Decode
    const binaryString = atob(base64Audio);
    const len = binaryString.length;
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) {
        bytes[i] = binaryString.charCodeAt(i);
    }
    
    const audioBuffer = await decodeAudioData(bytes, ctx);

    // Schedule
    const now = ctx.currentTime;
    // Ensure we don't schedule in the past
    const startTime = Math.max(nextStartTimeRef.current, now);
    
    const source = ctx.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(ctx.destination);
    source.start(startTime);

    nextStartTimeRef.current = startTime + audioBuffer.duration;

    // Visualizer State
    setModelSpeaking(true);
    source.onended = () => {
        // Simple check: if current time > known end time, we stopped speaking
        if (ctx.currentTime >= nextStartTimeRef.current - 0.1) {
            setModelSpeaking(false);
        }
    };
  };

  // --- Main Connection Logic ---
  const connectToGemini = async () => {
    setConnectionState(ConnectionState.CONNECTING);
    setTranscript("Connecting to MARK...");

    try {
      // 1. Initialize Audio Contexts immediately to capture User Gesture
      if (!audioContextRef.current) {
        audioContextRef.current = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 24000 });
      }
      if (audioContextRef.current.state === 'suspended') {
        await audioContextRef.current.resume();
      }

      inputContextRef.current = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 16000 });
      
      // 2. Get Mic Stream
      const audioStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      
      const ai = getAIClient();
      
      // 3. Connect to Live API
      const sessionPromise = ai.live.connect({
        model: MODEL_NAME,
        config: {
          responseModalities: [Modality.AUDIO],
          systemInstruction: SYSTEM_INSTRUCTION,
          inputAudioTranscription: {}, 
          speechConfig: {
            voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Puck' } } 
          }
        },
        callbacks: {
          onopen: () => {
            console.log("MARK Connected");
            setConnectionState(ConnectionState.CONNECTED);
            setTranscript("MARK is listening...");
            
            // Start Audio Stream Processing
            const source = inputContextRef.current!.createMediaStreamSource(audioStream);
            const processor = inputContextRef.current!.createScriptProcessor(4096, 1, 1);
            
            processor.onaudioprocess = (e) => {
                if (!isMicActive) return;

                const inputData = e.inputBuffer.getChannelData(0);
                
                // Simple VAD
                let sum = 0;
                for(let i=0; i<inputData.length; i++) sum += inputData[i] * inputData[i];
                const rms = Math.sqrt(sum / inputData.length);
                setUserSpeaking(rms > 0.02);

                const blob = createAudioBlob(inputData);
                
                sessionPromiseRef.current?.then(session => {
                    session.sendRealtimeInput({ media: blob });
                });
            };

            source.connect(processor);
            processor.connect(inputContextRef.current!.destination);
          },
          onmessage: (msg: LiveServerMessage) => {
            // Audio Output
            const audioData = msg.serverContent?.modelTurn?.parts?.[0]?.inlineData?.data;
            if (audioData) {
                playAudioChunk(audioData);
            }

            // User Transcription
            const inputTrans = msg.serverContent?.inputTranscription?.text;
            if (inputTrans) {
                clearTimeout(transcriptionTimeoutRef.current!);
                setTranscript(`You: ${inputTrans}`);
                transcriptionTimeoutRef.current = setTimeout(() => setTranscript(""), 5000);
            }

            // Interruption
            if (msg.serverContent?.interrupted) {
                console.log("Model Interrupted");
                nextStartTimeRef.current = 0;
                setModelSpeaking(false);
            }
          },
          onclose: () => {
            console.log("Session Closed");
            // If closed remotely, we handle it as a disconnect
            disconnect();
          },
          onerror: (err) => {
            console.error("Session Error", err);
            setConnectionState(ConnectionState.ERROR);
            setTranscript("Error connecting to MARK.");
          }
        }
      });

      sessionPromiseRef.current = sessionPromise;

    } catch (e) {
      console.error(e);
      setConnectionState(ConnectionState.ERROR);
      setTranscript("Failed to initialize. Check permissions.");
    }
  };

  const disconnect = useCallback(() => {
    // 1. Close Audio Contexts
    if (inputContextRef.current) {
      inputContextRef.current.close();
      inputContextRef.current = null;
    }
    if (audioContextRef.current) {
      // We don't necessarily close the output context to allow re-use, 
      // but suspending it stops processing.
      audioContextRef.current.suspend(); 
    }
    
    // 2. Stop Media Streams (Mic & Camera)
    if (streamRef.current) {
        streamRef.current.getTracks().forEach(track => track.stop());
        streamRef.current = null;
    }
    
    // 3. Clear Intervals
    if (frameIntervalRef.current) {
      clearInterval(frameIntervalRef.current);
      frameIntervalRef.current = null;
    }

    // 4. Reset UI State
    setConnectionState(ConnectionState.DISCONNECTED);
    setTranscript("");
    setIsCameraActive(false);
    setModelSpeaking(false);
    setUserSpeaking(false);
    
    // 5. Clean up session reference
    sessionPromiseRef.current = null;
  }, []);

  // --- Video Handling ---
  const startCamera = async () => {
    try {
        const stream = await navigator.mediaDevices.getUserMedia({ 
            video: { 
                width: { ideal: 1920 }, // Full HD for better object detection
                height: { ideal: 1080 },
                facingMode: "environment" // Use back camera if available (better for objects)
            } 
        });
        if (videoRef.current) {
            videoRef.current.srcObject = stream;
            videoRef.current.play();
        }
        streamRef.current = stream;
        setIsCameraActive(true);

        // Send frames every 600ms (balanced for performance/latency)
        frameIntervalRef.current = window.setInterval(sendVideoFrame, 600); 
    } catch (e) {
        console.error("Camera access denied", e);
        setTranscript("Camera permission denied.");
    }
  };

  const stopCamera = () => {
    if (streamRef.current) {
        streamRef.current.getVideoTracks().forEach(t => t.stop());
    }
    if (frameIntervalRef.current) {
      clearInterval(frameIntervalRef.current);
      frameIntervalRef.current = null;
    }
    setIsCameraActive(false);
  };

  const sendVideoFrame = async () => {
    if (!videoRef.current || !canvasRef.current || !isCameraActive) return;

    const ctx = canvasRef.current.getContext('2d');
    if (!ctx) return;

    canvasRef.current.width = videoRef.current.videoWidth;
    canvasRef.current.height = videoRef.current.videoHeight;
    ctx.drawImage(videoRef.current, 0, 0);

    // High quality JPEG (0.8) for detailed object detection
    canvasRef.current.toBlob(async (blob) => {
        if (blob) {
            const base64 = await blobToBase64(blob);
            sessionPromiseRef.current?.then(session => {
                session.sendRealtimeInput({
                    media: {
                        mimeType: 'image/jpeg',
                        data: base64
                    }
                });
            });
        }
    }, 'image/jpeg', 0.8);
  };

  // Toggle Camera
  useEffect(() => {
    if (connectionState === ConnectionState.CONNECTED) {
        if (isCameraActive) {
            // If we don't have a stream yet, start it
            if (!streamRef.current || streamRef.current.getVideoTracks().length === 0) {
                 startCamera();
            }
        } else {
            stopCamera();
        }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isCameraActive, connectionState]);


  return (
    <div className="min-h-screen bg-black text-white flex flex-col items-center justify-between p-4 relative font-sans">
      {/* Background Elements */}
      <div className="absolute top-0 left-0 w-full h-full overflow-hidden z-0 pointer-events-none">
        <div className={`absolute top-1/2 left-1/2 transform -translate-x-1/2 -translate-y-1/2 w-96 h-96 bg-blue-900 rounded-full blur-[128px] opacity-20 transition-all duration-1000 ${modelSpeaking ? 'scale-125 opacity-40' : 'scale-100'}`}></div>
        <div className={`absolute top-1/4 right-1/4 w-64 h-64 bg-purple-900 rounded-full blur-[96px] opacity-20 transition-all duration-1000 ${userSpeaking ? 'scale-125 opacity-40' : 'scale-100'}`}></div>
      </div>

      {/* Header */}
      <header className="z-10 w-full flex justify-between items-center p-2">
        <div className="flex items-center gap-2">
            <Zap className="w-6 h-6 text-yellow-400 fill-current" />
            <span className="font-bold text-xl tracking-wider">MARK</span>
        </div>
        <div className="text-xs text-gray-400">Created by Ankit Raj</div>
      </header>

      {/* Main Content Area */}
      <main className="z-10 flex-1 flex flex-col items-center justify-center w-full max-w-md gap-8">
        
        {/* Hidden Video Elements */}
        <video ref={videoRef} className="hidden" muted playsInline />
        <canvas ref={canvasRef} className="hidden" />

        {/* Camera Preview */}
        {isCameraActive && (
            <div className="relative w-72 h-48 rounded-2xl overflow-hidden border border-gray-700 shadow-2xl mb-4 transition-all duration-500 ease-out transform translate-y-0 opacity-100">
                 <video 
                    ref={(el) => {
                        if (el && streamRef.current) el.srcObject = streamRef.current;
                        if (el) el.play();
                    }} 
                    className="w-full h-full object-cover" 
                    muted 
                    playsInline 
                 />
                 <div className="absolute top-2 right-2 flex items-center gap-1 bg-black/60 px-2 py-1 rounded-full backdrop-blur-sm">
                    <div className="w-2 h-2 bg-red-500 rounded-full animate-pulse"></div>
                    <span className="text-[10px] uppercase font-bold text-white">Live Vision</span>
                 </div>
                 {/* Scanning Effect Overlay */}
                 <div className="absolute top-0 left-0 w-full h-1 bg-blue-400/50 shadow-[0_0_15px_rgba(96,165,250,0.8)] animate-[scan_2s_linear_infinite]"></div>
            </div>
        )}

        {/* Status Text */}
        <div className="text-center space-y-4 h-32 flex flex-col justify-center">
            {connectionState === ConnectionState.CONNECTED ? (
                <>
                    <h2 className="text-3xl font-light text-gray-100 tracking-tight">
                        {modelSpeaking ? "Speaking..." : (userSpeaking ? "Listening..." : (isCameraActive ? "Watching..." : "I'm here."))}
                    </h2>
                    <p className="text-sm text-blue-300/80 font-medium h-6 overflow-hidden text-ellipsis px-4 animate-pulse">
                        {transcript}
                    </p>
                </>
            ) : (
                <div className="space-y-2">
                     <h2 className="text-3xl font-bold text-transparent bg-clip-text bg-gradient-to-r from-blue-400 to-purple-400">
                        Namaste
                    </h2>
                    <p className="text-gray-400 text-sm">
                        {connectionState === ConnectionState.CONNECTING ? "Establishing secure connection..." : "Tap below to wake me up"}
                    </p>
                </div>
            )}
        </div>

        {/* Visualizer */}
        <Visualizer 
            isActive={connectionState === ConnectionState.CONNECTED}
            isSpeaking={modelSpeaking}
            isListening={userSpeaking}
        />

      </main>

      {/* Controls */}
      <footer className="z-10 w-full max-w-md pb-8 px-6">
        {connectionState === ConnectionState.DISCONNECTED || connectionState === ConnectionState.ERROR ? (
            <button 
                onClick={connectToGemini}
                className="w-full bg-white hover:bg-gray-100 text-black font-bold py-5 rounded-full shadow-[0_0_30px_rgba(255,255,255,0.3)] transition-all transform hover:scale-[1.02] active:scale-[0.98] flex items-center justify-center gap-3"
            >
                <Mic className="w-6 h-6" />
                <span className="tracking-widest">START CONVERSATION</span>
            </button>
        ) : (
            <div className="flex flex-col items-center gap-6 w-full animate-in fade-in slide-in-from-bottom-8 duration-500">
                {/* Connection State: CONNECTING */}
                {connectionState === ConnectionState.CONNECTING ? (
                    <div className="flex items-center gap-2 text-blue-400">
                        <Loader2 className="w-6 h-6 animate-spin" />
                        <span>Initializing...</span>
                    </div>
                ) : (
                    <>
                        {/* Primary Controls Row */}
                        <div className="flex items-center justify-center gap-8">
                            {/* Camera Toggle */}
                            <button 
                                onClick={() => setIsCameraActive(!isCameraActive)}
                                className={`p-5 rounded-full transition-all duration-300 border ${isCameraActive ? 'bg-white text-black border-white shadow-[0_0_20px_rgba(255,255,255,0.4)]' : 'bg-gray-900/50 text-white border-gray-700 hover:bg-gray-800'}`}
                            >
                                {isCameraActive ? <Video className="w-6 h-6" /> : <Camera className="w-6 h-6" />}
                            </button>

                            {/* Mic/Mute Toggle */}
                            <button 
                                onClick={() => setIsMicActive(!isMicActive)}
                                className={`p-7 rounded-full shadow-2xl transition-all duration-300 border transform ${isMicActive ? 'bg-blue-600 text-white border-blue-400 shadow-[0_0_25px_rgba(37,99,235,0.5)] scale-110' : 'bg-red-500/80 text-white border-red-500 hover:bg-red-500'}`}
                            >
                                {isMicActive ? <Mic className="w-8 h-8" /> : <MicOff className="w-8 h-8" />}
                            </button>
                        </div>

                        {/* End Conversation Button */}
                        <button 
                            onClick={disconnect}
                            className="group w-full max-w-[200px] bg-red-950/30 backdrop-blur-sm border border-red-900/50 text-red-400 font-semibold py-3 px-6 rounded-2xl hover:bg-red-900/50 hover:text-red-200 transition-all flex items-center justify-center gap-2 mt-2"
                        >
                            <StopCircle className="w-5 h-5 group-hover:scale-110 transition-transform" />
                            <span>End Conversation</span>
                        </button>
                    </>
                )}
            </div>
        )}
      </footer>
      
      {/* CSS for Scan Animation */}
      <style>{`
        @keyframes scan {
            0% { top: 0%; opacity: 0; }
            10% { opacity: 1; }
            90% { opacity: 1; }
            100% { top: 100%; opacity: 0; }
        }
      `}</style>
    </div>
  );
};

export default App;