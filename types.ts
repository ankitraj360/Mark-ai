export interface AudioConfig {
    sampleRate: number;
    channels: number;
}

export enum ConnectionState {
    DISCONNECTED = 'disconnected',
    CONNECTING = 'connecting',
    CONNECTED = 'connected',
    ERROR = 'error'
}

export interface TranscriptItem {
    id: string;
    text: string;
    sender: 'user' | 'model';
    isFinal: boolean;
}