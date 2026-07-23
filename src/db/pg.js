import '../config/load-env.js';
import pg from 'pg';

const { Pool } = pg;

// Use Neon PostgreSQL string or fallback to local postgres
const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:5432/stayez',
  ssl: process.env.DATABASE_URL && process.env.DATABASE_URL.includes('neon.tech') ? true : false,
});

/**
 * Helper to run a query with parameters
 */
export const query = async (text, params) => {
  const start = Date.now();
  try {
    const res = await pool.query(text, params);
    const duration = Date.now() - start;
    console.log('Executed query', { text, duration, rows: res.rowCount });
    return res;
  } catch (err) {
    console.error('Error executing query', { text, err });
    throw err;
  }
};

/**
 * Get a client from the pool (useful for transactions)
 */
export const getClient = async () => {
  const client = await pool.connect();
  const query = client.query.bind(client);
  const release = client.release.bind(client);
  
  // monkey patch the query method to keep track of the last query executed
  client.query = (...args) => {
    client.lastQuery = args;
    return query(...args);
  };
  
  client.release = () => {
    // clear our workaround
    client.query = query;
    client.release = release;
    return release();
  };
  
  return client;
};

export { pool };
