// --- 0. Socket Initialization ---
let socket;
try {
    socket = io();
} catch (e) {
    console.error("Socket.io failed to initialize. Server might be down.", e);
    alert("Connection failed. Please ensure the server is running.");
}

// --- DOM Elements ---
const loginScreen = document.getElementById('login-screen');
const sessionScreen = document.getElementById('session-screen');

const usernameInput = document.getElementById('username-input');
const roomInput = document.getElementById('room-input');
const passwordInput = document.getElementById('password-input');
const joinBtn = document.getElementById('join-btn');

const roomDisplay = document.getElementById('room-display');
const copyLinkBtn = document.getElementById('copy-link-btn');
const qrModal = document.getElementById('qr-modal');
const qrContainer = document.getElementById('qrcode');
const closeQrBtn = document.getElementById('close-qr');
const videoGrid = document.getElementById('video-grid');
const localVideo = document.getElementById('local-video');

const messagesContainer = document.getElementById('messages-container');
const messageInput = document.getElementById('message-input');
const sendBtn = document.getElementById('send-btn');
const leaveBtn = document.getElementById('leave-btn');
const joinCallBtn = document.getElementById('join-call-btn');
const controlsBar = document.getElementById('controls-bar');

const chatOverlay = document.getElementById('chat-overlay');
const toggleChatBtn = document.getElementById('toggle-chat');
const closeChatBtn = document.getElementById('close-chat');
const toggleMicBtn = document.getElementById('toggle-mic');
const toggleCamBtn = document.getElementById('toggle-cam');
const screenshotWarning = document.getElementById('screenshot-warning');
const privacyShield = document.getElementById('privacy-shield');

// --- State ---
let myUsername = '';
let myRoomId = '';
let sharedKey = null; // The PBKDF2 derived key for AES-GCM
let localStream = null;
let isAudioEnabled = true;
let isVideoEnabled = true;
let isInCall = false;
let activeUsers = new Set(); // Track all users in the room (for late call joining)

// Map: socketId -> { pc: RTCPeerConnection, videoEl: HTMLElement }
const peers = {};

const rtcConfig = {
    iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' }
    ]
};

// --- 0. Direct Link Logic ---
window.addEventListener('load', () => {
    if (window.location.hash) {
        try {
            const params = new URLSearchParams(window.location.hash.substring(1));
            
            // ONE-TIME TOKEN LOGIC
            const token = params.get('token');
            const key = params.get('key');

            if (token && key) {
                // Ask server to redeem token
                socket.emit('redeem-invite-token', { token });
                passwordInput.value = key; // Pre-fill password (secure in client)
                
                // Wait for server response
                socket.once('invite-token-valid', ({ roomId }) => {
                    roomInput.value = roomId;
                    if (!usernameInput.value) usernameInput.focus();
                    
                    // Clear hash so it cannot be reused or seen easily
                    history.replaceState(null, null, ' ');
                });

                socket.once('invite-token-invalid', () => {
                    alert("This invite link has expired or already been used.");
                    // Clear fields to be safe
                    roomInput.value = '';
                    passwordInput.value = '';
                    history.replaceState(null, null, ' ');
                });
            } else {
                // Fallback for old-style links (optional, or just remove)
                const room = params.get('room');
                if (room) roomInput.value = room;
                if (key) passwordInput.value = key;
            }

        } catch (e) {
            console.error("Error parsing invite link:", e);
        }
    }
});

copyLinkBtn.addEventListener('click', () => {
    if (!myRoomId || !passwordInput.value) {
        alert("Please join a room first before inviting others.");
        return;
    }
    
    // Request a One-Time Token from Server
    socket.emit('create-invite-token', { roomId: myRoomId });
});

socket.on('invite-token-created', ({ token }) => {
    const baseUrl = window.location.origin + window.location.pathname;
    // Format: #token=XYZ&key=PASSWORD
    const hash = `token=${encodeURIComponent(token)}&key=${encodeURIComponent(passwordInput.value)}`;
    const fullUrl = `${baseUrl}#${hash}`;
    
    // Copy to clipboard
    navigator.clipboard.writeText(fullUrl).then(() => {
        const originalText = copyLinkBtn.innerHTML;
        copyLinkBtn.innerHTML = '<i class="fas fa-check"></i> Copied!';
        setTimeout(() => {
            copyLinkBtn.innerHTML = originalText;
        }, 2000);
    }).catch(err => {
        console.error('Failed to copy: ', err);
        // Fallback for mobile/secure context issues: Show a prompt
        prompt("Copy this link to share:", fullUrl);
    });

    // Show QR Code
    qrContainer.innerHTML = "";
    new QRCode(qrContainer, {
        text: fullUrl,
        width: 200,
        height: 200
    });
    qrModal.classList.remove('hidden');
});

