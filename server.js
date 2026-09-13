const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const os = require('os');
const fs = require('fs');
const multer = require('multer');
const cors = require('cors');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  },
  maxHttpBufferSize: 1e8 // 100 MB max message/file payload
});

const PORT = process.env.PORT || 3000;
const UPLOADS_DIR = path.join(__dirname, 'uploads');
const serverStartTime = Date.now();

if (!fs.existsSync(UPLOADS_DIR)) {
  fs.mkdirSync(UPLOADS_DIR, { recursive: true });
}

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(UPLOADS_DIR));

// Setup Multer for all file uploads
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, UPLOADS_DIR);
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1e9);
    const ext = path.extname(file.originalname);
    cb(null, uniqueSuffix + ext);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 100 * 1024 * 1024 } // 100 MB file size limit
});

function isLocalhostRequest(req) {
  const ip = req.ip || req.connection.remoteAddress || '';
  const host = req.headers.host || '';
  if (ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1' || ip.includes('127.0.0.1')) {
    return true;
  }
  if (host.startsWith('localhost') || host.startsWith('127.0.0.1')) {
    return true;
  }
  return false;
}

function isLocalhostSocket(socket) {
  const req = socket.request;
  const ip = req.connection.remoteAddress || '';
  const host = req.headers.host || '';
  if (ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1' || ip.includes('127.0.0.1')) {
    return true;
  }
  if (host.startsWith('localhost') || host.startsWith('127.0.0.1')) {
    return true;
  }
  return false;
}

// REST Admin Endpoints for Localhost
app.get('/api/admin/state', (req, res) => {
  if (!isLocalhostRequest(req)) {
    return res.status(403).json({ error: 'Admin actions allowed only on localhost' });
  }

  const groupsObj = {};
  activeGroups.forEach((val, key) => groupsObj[key] = val);

  const messagesObj = {};
  roomMessages.forEach((val, key) => messagesObj[key] = val);

  const activeSockets = [];
  usersBySocket.forEach((u, sid) => {
    activeSockets.push({
      socketId: sid,
      lanId: u.lanId,
      username: u.username,
      online: u.online !== false
    });
  });

  res.json({
    users: accountsDb,
    groups: groupsObj,
    messages: messagesObj,
    bannedLanIds: Array.from(bannedLanIds),
    bannedIps: Array.from(bannedIps),
    auditLogs,
    activeSockets,
    health: {
      activeConnections: usersBySocket.size,
      registeredUsers: Object.keys(accountsDb).length,
      totalGroups: activeGroups.size,
      totalRoomsWithMessages: roomMessages.size,
      serverUptimeSeconds: Math.floor((Date.now() - serverStartTime) / 1000)
    }
  });
});

app.post('/api/admin/broadcast', (req, res) => {
  if (!isLocalhostRequest(req)) {
    return res.status(403).json({ error: 'Admin actions allowed only on localhost' });
  }

  const messageText = String(req.body.message || '').trim();
  if (!messageText) {
    return res.status(400).json({ error: 'Broadcast message cannot be empty' });
  }

  const sysMsg = {
    id: `sys_announcement_${Date.now()}`,
    roomId: 'general',
    sender: { lanId: 'ADMIN', username: '📢 SERVER ANNOUNCEMENT', color: '#ef4444' },
    content: messageText,
    timestamp: new Date().toISOString(),
    isSystem: true
  };

  saveMessage('general', sysMsg);
  io.to('general').emit('new_message', sysMsg);
  logAudit('broadcast', 'GLOBAL', messageText);

  res.json({ success: true, message: 'Announcement broadcasted to all users.' });
});

app.post('/api/admin/ban', (req, res) => {
  if (!isLocalhostRequest(req)) {
    return res.status(403).json({ error: 'Admin actions allowed only on localhost' });
  }

  const lanId = String(req.body.lanId || '').trim().toUpperCase();
  const ipAddr = String(req.body.ip || '').trim();

  if (lanId) {
    bannedLanIds.add(lanId);
    usersBySocket.forEach((u, sid) => {
      if (u.lanId === lanId) {
        io.to(sid).emit('user_banned', { reason: `LAN ID ${lanId} has been banned by Localhost Admin.` });
      }
    });
  }

  if (ipAddr) {
    bannedIps.add(ipAddr);
  }

  saveUsers();
  io.emit('users_list', Array.from(usersByLanId.values()));
  res.json({ success: true, message: `Banned LAN ID: ${lanId}, IP: ${ipAddr}` });
});

app.post('/api/admin/unban', (req, res) => {
  if (!isLocalhostRequest(req)) {
    return res.status(403).json({ error: 'Admin actions allowed only on localhost' });
  }

  const lanId = String(req.body.lanId || '').trim().toUpperCase();
  const ipAddr = String(req.body.ip || '').trim();

  if (lanId) bannedLanIds.delete(lanId);
  if (ipAddr) bannedIps.delete(ipAddr);

  saveUsers();
  res.json({ success: true, message: `Unbanned LAN ID: ${lanId}, IP: ${ipAddr}` });
});

