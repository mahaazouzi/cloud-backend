const express = require('express');
const cors = require('cors');
const mysql = require('mysql2');
const axios = require('axios');
const os = require('os');
require('dotenv').config();

const app = express();
const port = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// Load from process.env, or fall back to your RDS values
const {
  DB_HOST     = 'database.caupwffxgvne.us-east-1.rds.amazonaws.com',
  DB_USER     = 'admin',
  DB_PASSWORD = 'M4hAZ00z1',
  DB_NAME     = 'appdb',
} = process.env;

// Step 1: connect without specifying a database
const adminConn = mysql.createConnection({
  host: DB_HOST,
  user: DB_USER,
  password: DB_PASSWORD,
  multipleStatements: true
});

adminConn.connect(err => {
  if (err) {
    console.error('❌ Error connecting to MySQL server:', err);
    process.exit(1);
  }
  console.log('Connected to MySQL server (no DB selected)');

  // Step 2: create the database if it doesn't exist
  adminConn.query(
    `CREATE DATABASE IF NOT EXISTS \`${DB_NAME}\`;`,
    err => {
      if (err) {
        console.error('❌ Error creating database:', err);
        process.exit(1);
      }
      console.log(`✅ Database "${DB_NAME}" is present`);

      // Close the admin connection and move on:
      adminConn.end(createAppConnection);
    }
  );
});

// Step 3: after DB is ensured, connect into it and bootstrap schema & data
function createAppConnection() {
  const db = mysql.createConnection({
    host: DB_HOST,
    user: DB_USER,
    password: DB_PASSWORD,
    database: DB_NAME,
    multipleStatements: true
  });

  db.connect(err => {
    if (err) {
      console.error('❌ Error connecting to the database:', err);
      process.exit(1);
    }
    console.log(`Connected to MySQL database "${DB_NAME}"`);

    const createTableQuery = `
      CREATE TABLE IF NOT EXISTS users (
        id INT AUTO_INCREMENT PRIMARY KEY,
        name VARCHAR(100) NOT NULL,
        email VARCHAR(100) NOT NULL UNIQUE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `;
    const insertUsersQuery = `
      INSERT IGNORE INTO users (name, email) VALUES
      ('John Doe', 'john@example.com'),
      ('Jane Smith', 'jane@example.com'),
      ('Bob Johnson', 'bob@example.com');
    `;

    db.query(createTableQuery, err => {
      if (err) console.error('❌ Error creating table:', err);
      else console.log('✅ Users table ready');

      db.query(insertUsersQuery, err => {
        if (err) console.error('❌ Error inserting users:', err);
        else console.log('✅ Sample users inserted');

        // Now that schema + seed are done, start the server:
        startServer(db);
      });
    });
  });
}

// Step 4: define routes, passing the live `db` connection
function startServer(db) {
  app.get('/server-info', async (req, res) => {
    try {
      let instanceId = 'unknown';
      let availabilityZone = 'unknown';
      try {
        const idRes = await axios.get('http://169.254.169.254/latest/meta-data/instance-id');
        instanceId = idRes.data;
        const zoneRes = await axios.get('http://169.254.169.254/latest/meta-data/placement/availability-zone');
        availabilityZone = zoneRes.data;
      } catch {
        console.log('Not running on EC2 or metadata unavailable');
      }

      res.json({
        instanceId,
        availabilityZone,
        hostname: os.hostname(),
        timestamp: new Date().toISOString()
      });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Failed to get server info' });
    }
  });

  app.get('/', (req, res) =>
    res.status(200).json('Hello from Backend app!')
  );

  app.get('/api/users', (req, res) => {
    db.query('SELECT * FROM users', (err, results) => {
      if (err) {
        console.error(err);
        return res.status(500).json({ error: 'Database error' });
      }
      res.json(results);
    });
  });

  app.get('/api/users/:id', (req, res) => {
    db.query(
      'SELECT * FROM users WHERE id = ?',
      [req.params.id],
      (err, results) => {
        if (err) return res.status(500).json({ error: 'Database error' });
        if (!results.length) return res.status(404).json({ error: 'User not found' });
        res.json(results[0]);
      }
    );
  });

  app.post('/api/users', (req, res) => {
    const { name, email } = req.body;
    if (!name || !email) return res.status(400).json({ error: 'Name and email are required' });

    db.query(
      'INSERT INTO users (name, email) VALUES (?, ?)',
      [name, email],
      (err, result) => {
        if (err) return res.status(500).json({ error: 'Database error' });
        res.status(201).json({ id: result.insertId, name, email });
      }
    );
  });

  app.put('/api/users/:id', (req, res) => {
    const { name, email } = req.body;
    if (!name || !email) return res.status(400).json({ error: 'Name and email are required' });

    db.query(
      'UPDATE users SET name = ?, email = ? WHERE id = ?',
      [name, email, req.params.id],
      (err, result) => {
        if (err) return res.status(500).json({ error: 'Database error' });
        if (!result.affectedRows) return res.status(404).json({ error: 'User not found' });
        res.json({ id: req.params.id, name, email });
      }
    );
  });

  app.delete('/api/users/:id', (req, res) => {
    db.query(
      'DELETE FROM users WHERE id = ?',
      [req.params.id],
      (err, result) => {
        if (err) return res.status(500).json({ error: 'Database error' });
        if (!result.affectedRows) return res.status(404).json({ error: 'User not found' });
        res.status(204).send();
      }
    );
  });

  // Start HTTP server
  const server = app.listen(port, () => {
    console.log(`Server running on port ${port}`);
  });

  process.on('SIGTERM', () => {
    console.log('SIGTERM received: shutting down gracefully');
    server.close(() => {
      db.end(() => {
        console.log('DB connection closed, exiting.');
        process.exit(0);
      });
    });
  });
}