closeQrBtn.addEventListener('click', () => {
    qrModal.classList.add('hidden');
});

// --- 1. Login & Crypto Setup ---

joinBtn.addEventListener('click', async () => {
    const username = usernameInput.value.trim();
    const room = roomInput.value.trim();
    const password = passwordInput.value.trim();

    if (!username || !room || !password) {
        alert("Please fill in all fields.");
        return;
    }

    if (password.length < 6) {
        alert("Security Alert: Password must be at least 6 characters long.");
        return;
    }

    myUsername = username;
    myRoomId = room;

    // Derive Key from Password (PBKDF2)
    // We use the Room ID as the salt to ensure uniqueness across rooms
    try {
        sharedKey = await deriveKeyFromPassword(password, room);
        
        // Setup UI
        loginScreen.classList.add('hidden');
        sessionScreen.classList.remove('hidden');
        roomDisplay.textContent = `Room: ${room}`;
        
        // Note: We do NOT start media here. User is in "Chat Mode" only.
        // Media is started when they click "Join Call".

        // Join Room
        socket.emit('join-room', { roomId: room, username: username });

    } catch (e) {
        console.error("Setup failed:", e);
        alert("Encryption setup failed. Browser may not support WebCrypto.");
    }
});

leaveBtn.addEventListener('click', () => {
    window.location.reload();
});

if (typeof destroyBtn !== 'undefined' && destroyBtn) {
    destroyBtn.addEventListener('click', () => {
        if (confirm("WARNING: This will KICK EVERYONE OUT and DESTROY the room immediately. Are you sure?")) {
            socket.emit('destroy-room');
        }
    });
}

if (joinCallBtn) {
    joinCallBtn.addEventListener('click', async () => {
        isInCall = true;
        try {
            await startLocalMedia();
            videoGrid.classList.remove('hidden');
            if (controlsBar) controlsBar.classList.remove('hidden'); // Show controls
            joinCallBtn.classList.add('hidden'); // Hide button after joining
            // Optional: Change to "Leave Call" button logic if needed later

            activeUsers.forEach(userId => {
                if (userId !== socket.id) initiateConnection(userId);
            });
        } catch (e) {
            console.error("Error joining call:", e);
        }
    });
}

// --- 2. Crypto Functions (PBKDF2 + AES-GCM) ---

async function deriveKeyFromPassword(password, saltString) {
    const enc = new TextEncoder();
    const keyMaterial = await window.crypto.subtle.importKey(
        "raw", 
        enc.encode(password), 
        { name: "PBKDF2" }, 
        false, 
        ["deriveKey"]
    );

    return window.crypto.subtle.deriveKey(
        {
            name: "PBKDF2",
            salt: enc.encode(saltString),
            iterations: 100000,
            hash: "SHA-256"
        },
        keyMaterial,
        { name: "AES-GCM", length: 256 },
        false,
        ["encrypt", "decrypt"]
    );
}

async function encryptData(text) {
    const enc = new TextEncoder();
    const iv = window.crypto.getRandomValues(new Uint8Array(12));
    const encoded = enc.encode(text);
    
    const ciphertext = await window.crypto.subtle.encrypt(
        { name: "AES-GCM", iv: iv },
        sharedKey,
        encoded
    );

    return {
        iv: Array.from(iv),
        ct: Array.from(new Uint8Array(ciphertext))
    };
}

async function decryptData(ivArr, ctArr) {
    const iv = new Uint8Array(ivArr);
    const ct = new Uint8Array(ctArr);
    
    try {
        const decrypted = await window.crypto.subtle.decrypt(
            { name: "AES-GCM", iv: iv },
            sharedKey,
            ct
        );
        const dec = new TextDecoder();
        return dec.decode(decrypted);
    } catch (e) {
        console.error("Decryption failed:", e);
        return "[Encrypted Message - Wrong Password?]";
    }
}


// --- 3. Media & WebRTC (Mesh) ---

async function startLocalMedia() {
    try {
        localStream = await navigator.mediaDevices.getUserMedia({ 
            video: true, 
            audio: true 
        });
        localVideo.srcObject = localStream;
    } catch (e) {
        console.error("Media access denied:", e);
        alert("Camera/Mic access required for calls.");
    }
}

