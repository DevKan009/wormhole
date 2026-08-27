'use strict';

/**
 * WebRTC P2P Client Connection & File Transfer Manager
 * Coordinates Signaling WebSocket, STUN ICE Negotiation, DataChannel Framing,
 * Off-Thread Web Worker Chunk Encryption, and E2EE Decryption.
 */

const RTC_CONFIG = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:global.stun.twilio.com:3478' }
  ]
};

// Convert ArrayBuffer to Hex String
function bufToHex(buffer) {
  return Array.from(new Uint8Array(buffer))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

// Convert Hex String to Uint8Array
function hexToBuf(hex) {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.substr(i * 2, 2), 16);
  }
  return bytes.buffer;
}

class WebRTCManager {
  constructor(options = {}) {
    this.wsUrl = options.wsUrl || this._getDefaultWsUrl();
    this.ws = null;
    this.pc = null;
    this.dataChannel = null;
    this.fileSender = null;
    this.fileReceiver = null;
    this.worker = null;
    this.isInitiator = false;
    this.roomCode = null;
    this.peerConnected = false;

    // Callbacks
    this.onStateChange = options.onStateChange || (() => {});
    this.onRoomCreated = options.onRoomCreated || (() => {});
    this.onJoined = options.onJoined || (() => {});
    this.onPeerJoined = options.onPeerJoined || (() => {});
    this.onP2PConnected = options.onP2PConnected || (() => {});
    this.onP2PDisconnected = options.onP2PDisconnected || (() => {});
    this.onFileTransferStart = options.onFileTransferStart || (() => {});
    this.onFileProgress = options.onFileProgress || (() => {});
    this.onFileComplete = options.onFileComplete || (() => {});
    this.onBackpressureChange = options.onBackpressureChange || (() => {});
    this.onError = options.onError || (() => {});
  }

  _getDefaultWsUrl() {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${protocol}//${window.location.host}`;
  }

