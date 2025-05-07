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

// Registrierung
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

// Benutzer-ID + Name bereitstellen
app.get('/my-id', (req, res) => {
  if (!req.session.userId) return res.status(401).send('Nicht eingeloggt');
  res.json({ id: req.session.userId, username: req.session.username });
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
  db.run(`INSERT INTO teams (name, creator_id) VALUES (?, ?)`, [name, req.session.userId], function (err) {
    if (err) return res.send('Fehler beim Team erstellen');
    const teamId = this.lastID;
    db.run(`INSERT INTO team_requests (player_id, team_id, status) VALUES (?, ?, 'accepted')`, [req.session.userId, teamId], err2 => {
      if (err2) return res.send('Fehler beim Zuweisen');
      res.redirect('/dashboard.html');
    });
  });
});

// Suchstatus setzen
app.post('/set-looking', (req, res) => {
  const { status } = req.body;
  if (!req.session.userId) return res.redirect('/login.html');
  const looking = status === '1' ? 1 : 0;
  db.run(`UPDATE users SET looking_for_team = ? WHERE id = ?`, [looking, req.session.userId], err => {
    if (err) return res.send('Fehler beim Speichern des Suchstatus');
    res.redirect('/dashboard.html');
  });
});

// Teams anzeigen
app.get('/teams', (req, res) => {
  db.all(`
    SELECT t.*, (SELECT COUNT(*) FROM team_requests tr WHERE tr.team_id = t.id AND tr.status = 'accepted') as member_count
    FROM teams t
  `, [], (err, teams) => {
    if (err) return res.send('Fehler beim Laden der Teams');
    res.json(teams);
  });
});

// Mitglieder eines Teams
app.get('/team-members/:teamId', (req, res) => {
  const teamId = req.params.teamId;
  db.all(`
    SELECT u.username
    FROM team_requests tr
    JOIN users u ON tr.player_id = u.id
    WHERE tr.team_id = ? AND tr.status = 'accepted'
  `, [teamId], (err, rows) => {
    if (err) return res.send('Fehler beim Abrufen der Mitglieder');
    res.json(rows);
  });
});

// Team verlassen
app.post('/leave-team', (req, res) => {
  const userId = req.session.userId;
  if (!userId) return res.redirect('/login.html');

  db.get(`
    SELECT t.id, t.creator_id
    FROM team_requests tr
    JOIN teams t ON tr.team_id = t.id
    WHERE tr.player_id = ? AND tr.status = 'accepted'
  `, [userId], (err, result) => {
    if (err || !result) return res.send('Kein Team gefunden');
    if (result.creator_id === userId) {
      return res.send('Team-Leader können das Team nicht verlassen.');
    }

    db.run(`DELETE FROM team_requests WHERE player_id = ? AND team_id = ?`, [userId, result.id], (err2) => {
      if (err2) return res.send('Fehler beim Verlassen');
      res.redirect('/dashboard.html?success=left');
    });
  });
});

// Eigene Anfragen
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

// Spieler die ein Team suchen
app.get('/players-looking-detailed', (req, res) => {
  db.all(`
    SELECT u.id, u.username
    FROM users u
    WHERE u.looking_for_team = 1
      AND u.id NOT IN (SELECT player_id FROM team_requests WHERE status = 'accepted')
  `, [], (err, rows) => {
    if (err) return res.send('Fehler');
    res.json(rows);
  });
});

// Einladung senden
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

// Einladungen für den Spieler
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

// Einladung annehmen / ablehnen
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

// Anfrage an Team senden
app.post('/request-to-team', (req, res) => {
  const { team_id } = req.body;
  const userId = req.session.userId;

  if (!userId) return res.redirect('/login.html');

  db.get(`SELECT * FROM team_requests WHERE player_id = ? AND status = 'accepted'`, [userId], (err, existing) => {
    if (err) return res.send('Fehler beim Überprüfen des Teamstatus');
    if (existing) return res.send('Du bist bereits in einem Team.');

    db.get(`SELECT * FROM team_requests WHERE player_id = ? AND team_id = ?`, [userId, team_id], (err2, existingRequest) => {
      if (existingRequest) return res.send('Du hast bereits eine Anfrage an dieses Team gestellt.');

      db.run(`INSERT INTO team_requests (player_id, team_id, status) VALUES (?, ?, 'pending')`, [userId, team_id], (err3) => {
        if (err3) return res.send('Fehler bei Anfrage');
        res.redirect('/dashboard.html?success=anfrage');
      });
    });
  });
});

app.listen(port, () => {
  console.log(`🚀 Server läuft auf http://localhost:${port}`);
});