app.post('/api/admin/edit-user', (req, res) => {
  if (!isLocalhostRequest(req)) {
    return res.status(403).json({ error: 'Admin actions allowed only on localhost' });
  }

  const targetLanId = String(req.body.targetLanId || '').trim().toUpperCase();
  if (!targetLanId) {
    return res.status(400).json({ error: 'Target LAN ID is required' });
  }

  const { account, error } = updateAccountProfile(targetLanId, {
    newUsername: req.body.username,
    newLanId: req.body.lanId,
    newPassword: req.body.password,
    newColor: req.body.color
  });

  if (error) {
    return res.status(400).json({ error });
  }

  res.json({ success: true, account });
});

app.post('/api/admin/delete-user', (req, res) => {
  if (!isLocalhostRequest(req)) {
    return res.status(403).json({ error: 'Admin actions allowed only on localhost' });
  }

  const targetLanId = String(req.body.targetLanId || '').trim().toUpperCase();

  let accountKey = null;
  for (const [k, acc] of Object.entries(accountsDb)) {
    if (acc.lanId === targetLanId) {
      accountKey = k;
      break;
    }
  }

  if (accountKey) delete accountsDb[accountKey];
  if (usersByLanId.has(targetLanId)) usersByLanId.delete(targetLanId);

  usersBySocket.forEach((u, sid) => {
    if (u.lanId === targetLanId) {
      io.to(sid).emit('user_banned', { reason: 'Your account was deleted by Localhost Admin.' });
      usersBySocket.delete(sid);
    }
  });

  saveUsers();
  io.emit('users_list', Array.from(usersByLanId.values()));
  res.json({ success: true, message: `Account ${targetLanId} deleted.` });
});

app.post('/api/admin/delete-message', (req, res) => {
  if (!isLocalhostRequest(req)) {
    return res.status(403).json({ error: 'Admin actions allowed only on localhost' });
  }

  const { roomId, messageId } = req.body || {};
  if (!roomId || !messageId) {
    return res.status(400).json({ error: 'Room ID and Message ID required' });
  }

  const history = getMessageHistory(roomId);
  const msgIdx = history.findIndex(m => m.id === messageId);
  if (msgIdx !== -1) {
    history.splice(msgIdx, 1);
    saveUsers();
    io.to(roomId).emit('message_deleted', { roomId, messageId });
    return res.json({ success: true });
  }

  res.status(404).json({ error: 'Message not found' });
});

app.post('/api/admin/reset', (req, res) => {
  if (!isLocalhostRequest(req)) {
    return res.status(403).json({ error: 'Admin actions allowed only on localhost' });
  }

  accountsDb = {};
  bannedLanIds.clear();
  bannedIps.clear();
  lanIdCounter = 1;
  roomMessages.clear();
  activeGroups.clear();
  usersBySocket.clear();
  usersByLanId.clear();

  saveUsers();
  io.emit('server_reset', {});
  io.emit('users_list', []);

  res.json({ success: true, message: 'All accounts, chats, and groups have been reset.' });
});

app.get('/api/admin/export', (req, res) => {
  if (!isLocalhostRequest(req)) {
    return res.status(403).json({ error: 'Admin actions allowed only on localhost' });
  }

  const groupsObj = {};
  activeGroups.forEach((val, key) => groupsObj[key] = val);

  const messagesObj = {};
  roomMessages.forEach((val, key) => messagesObj[key] = val);

  const data = {
    lanIdCounter,
    users: accountsDb,
    groups: groupsObj,
    messages: messagesObj,
    bannedLanIds: Array.from(bannedLanIds),
    bannedIps: Array.from(bannedIps)
  };

  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Content-Disposition', 'attachment; filename=lan_chat_backup.json');
  res.send(JSON.stringify(data, null, 2));
});

app.post('/api/admin/import', upload.single('file'), (req, res) => {
  if (!isLocalhostRequest(req)) {
    return res.status(403).json({ error: 'Admin actions allowed only on localhost' });
  }

  let data = null;
  if (req.file) {
    try {
      const fileStr = fs.readFileSync(req.file.path, 'utf8');
      data = JSON.parse(fileStr);
    } catch (err) {
      return res.status(400).json({ error: `Invalid JSON file: ${err.message}` });
    }
  } else if (req.body) {
    data = req.body;
  }

  if (!data || typeof data !== 'object') {
    return res.status(400).json({ error: 'Invalid backup data payload' });
  }

  accountsDb = data.users || {};
  lanIdCounter = data.lanIdCounter || 1;
  bannedLanIds = new Set(data.bannedLanIds || []);
  bannedIps = new Set(data.bannedIps || []);

  activeGroups.clear();
  if (data.groups) {
    if (Array.isArray(data.groups)) {
      data.groups.forEach(g => activeGroups.set(g.id, g));
    } else {
      Object.entries(data.groups).forEach(([id, g]) => activeGroups.set(id, g));
    }
  }

  roomMessages.clear();
  if (data.messages) {
    Object.entries(data.messages).forEach(([id, msgs]) => roomMessages.set(id, msgs));
  }

  saveUsers();

  io.emit('data_imported', {});
  io.emit('users_list', Array.from(usersByLanId.values()));

  res.json({ success: true, message: 'Data imported successfully.' });
});

