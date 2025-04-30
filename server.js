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
const db = new sqlite3.Database(path.resolve(__dirname, 'database.db'));

db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE,
    password TEXT,
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
  const { username, password } = req.body;
  const hashedPassword = await bcrypt.hash(password, 10);

  db.run(`INSERT INTO users (username, password) VALUES (?, ?)`,
    [username, hashedPassword],
    function (err) {
      if (err) {
        if (err.message.includes('UNIQUE')) {
          return res.send('Benutzername schon vergeben. Bitte wähle einen anderen.');
        }
        return res.send('Registrierung fehlgeschlagen.');
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
    req.session.username = user.username;
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
    [name, req.session.userId],
    function (err) {
      if (err) return res.send('Fehler beim Team erstellen');

      const teamId = this.lastID;
      db.run(`INSERT INTO team_requests (player_id, team_id, status) VALUES (?, ?, 'accepted')`,
        [req.session.userId, teamId], err2 => {
          if (err2) return res.send('Fehler beim Zuweisen');
          res.redirect('/dashboard.html');
        });
    });
});

// Team verlassen
app.post('/leave-team', (req, res) => {
  if (!req.session.userId) return res.redirect('/login.html');

  db.run(`DELETE FROM team_requests WHERE player_id = ? AND status = 'accepted'`,
    [req.session.userId], err => {
      if (err) return res.send('Fehler beim Verlassen des Teams');
      res.redirect('/dashboard.html');
    });
});

// Spieler entfernen (nur durch Team-Ersteller)
app.post('/remove-player', (req, res) => {
  const { player_id, team_id } = req.body;
  if (!req.session.userId) return res.redirect('/login.html');

  db.get(`SELECT * FROM teams WHERE id = ? AND creator_id = ?`,
    [team_id, req.session.userId], (err, row) => {
      if (!row) return res.send('Nur Ersteller darf Spieler entfernen.');
      db.run(`DELETE FROM team_requests WHERE team_id = ? AND player_id = ? AND status = 'accepted'`,
        [team_id, player_id], err2 => {
          if (err2) return res.send('Fehler beim Entfernen');
          res.redirect('/dashboard.html');
        });
    });
});

// Teams abrufen mit Mitgliedszahl
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
    SELECT tr.team_id, u.username, u.id as user_id
    FROM team_requests tr
    JOIN users u ON tr.player_id = u.id
    WHERE tr.status = 'accepted'
  `, [], (err, rows) => {
    if (err) return res.send('Fehler beim Laden');
    res.json(rows);
  });
});

// Team-Anfrage stellen (nur wenn nicht schon in einem Team)
app.post('/request-to-team', (req, res) => {
  const { team_id } = req.body;
  if (!req.session.userId) return res.redirect('/login.html');

  db.get(`SELECT * FROM team_requests WHERE player_id = ? AND status = 'accepted'`,
    [req.session.userId], (err, existing) => {
      if (err) return res.send('Fehler');
      if (existing) return res.send('Du bist bereits in einem Team.');

      db.get(`SELECT COUNT(*) as count FROM team_requests WHERE team_id = ? AND status = 'accepted'`,
        [team_id], (err2, result) => {
          if (err2) return res.send('Fehler beim Prüfen');
          if (result.count >= 5) return res.send('Team ist voll');

          db.run(`INSERT INTO team_requests (player_id, team_id, status) VALUES (?, ?, 'pending')`,
            [req.session.userId, team_id], err3 => {
              if (err3) return res.send('Fehler bei Anfrage');
              res.redirect('/dashboard.html');
            });
        });
    });
});

// Anfragen anzeigen (alle Anfragen von und an den User)
app.get('/requests', (req, res) => {
  if (!req.session.userId) return res.redirect('/login.html');

  db.all(`
    SELECT tr.id, u.username as player_username, t.name as team_name, t.creator_id, tr.status
    FROM team_requests tr
    JOIN users u ON tr.player_id = u.id
    JOIN teams t ON tr.team_id = t.id
    WHERE t.creator_id = ? OR tr.player_id = ?
  `, [req.session.userId, req.session.userId], (err, rows) => {
    if (err) return res.send('Fehler');
    res.json(rows);
  });
});

// Anfrage annehmen/ablehnen
app.post('/handle-request', (req, res) => {
  const { request_id, action } = req.body;
  if (!req.session.userId) return res.redirect('/login.html');
  const newStatus = action === 'accept' ? 'accepted' : 'declined';
  db.run(`UPDATE team_requests SET status = ? WHERE id = ?`, [newStatus, request_id], err => {
    if (err) return res.send('Fehler bei Statusänderung');
    res.redirect('/dashboard.html');
  });
});

// Spieler die einem Team zugewiesen sind
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
    WHERE id NOT IN (
      SELECT player_id FROM team_requests WHERE status = 'accepted'
    )
  `, [], (err, rows) => {
    if (err) return res.send('Fehler');
    res.json(rows);
  });
});

// Spieler sucht Team setzen
app.post('/set-looking', (req, res) => {
  const { status } = req.body;
  if (!req.session.userId) return res.redirect('/login.html');

  db.run(`UPDATE users SET looking_for_team = ? WHERE id = ?`,
    [status, req.session.userId], err => {
      if (err) return res.send('Fehler beim Status-Update');
      res.redirect('/dashboard.html');
    });
});

// Spieler sucht Team (mit ID für Einladen)
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

// Einladung senden (nur durch Team-Ersteller)
app.post('/invite-player', (req, res) => {
  const { player_id, team_id } = req.body;
  if (!req.session.userId) return res.redirect('/login.html');

  db.get(`SELECT * FROM teams WHERE id = ? AND creator_id = ?`,
    [team_id, req.session.userId], (err, team) => {
      if (!team) return res.send('Nur Team-Ersteller darf einladen.');
      db.run(`INSERT INTO team_invitations (team_id, player_id, status) VALUES (?, ?, 'pending')`,
        [team_id, player_id], err2 => {
          if (err2) return res.send('Fehler bei Einladung');
          res.redirect('/dashboard.html');
        });
    });
});

// Server starten
app.listen(port, () => {
  console.log(`🚀 Server läuft auf http://localhost:${port}`);
});
