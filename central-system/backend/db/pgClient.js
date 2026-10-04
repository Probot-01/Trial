'use strict';



const { Pool } = require('pg');

require('../loadEnv');

const POOL_TUNING = {
  max: 10,                        // conservative for a single-node central server
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
};

let config;

if (process.env.DATABASE_URL) {
  config = { connectionString: process.env.DATABASE_URL, ...POOL_TUNING };
} else {
  if (!process.env.PGPASSWORD) {
    console.warn(
      '[pgClient] Neither DATABASE_URL nor PGPASSWORD is set. Connecting with an ' +
      'empty password, which will almost certainly fail.\n' +
      '           Set DATABASE_URL (see central-system/backend/.env.example), e.g. the dev DB:\n' +
      '             postgresql://netrasetu:<password>@localhost:5433/dr_screening_central'
    );
  }

  config = {
    host: process.env.PGHOST || 'localhost',
    port: parseInt(process.env.PGPORT || '5433', 10),
    database: process.env.PGDATABASE || 'dr_screening_central',
    user: process.env.PGUSER || 'netrasetu',
    password: process.env.PGPASSWORD || '',
    ...POOL_TUNING,
  };
}

const pool = new Pool(config);

pool.on('error', (err) => {
  console.error('[pgClient] Unexpected error on idle client:', err.message);
});

module.exports = pool;