// Socket Events
socket.on('room-users', (users) => {
    // Update active users list
    users.forEach(user => activeUsers.add(user.id));
    
    // NOTE: We do NOT initiate connection here anymore.
    // We only connect when the user clicks "Join Call".
});

socket.on('user-joined', (user) => {
    activeUsers.add(user.id);
    console.log(`User joined: ${user.username} (${user.id})`);
    // Note: If we are already in a call, we could initiate here, 
    // OR we wait for them to initiate (if they are joining call).
    // Current Logic: The "Join Call" clicker initiates.
});

socket.on('user-left', (socketId) => {
    activeUsers.delete(socketId);
    removePeer(socketId);
});

socket.on('room-destroyed', () => {
    // 1. Wipe sensitive data immediately
    sharedKey = null;
    myRoomId = '';
    myUsername = '';
    messagesContainer.innerHTML = '';
    
    // 2. Stop all media tracks
    if (localStream) {
        localStream.getTracks().forEach(track => track.stop());
    }
    
    // 3. Close all peer connections
    for (const id in peers) {
        if (peers[id].pc) peers[id].pc.close();
    }
    
    // 4. Force reload to clear remaining state
    alert("This room has been destroyed by a user. All data is gone.");
    window.location.href = "/"; // Redirect to clean URL
});

socket.on('signal', async (data) => {
    // If I am not in the call, I ignore all signaling (WebRTC) messages.
    if (!isInCall) return;

    // data: { sender, type, payload }
    // Payload is ENCRYPTED? 
    // Ideally yes, but ICE candidates are tricky. 
    // For now, let's assume payload is PLAIN WebRTC signaling for simplicity in v1 of group chat,
    // BUT we encrypt the CHAT. 
    // IF we want to encrypt signaling, we wrap payload in encryptData/decryptData.
    // Let's do PLAIN signaling for stability first, as debugging encrypted SDP is hard.
    // The CHAT is definitely encrypted.
    
    const { sender, type, payload } = data;
    const peer = getOrCreatePeer(sender, false); // false = not initiator
    const pc = peer.pc;

    try {
        if (type === 'offer') {
            await pc.setRemoteDescription(new RTCSessionDescription(payload));
            const answer = await pc.createAnswer();
            await pc.setLocalDescription(answer);
            socket.emit('signal', { target: sender, type: 'answer', payload: answer });
        } else if (type === 'answer') {
            await pc.setRemoteDescription(new RTCSessionDescription(payload));
        } else if (type === 'candidate') {
            if (payload) {
                await pc.addIceCandidate(new RTCIceCandidate(payload));
            }
        }
    } catch (e) {
        console.error("Signaling error:", e);
    }
});

function getOrCreatePeer(socketId, isInitiator) {
    if (peers[socketId]) return peers[socketId];

    const pc = new RTCPeerConnection(rtcConfig);
    
    // Add local tracks
    if (localStream) {
        localStream.getTracks().forEach(track => pc.addTrack(track, localStream));
    }

    // Handle remote track
    pc.ontrack = (event) => {
        const stream = event.streams[0];
        if (!peers[socketId].videoEl) {
            const wrapper = document.createElement('div');
            wrapper.className = 'video-wrapper';
            wrapper.id = `wrapper-${socketId}`;
            
            const vid = document.createElement('video');
            vid.autoplay = true;
            vid.playsInline = true;
            vid.srcObject = stream;
            
            const label = document.createElement('span');
            label.className = 'video-label';
            label.innerText = getUsername(socketId) || 'User'; // We might not know username yet

            wrapper.appendChild(vid);
            wrapper.appendChild(label);
            videoGrid.appendChild(wrapper);
            
            peers[socketId].videoEl = wrapper;
        }
    };

    pc.onicecandidate = (event) => {
        if (event.candidate) {
            socket.emit('signal', {
                target: socketId,
                type: 'candidate',
                payload: event.candidate
            });
        }
    };

    peers[socketId] = { pc, videoEl: null };
    return peers[socketId];
}

async function initiateConnection(targetId) {
    const peer = getOrCreatePeer(targetId, true);
    const pc = peer.pc;

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    
    socket.emit('signal', {
        target: targetId,
        type: 'offer',
        payload: offer
    });
}

function removePeer(socketId) {
    if (peers[socketId]) {
        peers[socketId].pc.close();
        if (peers[socketId].videoEl) {
            peers[socketId].videoEl.remove();
        }
        delete peers[socketId];
    }
}