// Helper to get local network IP addresses
function getLanIps() {
  const interfaces = os.networkInterfaces();
  const ips = [];
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) {
        ips.push(iface.address);
      }
    }
  }
  return ips;
}

// REST Endpoints
app.get('/api/lan-info', (req, res) => {
  const ips = getLanIps();
  res.json({
    port: PORT,
    ips: ips.length > 0 ? ips : ['127.0.0.1'],
    primaryIp: ips[0] || '127.0.0.1'
  });
});

app.post('/api/upload', upload.single('file'), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No file uploaded' });
  }

  const mime = req.file.mimetype || '';
  const isImage = mime.startsWith('image/');
  const isVideo = mime.startsWith('video/');
  const isAudio = mime.startsWith('audio/');

  const fileInfo = {
    originalName: req.file.originalname,
    filename: req.file.filename,
    size: req.file.size,
    mimeType: req.file.mimetype,
    url: `/uploads/${req.file.filename}`,
    downloadUrl: `/download/${req.file.filename}`,
    isImage,
    isVideo,
    isAudio
  };

  res.json({ success: true, file: fileInfo });
});

// Download endpoint with attachment header for force download
app.get('/download/:filename', (req, res) => {
  const filename = req.params.filename;
  const filePath = path.join(UPLOADS_DIR, filename);

  if (!fs.existsSync(filePath)) {
    return res.status(404).send('File not found');
  }

  const originalName = req.query.name || filename;
  res.download(filePath, originalName);
});

const crypto = require('crypto');
const USERS_FILE = path.join(__dirname, 'users.json');

let accountsDb = {}; // username_lower -> account
let bannedLanIds = new Set();
let bannedIps = new Set();
let auditLogs = [];
let lanIdCounter = 1;

function logAudit(action, target, details = '') {
  const entry = {
    id: 'audit_' + Date.now(),
    timestamp: new Date().toISOString(),
    action,
    target,
    details
  };
  auditLogs.push(entry);
  if (auditLogs.length > 200) auditLogs.shift();
  saveUsers();
}

function hashPassword(password) {
  return crypto.createHash('sha256').update(`lan_chat_salt_2026:${password}`).digest('hex');
}

function loadUsers() {
  if (fs.existsSync(USERS_FILE)) {
    try {
      const data = JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'));
      accountsDb = data.users || {};
      lanIdCounter = data.lanIdCounter || 1;
      bannedLanIds = new Set(data.bannedLanIds || []);
      bannedIps = new Set(data.bannedIps || []);
      auditLogs = data.auditLogs || [];

      activeGroups.clear();
      if (data.groups) {
        if (Array.isArray(data.groups)) {
          data.groups.forEach(g => activeGroups.set(g.id, g));
        } else {
          Object.entries(data.groups).forEach(([id, g]) => activeGroups.set(id, g));
        }
      }

      roomMessages.clear();
      if (data.messages) {
        Object.entries(data.messages).forEach(([id, msgs]) => roomMessages.set(id, msgs));
      }
    } catch (err) {
      console.error('Error reading users file:', err);
    }
  }
}

function saveUsers() {
  try {
    const groupsObj = {};
    activeGroups.forEach((val, key) => groupsObj[key] = val);

    const messagesObj = {};
    roomMessages.forEach((val, key) => messagesObj[key] = val);

    fs.writeFileSync(USERS_FILE, JSON.stringify({
      lanIdCounter,
      users: accountsDb,
      groups: groupsObj,
      messages: messagesObj,
      bannedLanIds: Array.from(bannedLanIds),
      bannedIps: Array.from(bannedIps),
      auditLogs
    }, null, 2));
  } catch (err) {
    console.error('Error saving users file:', err);
  }
}

loadUsers();

// Live user state management
const usersBySocket = new Map(); // socketId -> User object
const usersByLanId = new Map();  // lanId -> User object
const roomMessages = new Map();   // roomId -> Array of messages
const activeGroups = new Map();   // groupId -> { id, name, members: Array<lanId>, createdAt }

const avatarColors = ['#3b82f6', '#10b981', '#8b5cf6', '#ec4899', '#f59e0b', '#06b6d4', '#6366f1', '#14b8a6'];

function formatLanId(num) {
  return `LAN${String(num).padStart(4, '0')}`;
}

function registerAccount(username, password, requestedLanId) {
  const usernameClean = (username || '').trim().substring(0, 24);
  const key = usernameClean.toLowerCase();

  if (!usernameClean) return { error: 'Username cannot be empty.' };
  if (!password) return { error: 'Password cannot be empty.' };
  if (accountsDb[key]) return { error: 'Username already exists. Please login.' };

  let lanId = requestedLanId ? requestedLanId.trim().toUpperCase() : null;
  const existingLanIds = new Set(Object.values(accountsDb).map(a => a.lanId));

  if (!lanId || !/^LAN\d{4}$/.test(lanId) || existingLanIds.has(lanId)) {
    while (existingLanIds.has(formatLanId(lanIdCounter))) {
      lanIdCounter++;
    }
    lanId = formatLanId(lanIdCounter++);
  }

  const colorIndex = parseInt(lanId.replace('LAN', ''), 10) % avatarColors.length;

  const account = {
    username: usernameClean,
    passwordHash: hashPassword(password),
    lanId,
    color: avatarColors[colorIndex],
    createdAt: new Date().toISOString()
  };

  accountsDb[key] = account;
  saveUsers();

  return { account };
}

