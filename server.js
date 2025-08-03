// server.js (v19.4 - Bugfix 6 - WebRTC Fix)
// - FIX: Meneruskan pesan sinyal WebRTC (offer, answer, candidate) ke target client.
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const axios = require('axios');

const { CookieJar } = require('tough-cookie');
const { wrapper } = require('axios-cookiejar-support');


const PORT = process.env.PORT || 3000;
const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// Sajikan file statis dari folder 'public'
app.use(express.static(path.join(__dirname, 'public')));

// Tangani permintaan ke root URL (/) dengan mengirimkan index.html
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ==================================
// Proxy Streamer untuk Google Drive (FIXED)
// ==================================

// Bungkus axios dengan dukungan cookie jar
const client = wrapper(axios.create({ jar: new CookieJar() }));

app.get('/stream/:fileId', async (req, res) => {
    try {
        const { fileId } = req.params;
        if (!/^[a-zA-Z0-9_-]+$/.test(fileId)) {
            return res.status(400).send('Invalid File ID format.');
        }
        const driveURL = `https://docs.google.com/uc?export=download&id=${fileId}`;

        const headers = {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/88.0.4324.190 Safari/537.36'
        };

        if (req.headers.range) {
            headers['Range'] = req.headers.range;
        }

        const response = await client({
            method: 'get',
            url: driveURL,
            responseType: 'stream',
            headers: headers
        });

        res.writeHead(response.status, response.headers);
        response.data.pipe(res);

    } catch (error) {
        console.error('GDrive Streaming Error:', error.message);
        res.status(500).send('Gagal melakukan streaming file dari Google Drive. Pastikan link valid dan dapat diakses.');
    }
});


// ==================================
// Konstanta Keamanan & Konfigurasi
// ==================================
const MAX_CHAT_HISTORY = 50;
const RECONNECT_GRACE_PERIOD = 5000;
const MAX_CLIENTS_PER_ROOM = 5;

const MAX_USERNAME_LENGTH = 15;
const MAX_PASSWORD_LENGTH = 50;
const MAX_ROOM_ID_LENGTH = 20;
const MAX_URL_LENGTH = 2048;
const MAX_CHAT_MESSAGE_LENGTH = 300;
const MAX_POLL_QUESTION_LENGTH = 150;
const MAX_POLL_OPTION_LENGTH = 50;
const MAX_SUPERCHAT_TEXT_LENGTH = 150;

const ACTION_RATE_LIMIT = 500;
const CHAT_RATE_LIMIT = 500;

let rooms = {};

