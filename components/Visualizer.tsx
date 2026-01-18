import React, { useEffect, useRef } from 'react';

interface VisualizerProps {
  isActive: boolean;
  isSpeaking: boolean; // Model is speaking
  isListening: boolean; // User is speaking
}

const Visualizer: React.FC<VisualizerProps> = ({ isActive, isSpeaking, isListening }) => {
  const barsRef = useRef<HTMLDivElement[]>([]);

  useEffect(() => {
    if (!isActive) return;

    let animationFrameId: number;
    
    const animate = () => {
      barsRef.current.forEach((bar, index) => {
        if (!bar) return;
        
        let height = 10; // Base height
        
        if (isSpeaking) {
           // Simulating voice modulation
           height = 20 + Math.random() * 80;
        } else if (isListening) {
           // Simulating listening activity (gentler)
           height = 15 + Math.random() * 40;
        } else {
            // Idle breathing
            const time = Date.now() / 500;
            height = 15 + Math.sin(time + index) * 5;
        }

        bar.style.height = `${height}%`;
        
        // Color modulation
        if (isSpeaking) {
            bar.style.backgroundColor = '#60A5FA'; // Blue
            bar.style.boxShadow = '0 0 10px #60A5FA';
        } else if (isListening) {
            bar.style.backgroundColor = '#34D399'; // Green
            bar.style.boxShadow = '0 0 10px #34D399';
        } else {
            bar.style.backgroundColor = '#555';
            bar.style.boxShadow = 'none';
        }
      });
      animationFrameId = requestAnimationFrame(animate);
    };

    animate();

    return () => cancelAnimationFrame(animationFrameId);
  }, [isActive, isSpeaking, isListening]);

  return (
    <div className="flex justify-center items-center h-48 w-full gap-2 overflow-hidden">
      {[...Array(5)].map((_, i) => (
        <div
          key={i}
          ref={(el) => {
            if (el) barsRef.current[i] = el;
          }}
          className="w-4 rounded-full bg-gray-600 transition-all duration-75 visualizer-bar"
          style={{ height: '10%' }}
        ></div>
      ))}
    </div>
  );
};

export default Visualizer;