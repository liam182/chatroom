const express = require('express');
const path = require('path');
const bodyParser = require('body-parser');
const session = require('express-session');
const { MongoClient, ObjectId } = require('mongodb');

const app = express();
const PORT = 3000;

// Replace this with your actual MongoDB connection string
const MONGO_URI = 'mongodb+srv://axl1262yt_db_user:h0lYniK6ql9xvj80@chatdb.5jz42eq.mongodb.net/mychatdb?retryWrites=true&w=majority';

let db;
let messagesCollection;
let bannedUsersCollection;
let ownerSessionCollection;

// Admin users with passwords
const admins = {
  imaxl123: 'Mybunnyiscute33',
  liam: 'liampassword',
  hayden: 'booger123',
};

app.use(express.static(path.join(__dirname, 'public')));
app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());

app.use(session({
  secret: 'your-secret-key',
  resave: false,
  saveUninitialized: true,
}));

// Connect to MongoDB
async function connectDB() {
  const client = new MongoClient(MONGO_URI);
  await client.connect();
  db = client.db('mychatdb');
  messagesCollection = db.collection('messages');
  bannedUsersCollection = db.collection('bannedUsers');
  ownerSessionCollection = db.collection('ownerSession');
  console.log('Connected to MongoDB');
}

// Owner session persistence in DB
async function getOwnerSessionId() {
  const doc = await ownerSessionCollection.findOne({ _id: 'ownerSession' });
  return doc ? doc.sessionId : null;
}

async function setOwnerSessionId(sessionId) {
  await ownerSessionCollection.updateOne(
    { _id: 'ownerSession' },
    { $set: { sessionId } },
    { upsert: true }
  );
}

async function clearOwnerSessionId() {
  await ownerSessionCollection.deleteOne({ _id: 'ownerSession' });
}

// Banned users persistence in DB
async function getBannedUsers() {
  const doc = await bannedUsersCollection.findOne({ _id: 'bannedUsers' });
  return doc ? doc.users : [];
}

async function saveBannedUsers(users) {
  await bannedUsersCollection.updateOne(
    { _id: 'bannedUsers' },
    { $set: { users } },
    { upsert: true }
  );
}

async function banUser(user) {
  const users = await getBannedUsers();
  if (!users.includes(user)) {
    users.push(user);
    await saveBannedUsers(users);
  }
}

async function unbanUser(user) {
  let users = await getBannedUsers();
  users = users.filter(u => u !== user);
  await saveBannedUsers(users);
}

async function isUserBanned(user) {
  const users = await getBannedUsers();
  return users.includes(user);
}

// System message stored in memory (can be persisted if needed)
let systemMessage = null;

// Middleware to protect admin routes
async function isAdmin(req, res, next) {
  if (req.session.user && admins[req.session.user]) {
    if (req.session.user === 'liam') {
      const ownerSessionId = await getOwnerSessionId();
      if (ownerSessionId !== req.sessionID) {
        return res.redirect('/login.html');
      }
    }
    next();
  } else {
    res.redirect('/login.html');
  }
}

// Routes
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/login', (req, res) => {
  res.redirect('/login.html');
});

app.post('/login', async (req, res) => {
  const { username, password } = req.body;

  if (!(username in admins)) {
    return res.send('Invalid credentials. <a href="/login.html">Try again</a>');
  }

  if (admins[username] !== password) {
    return res.send('Invalid credentials. <a href="/login.html">Try again</a>');
  }

  if (username === 'liam') {
    const ownerSessionId = await getOwnerSessionId();

    if (!ownerSessionId) {
      await setOwnerSessionId(req.sessionID);
    } else if (ownerSessionId !== req.sessionID) {
      return res.send('Owner account already in use on another device. <a href="/login.html">Try again</a>');
    }
  }

  req.session.user = username;
  res.redirect('/admin.html');
});