  /**
   * Connect to WebSocket Signaling Server
   */
  connectSignaling() {
    return new Promise((resolve, reject) => {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        resolve();
        return;
      }

      this.ws = new WebSocket(this.wsUrl);

      this.ws.onopen = () => {
        this.onStateChange('SIGNALING_CONNECTED');
        resolve();
      };

      this.ws.onerror = (err) => {
        this.onError('Signaling connection error');
        reject(err);
      };

      this.ws.onclose = () => {
        this.onStateChange('SIGNALING_DISCONNECTED');
        this._teardownP2P();
      };

      this.ws.onmessage = async (event) => {
        try {
          const msg = JSON.parse(event.data);
          await this._handleSignalingMessage(msg);
        } catch (err) {
          console.error('Failed to parse signaling message:', err);
        }
      };
    });
  }

  /**
   * Create a new 6-character room
   */
  async createRoom() {
    await this.connectSignaling();
    this.isInitiator = true;
    this.ws.send(JSON.stringify({ type: 'create' }));
  }

  /**
   * Join an existing room with 6-character code
   */
  async joinRoom(code) {
    await this.connectSignaling();
    this.isInitiator = false;
    const cleanCode = (code || '').trim().toUpperCase();
    this.ws.send(JSON.stringify({ type: 'join', roomCode: cleanCode }));
  }

  /**
   * Signaling Message Dispatcher
   */
  async _handleSignalingMessage(msg) {
    switch (msg.type) {
      case 'created':
        this.roomCode = msg.roomCode;
        this.onRoomCreated(msg.roomCode);
        break;

      case 'joined':
        this.roomCode = msg.roomCode;
        this.onJoined(msg.roomCode);
        this._initPeerConnection();
        break;

      case 'peer-joined':
        this.onPeerJoined(msg.roomCode);
        // Initiator creates offer once peer has joined
        this._initPeerConnection();
        await this._createAndSendOffer();
        break;

      case 'offer':
        if (!this.isInitiator) {
          await this._handleOffer(msg);
        }
        break;

      case 'answer':
        if (this.isInitiator) {
          await this._handleAnswer(msg);
        }
        break;

      case 'ice-candidate':
        if (msg.candidate && this.pc) {
          try {
            await this.pc.addIceCandidate(new RTCIceCandidate(msg.candidate));
          } catch (e) {
            console.error('Error adding received ICE candidate:', e);
          }
        }
        break;

      case 'error':
        this.onError(msg.message || 'Signaling server error');
        break;
    }
  }

  /**
   * Initialize RTCPeerConnection and ICE handling
   */
  _initPeerConnection() {
    if (this.pc) return;

    this.pc = new RTCPeerConnection(RTC_CONFIG);

    this.pc.onicecandidate = (event) => {
      if (event.candidate && this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.send(
          JSON.stringify({
            type: 'ice-candidate',
            candidate: event.candidate
          })
        );
      }
    };

    this.pc.oniceconnectionstatechange = () => {
      const state = this.pc.iceConnectionState;
      this.onStateChange(`ICE_${state.toUpperCase()}`);
      if (state === 'disconnected' || state === 'failed' || state === 'closed') {
        this._teardownP2P();
        this.onP2PDisconnected();
      }
    };

    if (this.isInitiator) {
      // Initiator creates data channel
      this.dataChannel = this.pc.createDataChannel('fileTransfer', {
        ordered: true
      });
      this._setupDataChannel(this.dataChannel);
    } else {
      // Receiver waits for data channel from initiator
      this.pc.ondatachannel = (event) => {
        this.dataChannel = event.channel;
        this._setupDataChannel(this.dataChannel);
      };
    }
  }

  /**
   * Create WebRTC Offer
   */
  async _createAndSendOffer() {
    const offer = await this.pc.createOffer();
    await this.pc.setLocalDescription(offer);
    this.ws.send(
      JSON.stringify({
        type: 'offer',
        sdp: offer.sdp
      })
    );
  }

  /**
   * Handle WebRTC Offer
   */
  async _handleOffer(msg) {
    if (!this.pc) this._initPeerConnection();
    await this.pc.setRemoteDescription(new RTCSessionDescription({ type: 'offer', sdp: msg.sdp }));
    const answer = await this.pc.createAnswer();
    await this.pc.setLocalDescription(answer);
    this.ws.send(
      JSON.stringify({
        type: 'answer',
        sdp: answer.sdp
      })
    );
  }

  /**
   * Handle WebRTC Answer
   */
  async _handleAnswer(msg) {
    await this.pc.setRemoteDescription(new RTCSessionDescription({ type: 'answer', sdp: msg.sdp }));
  }

  /**
   * Setup RTCDataChannel event routing
   */
  _setupDataChannel(dc) {
    dc.binaryType = 'arraybuffer';
    dc.bufferedAmountLowThreshold = 262144; // 256 KB

    dc.onopen = () => {
      this.peerConnected = true;
      this.onP2PConnected();
      this.onStateChange('P2P_CONNECTED');
    };

    dc.onclose = () => {
      this.peerConnected = false;
      this.onP2PDisconnected();
      this.onStateChange('P2P_DISCONNECTED');
    };

    dc.onerror = (err) => {
      console.error('DataChannel error:', err);
      this.onError('Data channel connection error');
    };

    // Receiver DataChannel Message Listener
    let currentMetadata = null;
    let receiverInstance = null;

    dc.onmessage = async (event) => {
      // Handle Control JSON messages (e.g. file header with metadata & AES key)
      if (typeof event.data === 'string') {
        try {
          const control = JSON.parse(event.data);
          if (control.type === 'FILE_HEADER') {
            currentMetadata = control;
            const keyBuffer = hexToBuf(control.keyHex);

            receiverInstance = new WebRTCFileReceiver(dc, {
              key: keyBuffer,
              expectedTotalChunks: control.totalChunks,
              fileName: control.fileName,
              fileType: control.fileType,
              onProgress: (p) => {
                this.onFileProgress({
                  ...p,
                  fileName: control.fileName,
                  fileSize: control.fileSize,
                  isReceiver: true
                });
              },
              onComplete: (res) => {
                this.onFileComplete({
                  ...res,
                  fileName: control.fileName,
                  fileSize: control.fileSize
                });
              },
              onError: (err) => {
                this.onError(err.message || 'Decryption error on receiver');
              }
            });

            this.onFileTransferStart({
              fileName: control.fileName,
              fileSize: control.fileSize,
              totalChunks: control.totalChunks,
              isReceiver: true
            });
          }
        } catch (e) {
          console.error('Error parsing control message:', e);
        }
      }
    };
  }

  /**
   * Send a File across the DataChannel using Web Worker & AES-GCM 256-Bit
   */
  async sendFile(file) {
    if (!this.dataChannel || this.dataChannel.readyState !== 'open') {
      throw new Error('P2P connection is not established');
    }

    if (!file) {
      throw new Error('No file provided');
    }

    // 1. Generate 256-bit AES-GCM Key for this file transfer
    const key = await generateAESKey();
    const rawKeyBuffer = await exportRawKey(key);
    const keyHex = bufToHex(rawKeyBuffer);
    const totalChunks = Math.ceil(file.size / 65536) || 1;

    // 2. Send File Header to Receiver over DataChannel
    this.dataChannel.send(
      JSON.stringify({
        type: 'FILE_HEADER',
        fileName: file.name,
        fileSize: file.size,
        fileType: file.type || 'application/octet-stream',
        totalChunks,
        keyHex
      })
    );

    this.onFileTransferStart({
      fileName: file.name,
      fileSize: file.size,
      totalChunks,
      isReceiver: false
    });

    // 3. Instantiate Web Worker
    if (this.worker) {
      this.worker.terminate();
    }
    this.worker = new Worker('/fileWorker.js');

    // 4. Initialize WebRTCFileSender with backpressure
    this.fileSender = new WebRTCFileSender(this.dataChannel, {
      worker: this.worker,
      peerConnection: this.pc,
      onProgress: (p) => {
        this.onFileProgress({
          ...p,
          fileName: file.name,
          fileSize: file.size,
          isReceiver: false
        });
      },
      onComplete: (res) => {
        this.onFileComplete({
          ...res,
          fileName: file.name,
          fileSize: file.size
        });
      },
      onError: (err) => {
        this.onError(err.message || 'File send failed');
      },
      onBackpressureChange: (isPaused, bufferedAmount) => {
        this.onBackpressureChange(isPaused, bufferedAmount);
      }
    });

    // 5. Start off-thread streaming & encryption
    this.fileSender.sendFile(file, key);
  }

  /**
   * Pause current send transfer
   */
  pauseTransfer() {
    if (this.fileSender) {
      this.fileSender.pause();
    }
  }

  /**
   * Resume current send transfer
   */
  resumeTransfer() {
    if (this.fileSender) {
      this.fileSender.resume();
    }
  }

  /**
   * Cancel transfer & close connections
   */
  cancelTransfer() {
    if (this.fileSender) {
      this.fileSender.cancel();
    }
    this._teardownP2P();
  }

  _teardownP2P() {
    if (this.worker) {
      this.worker.terminate();
      this.worker = null;
    }
    if (this.dataChannel) {
      try {
        this.dataChannel.close();
      } catch {}
      this.dataChannel = null;
    }
    if (this.pc) {
      try {
        this.pc.close();
      } catch {}
      this.pc = null;
    }
    this.peerConnected = false;
  }

  /**
   * Complete teardown and disconnect
   */
  disconnect() {
    this._teardownP2P();
    if (this.ws) {
      try {
        this.ws.close();
      } catch {}
      this.ws = null;
    }
    this.roomCode = null;
    this.isInitiator = false;
  }
}

// Global attachment
if (typeof window !== 'undefined') {
  window.WebRTCManager = WebRTCManager;
}
