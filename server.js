const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const bcrypt = require('bcrypt');
const session = require('express-session');
const bodyParser = require('body-parser');
const path = require('path');

const app = express();
const port = process.env.PORT || 3000;

app.use(bodyParser.urlencoded({ extended: true }));
app.use(session({
  secret: process.env.SESSION_SECRET || 'geheimnis123',
  resave: false,
  saveUninitialized: false,
  cookie: { secure: false, sameSite: 'lax' }
}));
app.use(express.static('public'));

// Datenbank
const dbPath = path.resolve(__dirname, 'database.db');
const db = new sqlite3.Database(dbPath);

db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE,
    password TEXT,
    role TEXT,
    looking_for_team INTEGER DEFAULT 0
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
  db.run(`CREATE TABLE IF NOT EXISTS team_invitations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    team_id INTEGER,
    player_id INTEGER,
    status TEXT
  )`);
});

// Registrierung
app.post('/register', async (req, res) => {
  const { username, password, role } = req.body;
  const hashedPassword = await bcrypt.hash(password, 10);
  db.run(`INSERT INTO users (username, password, role) VALUES (?, ?, ?)`,
    [username, hashedPassword, role], err => {
      if (err) return res.send('Registrierung fehlgeschlagen');
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

  db.run(`INSERT INTO teams (name, creator_id) VALUES (?, ?)`, [name, req.session.userId], function(err) {
    if (err) return res.send('Fehler beim Team erstellen');

    const teamId = this.lastID;
    db.run(`INSERT INTO team_requests (player_id, team_id, status) VALUES (?, ?, 'accepted')`,
      [req.session.userId, teamId], err2 => {
        if (err2) return res.send('Fehler beim Zuweisen');
        res.redirect('/dashboard.html');
      });
  });
});

// Teams mit Mitgliederanzahl abrufen
app.get('/teams', (req, res) => {
  db.all(`
    SELECT t.*, (
      SELECT COUNT(*) FROM team_requests tr WHERE tr.team_id = t.id AND tr.status = 'accepted'
    ) as member_count
    FROM teams t
  `, [], (err, teams) => {
    if (err) return res.send('Fehler beim Laden der Teams');
    res.json(teams);
  });
});

// Mitglieder eines Teams
app.get('/team-members', (req, res) => {
  db.all(`
    SELECT tr.team_id, u.username
    FROM team_requests tr
    JOIN users u ON tr.player_id = u.id
    WHERE tr.status = 'accepted'
  `, [], (err, rows) => {
    if (err) return res.send('Fehler');
    res.json(rows);
  });
});

// Teamanfrage stellen
app.post('/request-to-team', (req, res) => {
  const { team_id } = req.body;
  if (!req.session.userId) return res.redirect('/login.html');

  db.get(`SELECT COUNT(*) as count FROM team_requests WHERE team_id = ? AND status = 'accepted'`,
    [team_id], (err, row) => {
      if (err) return res.send('Fehler');
      if (row.count >= 5) return res.send('Team ist voll');

      db.run(`INSERT INTO team_requests (player_id, team_id, status) VALUES (?, ?, 'pending')`,
        [req.session.userId, team_id], err2 => {
          if (err2) return res.send('Fehler bei Anfrage');
          res.redirect('/dashboard.html');
        });
    });
});

// Eigene Anfragen anzeigen
app.get('/requests', (req, res) => {
  if (!req.session.userId) return res.redirect('/login.html');

  if (req.session.role === 'creator') {
    db.all(`
      SELECT tr.id, u.username as player_username, t.name as team_name, tr.status
      FROM team_requests tr
      JOIN users u ON tr.player_id = u.id
      JOIN teams t ON tr.team_id = t.id
      WHERE t.creator_id = ?
    `, [req.session.userId], (err, rows) => {
      if (err) return res.send('Fehler');
      res.json(rows);
    });
  } else {
    db.all(`
      SELECT tr.id, t.name as team_name, tr.status
      FROM team_requests tr
      JOIN teams t ON tr.team_id = t.id
      WHERE tr.player_id = ?
    `, [req.session.userId], (err, rows) => {
      if (err) return res.send('Fehler');
      res.json(rows);
    });
  }
});

// Anfrage annehmen/ablehnen
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

// Spieler in Teams
app.get('/players-in-teams', (req, res) => {
  db.all(`
    SELECT u.username, t.name as team_name
    FROM users u
    JOIN team_requests tr ON u.id = tr.player_id
    JOIN teams t ON tr.team_id = t.id
    WHERE tr.status = 'accepted'
  `, [], (err, rows) => {
    if (err) return res.send('Fehler');
    res.json(rows);
  });
});

// Spieler ohne Team
app.get('/players-without-team', (req, res) => {
  db.all(`
    SELECT username FROM users
    WHERE role = 'player' AND id NOT IN (
      SELECT player_id FROM team_requests WHERE status = 'accepted'
    )
  `, [], (err, rows) => {
    if (err) return res.send('Fehler');
    res.json(rows);
  });
});

// Suchstatus setzen
app.post('/set-looking', (req, res) => {
  if (!req.session.userId) return res.redirect('/login.html');
  const { status } = req.body;
  db.run(`UPDATE users SET looking_for_team = ? WHERE id = ?`,
    [status, req.session.userId], err => {
      if (err) return res.send('Fehler beim Aktualisieren');
      res.redirect('/dashboard.html');
    });
});

// Spieler suchen Team (detailliert für Einladungen)
app.get('/players-looking-detailed', (req, res) => {
  db.all(`
    SELECT u.id, u.username FROM users u
    WHERE u.looking_for_team = 1 AND u.id NOT IN (
      SELECT player_id FROM team_requests WHERE status = 'accepted'
    )
  `, [], (err, rows) => {
    if (err) return res.send('Fehler');
    res.json(rows);
  });
});

// Einladung an suchenden Spieler
app.post('/invite-player', (req, res) => {
  if (!req.session.userId || req.session.role !== 'creator') return res.redirect('/login.html');
  const { player_id, team_id } = req.body;

  db.run(`INSERT INTO team_invitations (team_id, player_id, status) VALUES (?, ?, 'pending')`,
    [team_id, player_id], err => {
      if (err) return res.send('Fehler beim Einladen');
      res.redirect('/dashboard.html');
    });
});

// Server starten
app.listen(port, () => {
  console.log(`🚀 Server läuft auf Port ${port}`);
});