// Helper to get username (we don't strictly have it in 'peers' yet, could add it)
function getUsername(id) {
    // In a real app, we'd store the username in the peers object when they join
    return "Peer"; 
}


// --- 4. Encrypted Chat ---

sendBtn.addEventListener('click', sendMessage);
messageInput.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') sendMessage();
});

async function sendMessage() {
    const text = messageInput.value.trim();
    if (!text) return;

    // Encrypt
    const encrypted = await encryptData(text);
    
    // Send
    socket.emit('encrypted-chat', { payload: encrypted });
    
    // Display Local
    appendMessage("You", text, true);
    messageInput.value = '';
}

socket.on('encrypted-chat', async (data) => {
    // data: { sender, username, payload: {iv, ct}, timestamp }
    const decryptedText = await decryptData(data.payload.iv, data.payload.ct);
    appendMessage(data.username, decryptedText, false);
});

function appendMessage(user, text, isSelf) {
    const div = document.createElement('div');
    div.className = `message ${isSelf ? 'self' : 'remote'}`;
    
    const meta = document.createElement('div');
    meta.className = 'meta';
    meta.innerText = user;
    
    const content = document.createElement('div');
    content.className = 'content';
    
    // LINKIFY: Check for URLs and convert to <a> tags
    // Simple regex for HTTP/HTTPS links
    const urlRegex = /(https?:\/\/[^\s]+)/g;
    
    if (urlRegex.test(text)) {
        // Replace URLs with anchor tags, but sanitize first by creating text nodes for non-url parts
        // Actually, easier to just split and build nodes to avoid XSS
        const parts = text.split(urlRegex);
        parts.forEach(part => {
            if (urlRegex.test(part)) {
                const a = document.createElement('a');
                a.href = part;
                a.target = '_blank';
                a.rel = 'noopener noreferrer';
                a.innerText = part;
                a.style.color = '#00e676';
                a.style.textDecoration = 'underline';
                content.appendChild(a);
            } else {
                content.appendChild(document.createTextNode(part));
            }
        });
    } else {
        content.innerText = text;
    }
    
    div.appendChild(meta);
    div.appendChild(content);
    
    messagesContainer.appendChild(div);
    messagesContainer.scrollTop = messagesContainer.scrollHeight;
}


// --- 5. Privacy Features ---

// Screenshot Warning
window.addEventListener('keyup', (e) => {
    if (e.key === 'PrintScreen') {
        socket.emit('screenshot-detected');
        showWarning("You took a screenshot!");
    }
});

socket.on('screenshot-alert', (data) => {
    showWarning(`${data.username} took a screenshot!`);
});

function showWarning(text) {
    screenshotWarning.innerText = text;
    screenshotWarning.classList.remove('hidden');
    setTimeout(() => {
        screenshotWarning.classList.add('hidden');
    }, 4000);
}

// Privacy Shield (Blur/Focus)
window.addEventListener('blur', () => {
    privacyShield.classList.remove('hidden');
});

window.addEventListener('focus', () => {
    privacyShield.classList.add('hidden');
});
privacyShield.addEventListener('click', () => {
    privacyShield.classList.add('hidden');
});


// --- 6. UI Controls ---

if (toggleChatBtn) {
    toggleChatBtn.addEventListener('click', () => {
        chatOverlay.classList.toggle('visible');
        // For mobile, we might want to toggle a class on body to prevent scroll
    });
}

if (closeChatBtn) {
    closeChatBtn.addEventListener('click', () => {
        chatOverlay.classList.remove('visible');
    });
}

if (toggleMicBtn) {
    toggleMicBtn.addEventListener('click', () => {
        if (localStream) {
            isAudioEnabled = !isAudioEnabled;
            localStream.getAudioTracks()[0].enabled = isAudioEnabled;
            toggleMicBtn.innerHTML = isAudioEnabled ? '<i class="fas fa-microphone"></i>' : '<i class="fas fa-microphone-slash"></i>';
            toggleMicBtn.classList.toggle('active', isAudioEnabled);
        }
    });
}

if (toggleCamBtn) {
    toggleCamBtn.addEventListener('click', () => {
        if (localStream) {
            isVideoEnabled = !isVideoEnabled;
            localStream.getVideoTracks()[0].enabled = isVideoEnabled;
            toggleCamBtn.innerHTML = isVideoEnabled ? '<i class="fas fa-video"></i>' : '<i class="fas fa-video-slash"></i>';
            toggleCamBtn.classList.toggle('active', isVideoEnabled);
        }
    });
}
