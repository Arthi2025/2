// server.js
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
  secret: 'geheimnis123',
  resave: false,
  saveUninitialized: false,
  cookie: { secure: false, sameSite: 'lax' }
}));
app.use(express.static('public'));

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

app.post('/register', async (req, res) => {
  const { username, password } = req.body;
  const hashedPassword = await bcrypt.hash(password, 10);
  db.run(`INSERT INTO users (username, password) VALUES (?, ?)`, [username, hashedPassword], function (err) {
    if (err) {
      if (err.message.includes('UNIQUE')) {
        return res.send('Benutzername schon vergeben. Bitte wähle einen anderen.');
      }
      return res.send('Registrierung fehlgeschlagen.');
    }
    res.redirect('/login.html');
  });
});

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

app.get('/logout', (req, res) => {
  req.session.destroy();
  res.redirect('/login.html');
});

app.get('/my-id', (req, res) => {
  if (!req.session.userId) return res.status(401).send('Nicht eingeloggt');
  res.json({ id: req.session.userId });
});

app.post('/create-team', (req, res) => {
  if (!req.session.userId) return res.redirect('/login.html');
  const { name } = req.body;
  db.run(`INSERT INTO teams (name, creator_id) VALUES (?, ?)`, [name, req.session.userId], function (err) {
    if (err) return res.send('Fehler beim Team erstellen');
    const teamId = this.lastID;
    db.run(`INSERT INTO team_requests (player_id, team_id, status) VALUES (?, ?, 'accepted')`, [req.session.userId, teamId], err2 => {
      if (err2) return res.send('Fehler beim Zuweisen');
      res.redirect('/dashboard.html');
    });
  });
});

app.post('/set-looking', (req, res) => {
  const { status } = req.body;
  if (!req.session.userId) return res.redirect('/login.html');
  const looking = status === '1' ? 1 : 0;
  db.run(`UPDATE users SET looking_for_team = ? WHERE id = ?`, [looking, req.session.userId], err => {
    if (err) return res.send('Fehler beim Speichern des Suchstatus');
    res.redirect('/dashboard.html');
  });
});

app.get('/teams', (req, res) => {
  db.all(`SELECT t.*, (SELECT COUNT(*) FROM team_requests tr WHERE tr.team_id = t.id AND tr.status = 'accepted') as member_count FROM teams t`, [], (err, teams) => {
    if (err) return res.send('Fehler beim Laden der Teams');
    res.json(teams);
  });
});

app.get('/requests', (req, res) => {
  if (!req.session.userId) return res.redirect('/login.html');
  db.all(`SELECT tr.id, u.username as player_username, t.name as team_name, t.creator_id, tr.status FROM team_requests tr JOIN users u ON tr.player_id = u.id JOIN teams t ON tr.team_id = t.id WHERE t.creator_id = ? OR tr.player_id = ?`, [req.session.userId, req.session.userId], (err, rows) => {
    if (err) return res.send('Fehler');
    res.json(rows);
  });
});

app.get('/players-looking-detailed', (req, res) => {
  db.all(`SELECT u.id, u.username FROM users u WHERE u.looking_for_team = 1 AND u.id NOT IN (SELECT player_id FROM team_requests WHERE status = 'accepted')`, [], (err, rows) => {
    if (err) return res.send('Fehler');
    res.json(rows);
  });
});

app.post('/invite-player', (req, res) => {
  const { player_id, team_id } = req.body;
  if (!req.session.userId) return res.redirect('/login.html');
  db.get(`SELECT * FROM teams WHERE id = ? AND creator_id = ?`, [team_id, req.session.userId], (err, team) => {
    if (!team) return res.send('Nur Team-Ersteller darf einladen.');
    db.run(`INSERT INTO team_invitations (team_id, player_id, status) VALUES (?, ?, 'pending')`, [team_id, player_id], err2 => {
      if (err2) return res.send('Fehler bei Einladung');
      res.redirect('/dashboard.html');
    });
  });
});

app.get('/my-invitations', (req, res) => {
  if (!req.session.userId) return res.redirect('/login.html');
  db.all(`
    SELECT i.id, t.name AS team_name, i.team_id
    FROM team_invitations i
    JOIN teams t ON i.team_id = t.id
    WHERE i.player_id = ? AND i.status = 'pending'
  `, [req.session.userId], (err, rows) => {
    if (err) return res.send('Fehler beim Abrufen von Einladungen');
    res.json(rows);
  });
});

app.post('/handle-invitation', (req, res) => {
  const { invitation_id, action, team_id } = req.body;
  if (!req.session.userId) return res.redirect('/login.html');

  if (action === 'accept') {
    db.serialize(() => {
      db.run(`UPDATE team_invitations SET status = 'accepted' WHERE id = ?`, [invitation_id]);
      db.run(`INSERT INTO team_requests (player_id, team_id, status) VALUES (?, ?, 'accepted')`, [req.session.userId, team_id]);
      db.run(`UPDATE users SET looking_for_team = 0 WHERE id = ?`, [req.session.userId]);
    });
  } else if (action === 'decline') {
    db.run(`UPDATE team_invitations SET status = 'declined' WHERE id = ?`, [invitation_id]);
  }

  res.redirect('/dashboard.html');
});

app.listen(port, () => {
  console.log(`🚀 Server läuft auf http://localhost:${port}`);
});