// ==================================
// Helper Functions
// ==================================
const sanitize = (str) => {
    if (typeof str !== 'string') return str;
    return str.replace(/&/g, '&amp;')
              .replace(/</g, '&lt;')
              .replace(/>/g, '&gt;')
              .replace(/"/g, '&quot;')
              .replace(/'/g, '&#39;');
};


const broadcast = (roomId, message, excludeWs) => {
    const room = rooms[roomId];
    if (!room) return;
    const messageString = JSON.stringify(message);
    room.clients.forEach((clientData, ws) => {
        if (ws !== excludeWs && ws.readyState === WebSocket.OPEN) {
            ws.send(messageString);
        }
    });
};

const getRoomState = (roomId) => {
    const room = rooms[roomId];
    if (!room) return {};
    return {
        users: Array.from(room.clients.values()),
        playlist: room.playlist,
        videoState: room.videoState,
        activePoll: room.activePoll,
    };
};

const broadcastUserUpdate = (roomId) => {
    if (!rooms[roomId]) return;
    const users = Array.from(rooms[roomId].clients.values());
    broadcast(roomId, { type: 'updateUsers', payload: { users } });
};

const selectNewHost = (room) => {
    if (!room || room.clients.size === 0) return null;
    const firstClient = room.clients.entries().next().value;
    if (!firstClient) return null;
    const [newHostWs, newHostData] = firstClient;
    room.hostWs = newHostWs;
    newHostData.isHost = true;
    newHostWs.send(JSON.stringify({ type: 'roleAssign', payload: { role: 'host', users: Array.from(room.clients.values()) } }));
    return newHostData.username;
};

const addMessageToHistory = (roomId, messagePayload) => {
    const room = rooms[roomId];
    if (!room) return;
    room.chatHistory.push(messagePayload);
    if (room.chatHistory.length > MAX_CHAT_HISTORY) {
        room.chatHistory.shift();
    }
};

const getYouTubeID = (url) => { if (typeof url !== 'string') return null; const regex = /(?:https?:\/\/)?(?:www\.)?(?:youtube\.com\/(?:[^\/\n\s]+\/\S+\/|(?:v|e(?:mbed)?)\/|\S*?[?&]v=)|youtu\.be\/)([a-zA-Z0-9_-]{11})/; const match = url.match(regex); return match ? match[1] : null; };
const getGoogleDriveID = (url) => { if (typeof url !== 'string') return null; const regex = /drive\.google\.com\/(?:file\/d\/|open\?id=)([a-zA-Z0-9_-]+)/; const match = url.match(regex); return match ? match[1] : null; };

// ==================================
// WebSocket Connection Logic
// ==================================
wss.on('connection', (ws) => {
    let tempUserId = uuidv4();

    ws.on('message', (messageStr) => {
        try {
            if (messageStr.length > 8192) {
                ws.send(JSON.stringify({ type: 'error', payload: { message: 'Pesan terlalu besar.' } }));
                return;
            }
            const message = JSON.parse(messageStr);
            const { type, payload } = message;

            if (type !== 'joinRoom' && !ws.roomId) {
                console.warn(`[WARN] Received message of type '${type}' from a client that has not joined a room. Ignoring.`);
                return;
            }
            
            // GANTI SELURUH BLOK INI DI server.js
if (type === 'joinRoom') {
    const { username: rawUser, roomId: rawRoomId, password: rawPass, rejoin, userId: rejoinUserId, create } = payload;
    const username = sanitize(rawUser).slice(0, MAX_USERNAME_LENGTH);
    const password = sanitize(rawPass || '').slice(0, MAX_PASSWORD_LENGTH);
    if (!username) {
        ws.send(JSON.stringify({ type: 'error', payload: { message: 'Username tidak valid.' } }));
        return;
    }

    // --- LOGIKA BARU YANG LEBIH AMAN ---

    let roomId;
    let room;

    if (create) {
        // 1. Tangani pembuatan room baru secara terpisah
        roomId = 'room-' + Math.random().toString(36).substr(2, 6);
        room = rooms[roomId] = {
            id: roomId,
            clients: new Map(),
            hostWs: ws,
            videoState: null,
            playlist: [],
            typingUsers: new Set(),
            chatHistory: [],
            password: password || null,
            activePoll: null,
            disconnectTimeouts: new Map(),
        };
        ws.roomId = roomId;
        room.clients.set(ws, { id: tempUserId, username, isHost: true, lastActionTime: 0 });
    } else {
        // 2. Tangani join atau rejoin ke room yang sudah ada
        roomId = sanitize(rawRoomId || '').slice(0, MAX_ROOM_ID_LENGTH);
        room = rooms[roomId];

        // Pemeriksaan paling penting: Jika room tidak ada, langsung hentikan.
        if (!room) {
            const message = rejoin ? 'Sesi tidak ditemukan, silakan join ulang.' : 'Room ID tidak ditemukan.';
            ws.send(JSON.stringify({ type: 'error', payload: { message, reconnect: rejoin } }));
            return;
        }

        // Jika room ada, lanjutkan pemeriksaan lainnya
        if (room.clients.size >= MAX_CLIENTS_PER_ROOM && !rejoin) {
            ws.send(JSON.stringify({ type: 'error', payload: { message: 'Room penuh! Jumlah maksimal 5 orang telah tercapai.' } }));
            return;
        }
        if (room.password && room.password !== password) {
            ws.send(JSON.stringify({ type: 'error', payload: { message: 'Password salah!' } }));
            return;
        }

        ws.roomId = roomId;

        if (rejoin && rejoinUserId) {
            // Logika untuk rejoin
            if (room.disconnectTimeouts.has(rejoinUserId)) {
                clearTimeout(room.disconnectTimeouts.get(rejoinUserId));
                room.disconnectTimeouts.delete(rejoinUserId);
            }
            let oldWs = null;
            for (const [clientWs, clientData] of room.clients.entries()) {
                if (clientData.id === rejoinUserId) { oldWs = clientWs; break; }
            }
            if (oldWs) {
                const clientData = room.clients.get(oldWs);
                room.clients.delete(oldWs);
                room.clients.set(ws, { ...clientData, lastActionTime: 0 });
                if (room.hostWs === oldWs) { room.hostWs = ws; }
            } else {
                room.clients.set(ws, { id: tempUserId, username, isHost: false, lastActionTime: 0 });
            }
        } else {
            // Logika untuk join biasa
            room.clients.set(ws, { id: tempUserId, username, isHost: false, lastActionTime: 0 });
        }
    }

    // 3. Kirim pesan konfirmasi setelah semua logika selesai
    ws.send(JSON.stringify({ type: 'joinedRoom', payload: { roomId } }));
    ws.send(JSON.stringify({ type: 'assignIdentity', payload: { userId: room.clients.get(ws).id, role: room.clients.get(ws).isHost ? 'host' : 'viewer' } }));
    ws.send(JSON.stringify({ type: 'chatHistory', payload: room.chatHistory }));
    ws.send(JSON.stringify({ type: 'roomState', payload: getRoomState(roomId) }));

    if (!rejoin) {
        const joinMessage = { system: true, text: `${username} telah bergabung.` };
        addMessageToHistory(roomId, joinMessage);
        broadcast(roomId, { type: 'chatMessage', payload: joinMessage }, ws);
    }
    broadcastUserUpdate(roomId);
    return; // Akhiri di sini
}


            const { roomId } = ws;
            const room = rooms[roomId];

            if (!room) return;

            const clientData = room.clients.get(ws);
            if (!clientData) return;

            if (type !== 'startTyping' && type !== 'stopTyping' && !type.startsWith('webrtc')) {
                const now = Date.now();
                const timeSinceLastAction = now - clientData.lastActionTime;
                const isChat = type === 'chatMessage';
                const limit = isChat ? CHAT_RATE_LIMIT : ACTION_RATE_LIMIT;
                if (timeSinceLastAction < limit) { return; }
                clientData.lastActionTime = now;
            }

            const isHost = room.hostWs === ws;

            switch (type) {
                case 'leaveRoom': {
                    room.clients.delete(ws);

                    let leaveMessage;
                    if (isHost) {
                        const newHostUsername = selectNewHost(room);
                        if (newHostUsername) {
                            leaveMessage = { system: true, text: `${clientData.username} (Host) telah keluar. Host baru adalah ${newHostUsername}.` };
                        } else {
                            leaveMessage = { system: true, text: `${clientData.username} (Host) telah keluar.` };
                        }
                    } else {
                        leaveMessage = { system: true, text: `${clientData.username} telah keluar.` };
                    }

                    if (room.clients.size === 0) {
                        delete rooms[roomId];
                    } else {
                        addMessageToHistory(roomId, leaveMessage);
                        broadcast(roomId, { type: 'chatMessage', payload: leaveMessage });
                        broadcastUserUpdate(roomId);
                    }

                    ws.close(1000, "User left voluntarily");
                    break;
                }
                case 'updatePlaylist': if (!isHost) return; const { action, url: rawUrl, index } = payload; let videoToPlay = null; if (action === 'add' && rawUrl) { const url = sanitize(rawUrl).slice(0, MAX_URL_LENGTH); room.playlist.push({ url, isPlaying: false }); } else if (action === 'remove' && typeof index === 'number' && index >= 0 && index < room.playlist.length) { room.playlist.splice(index, 1); } else if (action === 'play' && typeof index === 'number' && index >= 0 && index < room.playlist.length) { videoToPlay = room.playlist[index]; } if (videoToPlay) { room.playlist.forEach(item => item.isPlaying = false); videoToPlay.isPlaying = true; const youtubeId = getYouTubeID(videoToPlay.url); const driveId = getGoogleDriveID(videoToPlay.url); if (youtubeId) room.videoState = { videoType: 'youtube', videoId: youtubeId }; else if (driveId) room.videoState = { videoType: 'googledrive', videoId: driveId }; else room.videoState = { videoType: 'direct', videoId: videoToPlay.url }; broadcast(roomId, { type: 'loadVideo', payload: room.videoState }); } broadcast(roomId, { type: 'updatePlaylist', payload: room.playlist }); break;
                case 'sync': if (isHost && room.videoState && typeof payload.time === 'number') { room.videoState.time = payload.time; broadcast(roomId, { type, payload }, ws); } break;
                case 'requestSync': if (!isHost && room.videoState) { ws.send(JSON.stringify({ type: 'loadVideo', payload: room.videoState })); ws.send(JSON.stringify({ type: 'systemToast', payload: { message: 'Video disinkronkan dengan host.' } })); } break;
                case 'chatMessage': const text = sanitize(payload.text).slice(0, MAX_CHAT_MESSAGE_LENGTH); if (!text) return; const chatPayload = { userId: clientData.id, username: clientData.username, text, isHost }; addMessageToHistory(roomId, chatPayload); broadcast(roomId, { type: 'chatMessage', payload: chatPayload }); break;
                case 'hostAnnouncement': if (!isHost) return; const superChatText = sanitize(payload.text).slice(0, MAX_SUPERCHAT_TEXT_LENGTH); const gifUrl = sanitize(payload.gifUrl).slice(0, MAX_URL_LENGTH); if (!superChatText && !gifUrl) return; const announcementPayload = { username: clientData.username, text: superChatText, gifUrl }; broadcast(roomId, { type: 'hostAnnouncement', payload: announcementPayload }); break;
                case 'startTyping': room.typingUsers.add(JSON.stringify({userId: clientData.id, username: clientData.username})); broadcast(roomId, { type: 'typingUpdate', payload: { typingUsers: Array.from(room.typingUsers).map(JSON.parse) } }); break;
                case 'stopTyping': room.typingUsers.delete(JSON.stringify({userId: clientData.id, username: clientData.username})); broadcast(roomId, { type: 'typingUpdate', payload: { typingUsers: Array.from(room.typingUsers).map(JSON.parse) } }); break;
                case 'emojiReaction': broadcast(roomId, { type: 'showReaction', payload: { emoji: payload.emoji } }); break;
                case 'delegateHost': if (!isHost) return; const targetWsDelegate = Array.from(room.clients.keys()).find(client => room.clients.get(client).id === payload.targetUserId); if (targetWsDelegate) { clientData.isHost = false; ws.send(JSON.stringify({ type: 'roleAssign', payload: { role: 'viewer', users: Array.from(room.clients.values()) } })); const newHostData = room.clients.get(targetWsDelegate); newHostData.isHost = true; room.hostWs = targetWsDelegate; targetWsDelegate.send(JSON.stringify({ type: 'roleAssign', payload: { role: 'host', users: Array.from(room.clients.values()) } })); const delegateMessage = { system: true, text: `${clientData.username} menjadikan ${newHostData.username} sebagai host baru.` }; addMessageToHistory(roomId, delegateMessage); broadcast(roomId, { type: 'chatMessage', payload: delegateMessage }); broadcastUserUpdate(roomId); } break;
                case 'createPoll': if (!isHost || room.activePoll) return; const question = sanitize(payload.question).slice(0, MAX_POLL_QUESTION_LENGTH); const options = payload.options.filter(opt => typeof opt === 'string' && opt.trim()).map(opt => sanitize(opt).slice(0, MAX_POLL_OPTION_LENGTH)).slice(0, 5); if (!question || options.length < 2) return; room.activePoll = { question, options: options.map(opt => ({ text: opt, votes: 0 })), voters: {} }; broadcast(roomId, { type: 'pollUpdate', payload: room.activePoll }); break;
                case 'vote': if (room.activePoll && !room.activePoll.voters[clientData.id] && typeof payload.optionIndex === 'number' && payload.optionIndex < room.activePoll.options.length) { room.activePoll.options[payload.optionIndex].votes++; room.activePoll.voters[clientData.id] = true; broadcast(roomId, { type: 'pollUpdate', payload: room.activePoll }); } break;
                case 'endPoll': if (isHost) { room.activePoll = null; broadcast(roomId, { type: 'pollUpdate', payload: null }); } break;
                case 'kickUser':
                    if (!isHost) return;
                    const userToKickId = payload.targetUserId;
                    if (userToKickId === clientData.id) return;

                    let wsToKick = null;
                    let kickedUserUsername = '';
                    for (const [clientWs, clientData] of room.clients.entries()) {
                        if (clientData.id === userToKickId) {
                            wsToKick = clientWs;
                            kickedUserUsername = clientData.username;
                            break;
                        }
                    }

                    if (wsToKick) {
                        wsToKick.send(JSON.stringify({
                            type: 'kicked',
                            payload: { message: 'Anda telah dikeluarkan dari room oleh Host.' }
                        }));
                        
                        room.clients.delete(wsToKick);
                        
                        const kickMessage = { system: true, text: `${kickedUserUsername} telah dikeluarkan oleh Host.` };
                        addMessageToHistory(roomId, kickMessage);
                        broadcast(roomId, { type: 'chatMessage', payload: kickMessage });

                        broadcastUserUpdate(roomId);
                        
                        setTimeout(() => {
                            if (wsToKick.readyState === WebSocket.OPEN) {
                                wsToKick.close(1000, 'Kicked by host');
                            }
                        }, 500);
                    }
                    break;

                // ⭐⭐⭐ PERBAIKAN UTAMA ADA DI SINI ⭐⭐⭐
                case 'webrtc-offer':
case 'webrtc-answer':
case 'webrtc-candidate': {
    if (!payload.targetUserId) {
        console.warn(`[WebRTC] Pesan ${type} tanpa targetUserId dari ${clientData.username}`);
        return; // Hentikan jika target tidak jelas
    }
    const targetWs = Array.from(room.clients.keys()).find(client => room.clients.get(client).id === payload.targetUserId);
    if (targetWs) {
        // Log untuk debugging, sangat membantu!
        console.log(`[WebRTC] Meneruskan '${type}' dari ${clientData.id} ke ${payload.targetUserId}`);
        targetWs.send(JSON.stringify({ type: type, payload: { ...payload, fromUserId: clientData.id } }));
    } else {
        console.warn(`[WebRTC] Target user ${payload.targetUserId} untuk '${type}' tidak ditemukan di room ${roomId}.`);
    }
    break;
}
            }
        } catch (error) { console.error('Error processing message:', error); }
    });

    ws.on('close', () => {
        const { roomId } = ws;
        if (!roomId || !rooms[roomId]) return;
        const room = rooms[roomId];
        const clientData = room.clients.get(ws);
        
        if (!clientData) return;
        
        broadcast(roomId, { type: 'user-left-for-webrtc', payload: { userId: clientData.id } }, ws);
        
        const userTypingJSON = JSON.stringify({ userId: clientData.id, username: clientData.username });
        if (room.typingUsers.has(userTypingJSON)) {
            room.typingUsers.delete(userTypingJSON);
            broadcast(roomId, { type: 'typingUpdate', payload: { typingUsers: Array.from(room.typingUsers).map(JSON.parse) } });
        }
        
        const timeoutId = setTimeout(() => {
            room.disconnectTimeouts.delete(clientData.id);
            let stillConnected = false;
            for(const data of room.clients.values()){ if(data.id === clientData.id) { stillConnected = true; break; } }
            if(stillConnected) return;

            room.clients.delete(ws);
            if (room.clients.size === 0) {
                delete rooms[roomId];
            } else {
                let leaveMessage;
                if (room.hostWs === ws) {
                    const newHostUsername = selectNewHost(room);
                    leaveMessage = { system: true, text: `${clientData.username} (Host) telah keluar. Host baru adalah ${newHostUsername}.` };
                } else {
                    leaveMessage = { system: true, text: `${clientData.username} telah keluar.` };
                }
                addMessageToHistory(roomId, leaveMessage);
                broadcast(roomId, { type: 'chatMessage', payload: leaveMessage });
                broadcastUserUpdate(roomId);
            }
        }, RECONNECT_GRACE_PERIOD);
        room.disconnectTimeouts.set(clientData.id, timeoutId);
    });
});

server.listen(PORT, () => {
    console.log(`[Server v19.4 Bugfix 6] Berjalan di http://localhost:${PORT}`);
});
