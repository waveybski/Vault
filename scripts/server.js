const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

// Serve static files from 'public' folder (relative to this script)
app.use(express.static(path.join(__dirname, 'public')));

// State
const rooms = {}; // roomId -> Set<socketId>
const socketToRoom = {}; // socketId -> roomId
const inviteTokens = {}; // token -> { roomId, created }

io.on('connection', (socket) => {
    
    // --- 1. Token Management ---
    socket.on('create-invite-token', ({ roomId }) => {
        const token = Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);
        inviteTokens[token] = { roomId, created: Date.now() };
        socket.emit('invite-token-created', { token });
        
        // Cleanup old tokens
        const now = Date.now();
        for (const t in inviteTokens) {
            if (now - inviteTokens[t].created > 86400000) delete inviteTokens[t];
        }
    });

    socket.on('redeem-invite-token', ({ token }) => {
        const invite = inviteTokens[token];
        if (invite) {
            socket.emit('invite-token-valid', { roomId: invite.roomId });
            // Optional: delete token if one-time use
            delete inviteTokens[token];
        } else {
            socket.emit('invite-token-invalid');
        }
    });

    // --- 2. Room Management ---
    socket.on('join-room', ({ roomId, username }) => {
        // Leave previous room if any
        const oldRoom = socketToRoom[socket.id];
        if (oldRoom) {
            socket.leave(oldRoom);
        }

        socket.join(roomId);
        socketToRoom[socket.id] = roomId;
        
        // Track users
        if (!rooms[roomId]) rooms[roomId] = [];
        rooms[roomId].push({ id: socket.id, username });

        // Notify others
        socket.to(roomId).emit('user-joined', { id: socket.id, username });
        
        // Send current users to new guy
        socket.emit('room-users', rooms[roomId]);
    });

    socket.on('disconnect', () => {
        const roomId = socketToRoom[socket.id];
        if (roomId && rooms[roomId]) {
            rooms[roomId] = rooms[roomId].filter(u => u.id !== socket.id);
            if (rooms[roomId].length === 0) delete rooms[roomId];
            socket.to(roomId).emit('user-left', socket.id);
        }
        delete socketToRoom[socket.id];
    });

    // --- 3. Signaling (WebRTC) ---
    socket.on('signal', (data) => {
        // data: { target, type, payload }
        io.to(data.target).emit('signal', {
            sender: socket.id,
            type: data.type,
            payload: data.payload
        });
    });

    // --- 4. Chat & Privacy ---
    socket.on('encrypted-chat', (data) => {
        const roomId = socketToRoom[socket.id];
        if (roomId) {
            // Relay to everyone ELSE in the room
            // We need to know who sent it. 
            // The client sends { payload }. We wrap it.
            // Find username
            const user = rooms[roomId]?.find(u => u.id === socket.id);
            const username = user ? user.username : "Anonymous";
            
            socket.to(roomId).emit('encrypted-chat', {
                sender: socket.id,
                username: username,
                payload: data.payload
            });
        }
    });

    socket.on('screenshot-detected', () => {
        const roomId = socketToRoom[socket.id];
        if (roomId) {
            const user = rooms[roomId]?.find(u => u.id === socket.id);
            socket.to(roomId).emit('screenshot-alert', { 
                username: user ? user.username : "Someone" 
            });
        }
    });

    // --- 5. Destroy Room ---
    socket.on('destroy-room', () => {
        const roomId = socketToRoom[socket.id];
        if (roomId) {
            io.in(roomId).emit('room-destroyed');
            // Force disconnect everyone
            io.in(roomId).disconnectSockets(true);
            
            delete rooms[roomId];
            // Also cleanup tokens for this room
            for (const t in inviteTokens) {
                if (inviteTokens[t].roomId === roomId) delete inviteTokens[t];
            }
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