app.get('/admin.html', isAdmin, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

app.get('/logout', async (req, res) => {
  if (req.session.user === 'liam') {
    const ownerSessionId = await getOwnerSessionId();
    if (ownerSessionId === req.sessionID) {
      await clearOwnerSessionId();
    }
  }
  req.session.destroy(() => {
    res.redirect('/');
  });
});

// API: Get messages
app.get('/api/messages', async (req, res) => {
  const messages = await messagesCollection.find().sort({ timestamp: 1 }).toArray();
  res.json(messages);
});

// API: Post message
app.post('/api/messages', async (req, res) => {
  const { user, message } = req.body;

  if (!user || !message) return res.status(400).json({ error: 'User and message required' });

  // Ban check
  if (await isUserBanned(user.toLowerCase())) {
    return res.status(403).json({ error: 'You are banned from sending messages.' });
  }

  // Prevent anyone from taking 'liam' unless session owner
  if (user.toLowerCase() === 'liam') {
    if (!req.session.user || req.session.user !== 'liam' || await getOwnerSessionId() !== req.sessionID) {
      return res.status(403).json({ error: 'This username is reserved and cannot be used.' });
    }
  }

  // If system message active, block normal messages
  if (systemMessage) {
    return res.status(403).json({ error: 'Chat is currently disabled by system.' });
  }

  // Add normal message
  await messagesCollection.insertOne({
    user,
    message,
    timestamp: Date.now(),
    type: 'user',
  });

  res.status(200).json({ message: 'Message sent' });
});

// Admin commands API
app.post('/api/admin/command', isAdmin, async (req, res) => {
  const { command } = req.body;
  if (!command) return res.status(400).json({ message: 'Command required' });

  const parts = command.trim().split(' ');
  const cmd = parts[0].toLowerCase();

  // Helper to add admin/system message
  async function addSystemMessage(msg, type = 'system') {
    await messagesCollection.insertOne({
      user: type === 'admin' ? 'Admin' : 'System',
      message: msg,
      timestamp: Date.now(),
      type, // 'system' or 'admin'
    });
  }

  switch (cmd) {
    case '/help':
      return res.json({
        message: `Commands available:
  /help - Show this help message
  /ban <username> - Ban a user
  /unban <username> - Unban a user
  /system <message> - Set system message and pause chat (empty to clear)
  /chat <message> - Send admin message in chat
  /clear - Clear chat messages`
      });

    case '/ban':
      if (parts.length < 2) return res.json({ message: 'Usage: /ban <username>' });
      const banUserName = parts[1].toLowerCase();
      if (banUserName === 'liam') return res.json({ message: 'Cannot ban the owner.' });
      await banUser(banUserName);
      await addSystemMessage(`User "${banUserName}" has been banned by admin.`, 'admin');
      return res.json({ message: `User "${banUserName}" banned.` });

    case '/unban':
      if (parts.length < 2) return res.json({ message: 'Usage: /unban <username>' });
      const unbanUserName = parts[1].toLowerCase();
      await unbanUser(unbanUserName);
      await addSystemMessage(`User "${unbanUserName}" has been unbanned by admin.`, 'admin');
      return res.json({ message: `User "${unbanUserName}" unbanned.` });

    case '/system':
      // Set system message or clear it
      const sysMsg = parts.slice(1).join(' ');
      systemMessage = sysMsg.trim() || null;
      if (systemMessage) {
        await addSystemMessage(`System message set: "${systemMessage}". Chat is paused.`, 'system');
      } else {
        await addSystemMessage('System message cleared. Chat resumed.', 'system');
      }
      return res.json({ message: `System message updated.` });

    case '/chat':
      const adminMsg = parts.slice(1).join(' ');
      if (!adminMsg) return res.json({ message: 'Usage: /chat <message>' });
      await addSystemMessage(adminMsg, 'admin');
      return res.json({ message: 'Admin message sent.' });

    case '/clear':
      await messagesCollection.deleteMany({});
      return res.json({ message: 'Chat cleared.' });

    default:
      return res.json({ message: 'Unknown command. Use /help for a list of commands.' });
  }
});

// Start the server after connecting to DB
connectDB()
  .then(() => {
    app.listen(PORT, '0.0.0.0', () => {
      console.log(`Server running on http://localhost:${PORT}`);
    });
  })
  .catch(err => {
    console.error('Failed to connect to MongoDB', err);
    process.exit(1);
  });
