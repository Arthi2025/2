const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const bcrypt = require('bcrypt');
const session = require('express-session');
const bodyParser = require('body-parser');
const path = require('path');

const app = express();
const port = process.env.PORT || 3000;

// Middleware
app.use(bodyParser.urlencoded({ extended: true }));
app.use(session({
  secret: process.env.SESSION_SECRET || 'geheimnis123',
  resave: false,
  saveUninitialized: false,
  cookie: { secure: false, sameSite: 'lax' }
}));
app.use(express.static('public'));

// 👉 Route für Startseite
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// SQLite-Datenbank
const dbPath = path.resolve(__dirname, 'database.db');
const db = new sqlite3.Database(dbPath);

// Tabellen erstellen
db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE,
    password TEXT,
    role TEXT
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS teams (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT,
    creator_id INTEGER
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS team_requests (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    player_id INTEGER,
    team_id INTEGER,
    status TEXT
  )`);
});

// Registrierung
app.post('/register', async (req, res) => {
  const { username, password, role } = req.body;
  const hashedPassword = await bcrypt.hash(password, 10);
  db.run(`INSERT INTO users (username, password, role) VALUES (?, ?, ?)`,
    [username, hashedPassword, role], err => {
      if (err) {
        console.error('Fehler bei Registrierung:', err.message);
        return res.send('Registrierung fehlgeschlagen');
      }
      res.redirect('/login.html');
    });
});

// Login
app.post('/login', (req, res) => {
  const { username, password } = req.body;
  db.get(`SELECT * FROM users WHERE username = ?`, [username], async (err, user) => {
    if (!user || !(await bcrypt.compare(password, user.password))) {
      return res.send('Login fehlgeschlagen');
    }
    req.session.userId = user.id;
    req.session.role = user.role;
    res.redirect('/dashboard.html');
  });
});

// Logout
app.get('/logout', (req, res) => {
  req.session.destroy();
  res.redirect('/login.html');
});

// Team erstellen
app.post('/create-team', (req, res) => {
  if (!req.session.userId) return res.redirect('/login.html');
  const { name } = req.body;
  db.run(`INSERT INTO teams (name, creator_id) VALUES (?, ?)`,
    [name, req.session.userId], err => {
      if (err) return res.send('Fehler beim Team erstellen');
      res.redirect('/dashboard.html');
    });
});

// Teams abrufen
app.get('/teams', (req, res) => {
  db.all(`SELECT * FROM teams`, [], (err, teams) => {
    if (err) return res.send('Fehler beim Laden der Teams');
    res.json(teams);
  });
});

// Anfrage an Team senden
app.post('/request-to-team', (req, res) => {
  const { team_id } = req.body;
  if (!req.session.userId) return res.redirect('/login.html');
  db.run(`INSERT INTO team_requests (player_id, team_id, status) VALUES (?, ?, 'pending')`,
    [req.session.userId, team_id], err => {
      if (err) return res.send('Fehler bei Anfrage');
      res.redirect('/dashboard.html');
    });
});

// Anfragen anzeigen
app.get('/requests', (req, res) => {
  if (!req.session.userId) return res.redirect('/login.html');

  if (req.session.role === 'creator') {
    // Anfragen für Team-Ersteller
    db.all(`
      SELECT tr.id, u.username as player_username, t.name as team_name, tr.status
      FROM team_requests tr
      JOIN users u ON tr.player_id = u.id
      JOIN teams t ON tr.team_id = t.id
      WHERE t.creator_id = ?
    `, [req.session.userId], (err, requests) => {
      if (err) return res.send('Fehler');
      res.json(requests);
    });

  } else {
    // Eigene Anfragen für Spieler
    db.all(`
      SELECT tr.id, t.name as team_name, tr.status
      FROM team_requests tr
      JOIN teams t ON tr.team_id = t.id
      WHERE tr.player_id = ?
    `, [req.session.userId], (err, requests) => {
      if (err) return res.send('Fehler');
      res.json(requests);
    });
  }
});

// Anfrage annehmen oder ablehnen
app.post('/handle-request', (req, res) => {
  const { request_id, action } = req.body;
  if (!req.session.userId) return res.redirect('/login.html');
  const newStatus = action === 'accept' ? 'accepted' : 'declined';
  db.run(`UPDATE team_requests SET status = ? WHERE id = ?`,
    [newStatus, request_id], err => {
      if (err) return res.send('Fehler bei Update');
      res.redirect('/dashboard.html');
    });
});

// Server starten
app.listen(port, () => {
  console.log(`🚀 Server läuft auf Port ${port}`);
});