function authenticateAccount(username, password) {
  if (!username || !password) return { error: 'Username and password required.' };
  const key = username.trim().toLowerCase();
  const account = accountsDb[key];
  if (!account) return { error: 'Account not found. Please register.' };
  if (account.passwordHash !== hashPassword(password)) return { error: 'Incorrect password.' };
  return { account };
}

function bindUserSession(socketId, account) {
  const user = {
    socketId,
    lanId: account.lanId,
    username: account.username,
    color: account.color,
    online: true,
    joinedAt: new Date().toISOString()
  };

  usersBySocket.set(socketId, user);
  usersByLanId.set(account.lanId, user);

  return user;
}

function getDmRoomId(lanId1, lanId2) {
  const sorted = [lanId1, lanId2].sort();
  return `dm:${sorted[0]}_${sorted[1]}`;
}

function getMessageHistory(roomId) {
  if (!roomMessages.has(roomId)) {
    roomMessages.set(roomId, []);
  }
  return roomMessages.get(roomId);
}

function saveMessage(roomId, msg) {
  const history = getMessageHistory(roomId);
  history.push(msg);
  if (history.length > 500) {
    history.shift(); // Keep last 500 messages per room
  }
  saveUsers();
}

// Socket.io Connection Logic
io.on('connection', (socket) => {
  console.log(`Socket connected: ${socket.id}`);

  // Register account event
  socket.on('user_register', (data = {}, callback) => {
    const { username, password, lanId } = data;
    const { account, error } = registerAccount(username, password, lanId);
    if (error) {
      if (typeof callback === 'function') callback({ success: false, error });
      return;
    }

    const user = bindUserSession(socket.id, account);
    socket.join('general');

    if (typeof callback === 'function') {
      callback({
        success: true,
        user,
        groups: Array.from(activeGroups.values()).filter(g => g.members.includes(user.lanId))
      });
    }

    io.emit('users_list', Array.from(usersByLanId.values()));

    const sysMsg = {
      id: 'sys_' + Date.now() + '_' + Math.random().toString(36).substr(2, 5),
      roomId: 'general',
      sender: { lanId: 'SYSTEM', username: 'System', color: '#64748b' },
      content: `${user.username} (${user.lanId}) registered & connected to LAN Chat.`,
      timestamp: new Date().toISOString(),
      isSystem: true
    };
    saveMessage('general', sysMsg);
    io.to('general').emit('new_message', sysMsg);
  });

  // Login account event
  socket.on('user_login', (data = {}, callback) => {
    const { username, password } = data;
    const { account, error } = authenticateAccount(username, password);
    if (error) {
      if (typeof callback === 'function') callback({ success: false, error });
      return;
    }

    const user = bindUserSession(socket.id, account);
    socket.join('general');

    if (typeof callback === 'function') {
      callback({
        success: true,
        user,
        groups: Array.from(activeGroups.values()).filter(g => g.members.includes(user.lanId))
      });
    }

    io.emit('users_list', Array.from(usersByLanId.values()));

    const sysMsg = {
      id: 'sys_' + Date.now() + '_' + Math.random().toString(36).substr(2, 5),
      roomId: 'general',
      sender: { lanId: 'SYSTEM', username: 'System', color: '#64748b' },
      content: `${user.username} (${user.lanId}) logged in to LAN Chat.`,
      timestamp: new Date().toISOString(),
      isSystem: true
    };
    saveMessage('general', sysMsg);
    io.to('general').emit('new_message', sysMsg);
  });

  // Legacy user_join event compatibility
  socket.on('user_join', (data = {}, callback) => {
    const { username, password, lanId } = data;
    let authRes = authenticateAccount(username, password);
    let account = authRes.account;

    if (!account && password) {
      let regRes = registerAccount(username, password, lanId);
      account = regRes.account;
    }

    if (!account) {
      const key = (username || '').trim().toLowerCase();
      if (key && accountsDb[key]) {
        account = accountsDb[key];
      } else {
        let fallbackRes = registerAccount(username || `User_${socket.id.substring(0, 4)}`, password || 'guest_pass', lanId);
        account = fallbackRes.account;
      }
    }

    const user = bindUserSession(socket.id, account);
    socket.join('general');

    if (typeof callback === 'function') {
      callback({
        success: true,
        user,
        groups: Array.from(activeGroups.values()).filter(g => g.members.includes(user.lanId))
      });
    }

    io.emit('users_list', Array.from(usersByLanId.values()));

    const sysMsg = {
      id: 'sys_' + Date.now() + '_' + Math.random().toString(36).substr(2, 5),
      roomId: 'general',
      sender: { lanId: 'SYSTEM', username: 'System', color: '#64748b' },
      content: `${user.username} (${user.lanId}) connected to LAN Chat.`,
      timestamp: new Date().toISOString(),
      isSystem: true
    };
    saveMessage('general', sysMsg);
    io.to('general').emit('new_message', sysMsg);
  });

function updateAccountProfile(targetLanId, { newUsername, newLanId, newPassword, newColor }) {
  let accountKey = null;
  let account = null;

  for (const [k, acc] of Object.entries(accountsDb)) {
    if (acc.lanId === targetLanId) {
      accountKey = k;
      account = acc;
      break;
    }
  }

  if (!account) return { error: 'Account not found' };

  const oldUsername = account.username;
  const oldLanId = account.lanId;

  if (newUsername !== undefined && newUsername !== null) {
    const cleanName = String(newUsername).trim().substring(0, 24);
    if (!cleanName) return { error: 'Username cannot be empty' };
    const newKey = cleanName.toLowerCase();
    if (newKey !== accountKey && accountsDb[newKey]) {
      return { error: 'Username already in use by another account' };
    }
    if (newKey !== accountKey) {
      delete accountsDb[accountKey];
      accountsDb[newKey] = account;
      accountKey = newKey;
    }
    account.username = cleanName;
  }

  if (newLanId !== undefined && newLanId !== null) {
    const cleanLanId = String(newLanId).trim().toUpperCase();
    if (!/^LAN\d{4}$/.test(cleanLanId)) {
      return { error: 'LAN ID must follow format LANXXXX (e.g. LAN0001)' };
    }

    const existingOwner = Object.values(accountsDb).find(acc => acc.lanId === cleanLanId && acc !== account);
    if (existingOwner) {
      return { error: `LAN ID ${cleanLanId} is already assigned to another account` };
    }

    if (cleanLanId !== oldLanId) {
      account.lanId = cleanLanId;

      activeGroups.forEach(grp => {
        if (grp.createdBy === oldLanId) grp.createdBy = cleanLanId;
        if (grp.admins && grp.admins.includes(oldLanId)) {
          grp.admins = grp.admins.map(x => x === oldLanId ? cleanLanId : x);
        }
        if (grp.members && grp.members.includes(oldLanId)) {
          grp.members = grp.members.map(x => x === oldLanId ? cleanLanId : x);
        }
      });

      if (usersByLanId.has(oldLanId)) {
        const uObj = usersByLanId.get(oldLanId);
        usersByLanId.delete(oldLanId);
        uObj.lanId = cleanLanId;
        usersByLanId.set(cleanLanId, uObj);
      }
    }
  }

  if (newPassword) {
    if (newPassword.length < 3) return { error: 'Password too short' };
    account.passwordHash = hashPassword(newPassword);
  }

  if (newColor) {
    account.color = newColor;
  }

  const currentLanId = account.lanId;
  if (usersByLanId.has(currentLanId)) {
    const uObj = usersByLanId.get(currentLanId);
    uObj.username = account.username;
    uObj.color = account.color;
  }

  usersBySocket.forEach(u => {
    if (u.lanId === oldLanId || u.lanId === currentLanId) {
      u.lanId = currentLanId;
      u.username = account.username;
      u.color = account.color;
    }
  });

  saveUsers();

  io.emit('users_list', Array.from(usersByLanId.values()));
  io.emit('profile_updated', {
    oldLanId,
    account: {
      username: account.username,
      lanId: account.lanId,
      color: account.color
    }
  });

  return { account };
}

  // Custom Status
  socket.on('set_custom_status', (data = {}, callback) => {
    const user = usersBySocket.get(socket.id);
    if (!user) return;

    const statusText = String(data.status || '').trim().substring(0, 40);
    user.customStatus = statusText;
    if (usersByLanId.has(user.lanId)) {
      usersByLanId.get(user.lanId).customStatus = statusText;
    }

    for (const acc of Object.values(accountsDb)) {
      if (acc.lanId === user.lanId) {
        acc.customStatus = statusText;
        break;
      }
    }

    saveUsers();
    io.emit('users_list', Array.from(usersByLanId.values()));
    if (typeof callback === 'function') callback({ success: true, customStatus: statusText });
  });

  // Join Group By Code
  socket.on('join_group_by_code', (data = {}, callback) => {
    const user = usersBySocket.get(socket.id);
    if (!user) return;

    const code = String(data.code || '').trim().toUpperCase();
    const grp = Array.from(activeGroups.values()).find(g => g.joinCode === code);

    if (!grp) {
      if (typeof callback === 'function') callback({ success: false, error: 'Invalid group invite code.' });
      return;
    }

    if (!grp.members.includes(user.lanId)) {
      grp.members.push(user.lanId);
      saveUsers();
    }

    socket.join(grp.id);
    socket.emit('group_added', grp);
    io.to(grp.id).emit('group_updated', grp);

    if (typeof callback === 'function') callback({ success: true, group: grp });
  });

  // Profile Update
  socket.on('update_profile', (data = {}, callback) => {
    const user = usersBySocket.get(socket.id);
    if (!user) return;

    const { account, error } = updateAccountProfile(user.lanId, {
      newUsername: data.username,
      newLanId: data.lanId,
      newPassword: data.password,
      newColor: data.color
    });

    if (error) {
      if (typeof callback === 'function') callback({ success: false, error });
      return;
    }

    const updatedUser = usersBySocket.get(socket.id);
    if (typeof callback === 'function') callback({ success: true, user: updatedUser });
  });

  // Load Room History
  socket.on('get_history', (roomId, callback) => {
    if (isLocalhostSocket(socket) && roomId.startsWith('group_')) {
      socket.join(roomId);
    }
    const history = getMessageHistory(roomId);
    if (typeof callback === 'function') {
      callback(history);
    }
  });

  // Create or Join Group
  socket.on('create_group', (data = {}, callback) => {
    const currentUser = usersBySocket.get(socket.id);
    if (!currentUser) return;

    let parsedIds = [];
    const rawInput = data.lanIdsInput || [];
    if (Array.isArray(rawInput)) {
      parsedIds = rawInput.map(s => String(s).trim().toUpperCase()).filter(s => /^LAN\d{4}$/.test(s));
    } else {
      parsedIds = String(rawInput).split(',').map(s => s.trim().toUpperCase()).filter(s => /^LAN\d{4}$/.test(s));
    }

    if (!parsedIds.includes(currentUser.lanId)) {
      parsedIds.push(currentUser.lanId);
    }

    const uniqueMembers = Array.from(new Set(parsedIds)).sort();

    if (uniqueMembers.length < 2) {
      if (typeof callback === 'function') {
        callback({ success: false, error: 'Please select at least one other valid LAN ID.' });
      }
      return;
    }

    const groupId = `group_${Date.now()}_${Math.random().toString(36).substr(2, 4)}`;
    const groupName = (data.groupName || '').trim() || `Group (${uniqueMembers.length} members)`;

    const groupObj = {
      id: groupId,
      name: groupName,
      members: uniqueMembers,
      createdBy: currentUser.lanId,
      admins: [currentUser.lanId],
      disallowedFileTypes: data.disallowedFileTypes || [],
      createdAt: new Date().toISOString()
    };

    activeGroups.set(groupId, groupObj);
    saveUsers();

    uniqueMembers.forEach(lanId => {
      const memberUser = usersByLanId.get(lanId);
      if (memberUser && memberUser.socketId) {
        const memberSocket = io.sockets.sockets.get(memberUser.socketId);
        if (memberSocket) {
          memberSocket.join(groupId);
          memberSocket.emit('group_added', groupObj);
        }
      }
    });

    if (typeof callback === 'function') {
      callback({ success: true, group: groupObj });
    }
  });

  // Group Management
  socket.on('manage_group', (data = {}, callback) => {
    const user = usersBySocket.get(socket.id);
    if (!user) return;

    const { groupId, action } = data;
    const group = activeGroups.get(groupId);

    if (!group) {
      if (typeof callback === 'function') callback({ success: false, error: 'Group not found' });
      return;
    }

    const isOwner = (group.createdBy === user.lanId);
    const isAdmin = isOwner || (group.admins && group.admins.includes(user.lanId));

    if (!isAdmin) {
      if (typeof callback === 'function') callback({ success: false, error: 'Permission denied: Group Admin or Owner required.' });
      return;
    }

    if (action === 'rename') {
      const newName = String(data.name || '').trim().substring(0, 40);
      if (!newName) {
        if (typeof callback === 'function') callback({ success: false, error: 'Group name cannot be empty' });
        return;
      }
      group.name = newName;

    } else if (action === 'add_members') {
      let newIds = data.lanIds || [];
      if (typeof newIds === 'string') {
        newIds = newIds.split(',').map(s => s.trim().toUpperCase()).filter(s => /^LAN\d{4}$/.test(s));
      }

      newIds.forEach(lid => {
        const lidClean = String(lid).trim().toUpperCase();
        if (/^LAN\d{4}$/.test(lidClean) && !group.members.includes(lidClean)) {
          group.members.push(lidClean);
          const targetUser = usersByLanId.get(lidClean);
          if (targetUser && targetUser.socketId) {
            const targetSocket = io.sockets.sockets.get(targetUser.socketId);
            if (targetSocket) {
              targetSocket.join(groupId);
              targetSocket.emit('group_added', group);
            }
          }
        }
      });

    } else if (action === 'remove_member') {
      const targetLanId = String(data.targetLanId || '').trim().toUpperCase();
      if (targetLanId === group.createdBy && !isOwner) {
        if (typeof callback === 'function') callback({ success: false, error: 'Cannot remove group owner' });
        return;
      }

      if (group.members.includes(targetLanId)) {
        group.members = group.members.filter(m => m !== targetLanId);
        if (group.admins) group.admins = group.admins.filter(a => a !== targetLanId);

        const targetUser = usersByLanId.get(targetLanId);
        if (targetUser && targetUser.socketId) {
          const targetSocket = io.sockets.sockets.get(targetUser.socketId);
          if (targetSocket) {
            targetSocket.leave(groupId);
            targetSocket.emit('group_removed', { groupId });
          }
        }
      }

    } else if (action === 'grant_admin') {
      if (!isOwner) {
        if (typeof callback === 'function') callback({ success: false, error: 'Only Group Owner can grant Admin powers' });
        return;
      }
      const targetLanId = String(data.targetLanId || '').trim().toUpperCase();
      if (!group.admins) group.admins = [group.createdBy];
      if (group.members.includes(targetLanId) && !group.admins.includes(targetLanId)) {
        group.admins.push(targetLanId);
      }

    } else if (action === 'revoke_admin') {
      if (!isOwner) {
        if (typeof callback === 'function') callback({ success: false, error: 'Only Group Owner can revoke Admin powers' });
        return;
      }
      const targetLanId = String(data.targetLanId || '').trim().toUpperCase();
      if (targetLanId === group.createdBy) {
        if (typeof callback === 'function') callback({ success: false, error: 'Cannot revoke Owner admin rights' });
        return;
      }
      if (group.admins) group.admins = group.admins.filter(a => a !== targetLanId);

    } else if (action === 'transfer_ownership') {
      if (!isOwner) {
        if (typeof callback === 'function') callback({ success: false, error: 'Only Group Owner can transfer ownership' });
        return;
      }
      const targetLanId = String(data.targetLanId || '').trim().toUpperCase();
      if (group.members.includes(targetLanId)) {
        group.createdBy = targetLanId;
        if (!group.admins) group.admins = [];
        if (!group.admins.includes(targetLanId)) group.admins.push(targetLanId);
      }

    } else if (action === 'update_restrictions') {
      let disallowed = data.disallowedFileTypes || [];
      if (typeof disallowed === 'string') {
        disallowed = disallowed.split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
      }
      group.disallowedFileTypes = disallowed.map(s => String(s).trim().toLowerCase()).filter(Boolean);

    } else if (action === 'delete_group') {
      if (!isOwner) {
        if (typeof callback === 'function') callback({ success: false, error: 'Only Group Owner can delete the group' });
        return;
      }
      activeGroups.delete(groupId);
      saveUsers();
      io.to(groupId).emit('group_deleted', { groupId });
      if (typeof callback === 'function') callback({ success: true });
      return;
    }

    saveUsers();
    io.to(groupId).emit('group_updated', group);
    if (typeof callback === 'function') callback({ success: true, group });
  });

  // Edit Message
  socket.on('edit_message', (data = {}, callback) => {
    const user = usersBySocket.get(socket.id);
    const isAdmin = isLocalhostSocket(socket);

    if (!user && !isAdmin) return;

    const { roomId, messageId, content } = data;
    if (!roomId || !messageId || !content) {
      if (typeof callback === 'function') callback({ success: false, error: 'Room ID, Message ID, and new content required' });
      return;
    }

    const history = getMessageHistory(roomId);
    const msg = history.find(m => m.id === messageId);
    if (!msg) {
      if (typeof callback === 'function') callback({ success: false, error: 'Message not found' });
      return;
    }

    const isSender = (user && msg.sender && msg.sender.lanId === user.lanId);
    if (!isSender && !isAdmin) {
      if (typeof callback === 'function') callback({ success: false, error: 'Permission denied: Cannot edit another user\'s message' });
      return;
    }

    msg.content = String(content).trim();
    msg.isEdited = true;
    saveUsers();

    io.to(roomId).emit('message_edited', { roomId, messageId, content: msg.content });
    if (typeof callback === 'function') callback({ success: true, message: msg });
  });

  // Toggle Pin Message
  socket.on('toggle_pin_message', (data = {}, callback) => {
    const { roomId, messageId } = data;
    if (!roomId || !messageId) {
      if (typeof callback === 'function') callback({ success: false, error: 'Room ID and Message ID required' });
      return;
    }

    const history = getMessageHistory(roomId);
    const msg = history.find(m => m.id === messageId);
    if (!msg) {
      if (typeof callback === 'function') callback({ success: false, error: 'Message not found' });
      return;
    }

    msg.isPinned = !msg.isPinned;
    saveUsers();

    io.to(roomId).emit('message_pinned_toggled', { roomId, messageId, isPinned: msg.isPinned });
    if (typeof callback === 'function') callback({ success: true, isPinned: msg.isPinned });
  });

  // Delete Message
  socket.on('delete_message', (data = {}, callback) => {
    const user = usersBySocket.get(socket.id);
    const isAdmin = isLocalhostSocket(socket);

    if (!user && !isAdmin) return;

    const { roomId, messageId } = data;
    if (!roomId || !messageId) {
      if (typeof callback === 'function') callback({ success: false, error: 'Room and Message ID required' });
      return;
    }

    const history = getMessageHistory(roomId);
    const msgIdx = history.findIndex(m => m.id === messageId);
    if (msgIdx === -1) {
      if (typeof callback === 'function') callback({ success: false, error: 'Message not found' });
      return;
    }

    const msg = history[msgIdx];
    const isSender = (user && msg.sender && msg.sender.lanId === user.lanId);
    let canDelete = isSender || isAdmin;

    if (!canDelete && roomId.startsWith('group_') && activeGroups.has(roomId) && user) {
      const grp = activeGroups.get(roomId);
      if (user.lanId === grp.createdBy || (grp.admins && grp.admins.includes(user.lanId))) {
        canDelete = true;
      }
    }

    if (!canDelete) {
      if (typeof callback === 'function') callback({ success: false, error: 'Permission denied: You cannot delete this message' });
      return;
    }

    history.splice(msgIdx, 1);
    saveUsers();

    io.to(roomId).emit('message_deleted', { roomId, messageId });
    if (typeof callback === 'function') callback({ success: true });
  });

  // Send Message
  socket.on('send_message', (data = {}, callback) => {
    const user = usersBySocket.get(socket.id);
    if (!user) return;

    const { roomId, content, attachment } = data;
    if (!roomId || (!content && !attachment)) {
      if (typeof callback === 'function') callback({ success: false, error: 'Empty message' });
      return;
    }

    let roleTag = null;
    if (roomId.startsWith('group_') && activeGroups.has(roomId)) {
      const grp = activeGroups.get(roomId);
      if (user.lanId === grp.createdBy) {
        roleTag = 'Owner';
      } else if (grp.admins && grp.admins.includes(user.lanId)) {
        roleTag = 'Admin';
      }

      if (attachment) {
        const disallowed = grp.disallowedFileTypes || [];
        if (disallowed.length > 0) {
          const filename = (attachment.originalName || attachment.filename || '').toLowerCase();
          const mime = (attachment.mimeType || '').toLowerCase();
          for (const dt of disallowed) {
            const dtClean = dt.trim().toLowerCase();
            if (dtClean && (filename.endsWith(dtClean) || mime.includes(dtClean))) {
              if (typeof callback === 'function') {
                callback({ success: false, error: `File type '${dtClean}' is restricted in this group by Owner/Admin.` });
              }
              return;
            }
          }
        }
      }
    }

    const msg = {
      id: 'msg_' + Date.now() + '_' + Math.random().toString(36).substr(2, 5),
      roomId,
      sender: {
        lanId: user.lanId,
        username: user.username,
        color: user.color,
        roleTag
      },
      content: content || '',
      attachment: attachment || null,
      timestamp: new Date().toISOString(),
      reactions: {}
    };

    saveMessage(roomId, msg);

    // DM routing check
    if (roomId.startsWith('dm:')) {
      const parts = roomId.replace('dm:', '').split('_');
      parts.forEach(lanId => {
        const targetUser = usersByLanId.get(lanId);
        if (targetUser && targetUser.socketId) {
          const targetSocket = io.sockets.sockets.get(targetUser.socketId);
          if (targetSocket) {
            targetSocket.join(roomId);
          }
        }
      });
      io.to(roomId).emit('new_message', msg);
    } else if (roomId.startsWith('group_')) {
      // Group room
      socket.join(roomId);
      io.to(roomId).emit('new_message', msg);
    } else {
      // General or other channel
      socket.join(roomId);
      io.to(roomId).emit('new_message', msg);
    }

    if (typeof callback === 'function') callback({ success: true, message: msg });
  });

  // Typing indicators
  socket.on('typing_start', ({ roomId }) => {
    const user = usersBySocket.get(socket.id);
    if (user && roomId) {
      socket.to(roomId).emit('user_typing', { roomId, user: { lanId: user.lanId, username: user.username } });
    }
  });

  socket.on('typing_stop', ({ roomId }) => {
    const user = usersBySocket.get(socket.id);
    if (user && roomId) {
      socket.to(roomId).emit('user_stop_typing', { roomId, user: { lanId: user.lanId, username: user.username } });
    }
  });

  // Message Reactions
  socket.on('add_reaction', ({ roomId, messageId, emoji }) => {
    const user = usersBySocket.get(socket.id);
    if (!user || !roomId || !messageId || !emoji) return;

    const history = getMessageHistory(roomId);
    const msg = history.find(m => m.id === messageId);
    if (msg) {
      if (!msg.reactions) msg.reactions = {};
      if (!msg.reactions[emoji]) msg.reactions[emoji] = [];
      
      const userIndex = msg.reactions[emoji].indexOf(user.lanId);
      if (userIndex > -1) {
        msg.reactions[emoji].splice(userIndex, 1);
        if (msg.reactions[emoji].length === 0) delete msg.reactions[emoji];
      } else {
        msg.reactions[emoji].push(user.lanId);
      }

      io.to(roomId).emit('message_reaction_updated', { roomId, messageId, reactions: msg.reactions });
      saveUsers();
    }
  });

  // Disconnect
  socket.on('disconnect', () => {
    const user = usersBySocket.get(socket.id);
    if (user) {
      user.online = false;
      usersBySocket.delete(socket.id);
      
      // Update status on usersByLanId if no active socket exists for this lanId
      let stillConnected = false;
      for (const u of usersBySocket.values()) {
        if (u.lanId === user.lanId) {
          stillConnected = true;
          break;
        }
      }
      if (!stillConnected) {
        usersByLanId.set(user.lanId, { ...user, online: false });
      }

      io.emit('users_list', Array.from(usersByLanId.values()));
      console.log(`User ${user.username} (${user.lanId}) disconnected.`);
    }
  });
});

if (require.main === module) {
  server.listen(PORT, '0.0.0.0', () => {
    const lanIps = getLanIps();
    console.log(`\n==================================================`);
    console.log(`🚀 LAN Chat Server active!`);
    console.log(`Local Access: http://localhost:${PORT}`);
    lanIps.forEach(ip => {
      console.log(`LAN Access:   http://${ip}:${PORT}`);
    });
    console.log(`==================================================\n`);
  });
}

module.exports = { app, server, io };
