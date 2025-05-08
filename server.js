const express = require('express');
const { Pool } = require('pg');
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

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// Tabellen beim Start erstellen
async function initDatabase() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      username TEXT UNIQUE,
      password TEXT,
      looking_for_team BOOLEAN DEFAULT FALSE,
      is_admin BOOLEAN DEFAULT FALSE
    );
    CREATE TABLE IF NOT EXISTS teams (
      id SERIAL PRIMARY KEY,
      name TEXT,
      creator_id INTEGER REFERENCES users(id)
    );
    CREATE TABLE IF NOT EXISTS team_requests (
      id SERIAL PRIMARY KEY,
      player_id INTEGER REFERENCES users(id),
      team_id INTEGER REFERENCES teams(id),
      status TEXT
    );
    CREATE TABLE IF NOT EXISTS team_invitations (
      id SERIAL PRIMARY KEY,
      team_id INTEGER REFERENCES teams(id),
      player_id INTEGER REFERENCES users(id),
      status TEXT
    );
  `);

  const result = await pool.query(`SELECT * FROM users WHERE username = 'Admin'`);
  if (result.rows.length === 0) {
    const hashed = await bcrypt.hash('Admin2025!', 10);
    await pool.query(`INSERT INTO users (username, password, is_admin) VALUES ($1, $2, true)`, ['Admin', hashed]);
  }
}
initDatabase();
// Registrierung
app.post('/register', async (req, res) => {
  const { username, password } = req.body;
  const hashed = await bcrypt.hash(password, 10);

  try {
    await pool.query(
      `INSERT INTO users (username, password) VALUES ($1, $2)`,
      [username, hashed]
    );
    res.redirect('/login.html');
  } catch (err) {
    if (err.code === '23505') {
      res.send('Benutzername schon vergeben. Bitte anderen wählen.');
    } else {
      res.send('Registrierung fehlgeschlagen.');
    }
  }
});

// Login
app.post('/login', async (req, res) => {
  const { username, password } = req.body;
  const result = await pool.query(`SELECT * FROM users WHERE username = $1`, [username]);
  const user = result.rows[0];

  if (!user || !(await bcrypt.compare(password, user.password))) {
    return res.send('Login fehlgeschlagen');
  }

  req.session.userId = user.id;
  req.session.username = user.username;
  req.session.isAdmin = user.is_admin;
  res.redirect('/dashboard.html');
});

// Logout
app.get('/logout', (req, res) => {
  req.session.destroy();
  res.redirect('/login.html');
});

// Aktueller Nutzer
app.get('/my-id', (req, res) => {
  if (!req.session.userId) return res.status(401).send('Nicht eingeloggt');
  res.json({ id: req.session.userId, username: req.session.username });
});

// Team erstellen
app.post('/create-team', async (req, res) => {
  const { name } = req.body;
  const userId = req.session.userId;

  const result = await pool.query(
    `INSERT INTO teams (name, creator_id) VALUES ($1, $2) RETURNING id`,
    [name, userId]
  );
  const teamId = result.rows[0].id;

  await pool.query(
    `INSERT INTO team_requests (player_id, team_id, status) VALUES ($1, $2, 'accepted')`,
    [userId, teamId]
  );

  res.redirect('/dashboard.html');
});
// Team verlassen
app.post('/leave-team', async (req, res) => {
  const userId = req.session.userId;
  const result = await pool.query(`
    SELECT t.id, t.creator_id FROM team_requests tr
    JOIN teams t ON tr.team_id = t.id
    WHERE tr.player_id = $1 AND tr.status = 'accepted'
  `, [userId]);

  const team = result.rows[0];
  if (!team || team.creator_id === userId) {
    return res.send('Team-Leader kann das Team nicht verlassen.');
  }

  await pool.query(
    `DELETE FROM team_requests WHERE player_id = $1 AND team_id = $2`,
    [userId, team.id]
  );

  res.redirect('/dashboard.html?success=left');
});

// Alle Teams anzeigen
app.get('/teams', async (req, res) => {
  const result = await pool.query(`
    SELECT t.*, (
      SELECT COUNT(*) FROM team_requests WHERE team_id = t.id AND status = 'accepted'
    ) AS member_count
    FROM teams t
  `);
  res.json(result.rows);
});

// Mitglieder eines Teams
app.get('/team-members/:teamId', async (req, res) => {
  const result = await pool.query(`
    SELECT u.id, u.username FROM team_requests tr
    JOIN users u ON tr.player_id = u.id
    WHERE tr.team_id = $1 AND tr.status = 'accepted'
  `, [req.params.teamId]);
  res.json(result.rows);
});

// Status "Ich suche ein Team"
app.post('/set-looking', async (req, res) => {
  const status = req.body.status === '1';
  await pool.query(`UPDATE users SET looking_for_team = $1 WHERE id = $2`, [status, req.session.userId]);
  res.redirect('/dashboard.html');
});

// Suchende Spieler abrufen
app.get('/players-looking-detailed', async (req, res) => {
  const result = await pool.query(`
    SELECT id, username FROM users
    WHERE looking_for_team = TRUE
    AND id NOT IN (
      SELECT player_id FROM team_requests WHERE status = 'accepted'
    )
  `);
  res.json(result.rows);
});
// Anfrage an Team senden
app.post('/request-to-team', async (req, res) => {
  const userId = req.session.userId;
  const { team_id } = req.body;

  const inTeam = await pool.query(`SELECT * FROM team_requests WHERE player_id = $1 AND status = 'accepted'`, [userId]);
  if (inTeam.rows.length > 0) return res.send('Du bist bereits in einem Team.');

  const existingRequest = await pool.query(`SELECT * FROM team_requests WHERE player_id = $1 AND team_id = $2`, [userId, team_id]);
  if (existingRequest.rows.length > 0) return res.send('Anfrage bereits gesendet.');

  await pool.query(
    `INSERT INTO team_requests (player_id, team_id, status) VALUES ($1, $2, 'pending')`,
    [userId, team_id]
  );

  res.redirect('/dashboard.html?success=anfrage');
});

// Anfragen für Team-Leader anzeigen
app.get('/requests', async (req, res) => {
  const result = await pool.query(`
    SELECT tr.id, u.username as player_username, t.name as team_name, tr.status
    FROM team_requests tr
    JOIN users u ON tr.player_id = u.id
    JOIN teams t ON tr.team_id = t.id
    WHERE t.creator_id = $1
  `, [req.session.userId]);
  res.json(result.rows);
});

// Anfrage annehmen/ablehnen
app.post('/handle-request', async (req, res) => {
  const { request_id, action } = req.body;
  const status = action === 'accept' ? 'accepted' : 'declined';

  await pool.query(
    `UPDATE team_requests SET status = $1 WHERE id = $2`,
    [status, request_id]
  );

  if (status === 'accepted') {
    await pool.query(`UPDATE users SET looking_for_team = FALSE WHERE id = (
      SELECT player_id FROM team_requests WHERE id = $1
    )`, [request_id]);
  }

  res.redirect('/dashboard.html');
});

// Einladung senden (Team-Leader)
app.post('/invite-player', async (req, res) => {
  const { team_id, player_id } = req.body;

  const leader = await pool.query(`SELECT * FROM teams WHERE id = $1 AND creator_id = $2`, [team_id, req.session.userId]);
  if (leader.rows.length === 0) return res.send('Nicht berechtigt');

  await pool.query(
    `INSERT INTO team_invitations (team_id, player_id, status) VALUES ($1, $2, 'pending')`,
    [team_id, player_id]
  );

  res.redirect('/dashboard.html');
});

// Einladungen anzeigen
app.get('/my-invitations', async (req, res) => {
  const result = await pool.query(`
    SELECT i.id, t.name as team_name, i.team_id
    FROM team_invitations i
    JOIN teams t ON i.team_id = t.id
    WHERE i.player_id = $1 AND i.status = 'pending'
  `, [req.session.userId]);

  res.json(result.rows);
});

// Einladung annehmen/ablehnen
app.post('/handle-invitation', async (req, res) => {
  const { invitation_id, action, team_id } = req.body;

  if (action === 'accept') {
    await pool.query(`UPDATE team_invitations SET status = 'accepted' WHERE id = $1`, [invitation_id]);
    await pool.query(`INSERT INTO team_requests (player_id, team_id, status) VALUES ($1, $2, 'accepted')`, [req.session.userId, team_id]);
    await pool.query(`UPDATE users SET looking_for_team = FALSE WHERE id = $1`, [req.session.userId]);
  } else {
    await pool.query(`UPDATE team_invitations SET status = 'declined' WHERE id = $1`, [invitation_id]);
  }

  res.redirect('/dashboard.html');
});
// Spieler aus Team entfernen (nur Team-Leader)
app.post('/kick-player', async (req, res) => {
  const { player_id, team_id } = req.body;
  const leaderId = req.session.userId;

  if (parseInt(player_id) === leaderId) return res.send('Du kannst dich nicht selbst entfernen.');

  const check = await pool.query(`SELECT * FROM teams WHERE id = $1 AND creator_id = $2`, [team_id, leaderId]);
  if (check.rows.length === 0) return res.send('Nicht berechtigt');

  await pool.query(
    `DELETE FROM team_requests WHERE player_id = $1 AND team_id = $2 AND status = 'accepted'`,
    [player_id, team_id]
  );

  res.redirect('/dashboard.html');
});

// Admin-Schutz
function isAdmin(req, res, next) {
  if (!req.session.userId) return res.redirect('/login.html');
  pool.query(`SELECT is_admin FROM users WHERE id = $1`, [req.session.userId])
    .then(result => {
      if (result.rows[0]?.is_admin) next();
      else res.status(403).send('Nicht erlaubt');
    });
}

// Admin-Seite anzeigen
app.get('/admin', isAdmin, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

// Nutzer anzeigen
app.get('/admin/users', isAdmin, async (req, res) => {
  const result = await pool.query(`SELECT id, username, is_admin FROM users`);
  res.json(result.rows);
});

// Nutzer löschen
app.post('/admin/delete-user', isAdmin, async (req, res) => {
  await pool.query(`DELETE FROM users WHERE id = $1`, [req.body.user_id]);
  res.redirect('/admin');
});

// Teams anzeigen
app.get('/admin/teams', isAdmin, async (req, res) => {
  const result = await pool.query(`SELECT * FROM teams`);
  res.json(result.rows);
});

// Team löschen
app.post('/admin/delete-team', isAdmin, async (req, res) => {
  const { team_id } = req.body;
  await pool.query(`DELETE FROM team_requests WHERE team_id = $1`, [team_id]);
  await pool.query(`DELETE FROM teams WHERE id = $1`, [team_id]);
  res.redirect('/admin');
});

// Server starten
app.listen(port, () => {
  console.log(`✅ Server läuft auf Port ${port}`);
});
