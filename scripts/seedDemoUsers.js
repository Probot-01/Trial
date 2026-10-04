'use strict';


const path = require('path');
const backendDir = path.resolve(__dirname, '..', 'central-system', 'backend');

const pool = require(path.join(backendDir, 'db', 'pgClient'));
const bcrypt = require(require.resolve('bcryptjs', { paths: [backendDir] }));

const BCRYPT_COST = 12;

const DEMO_USERS = [
  {
    email: 'ophthalmologist@demo.netrasetu.local',
    name: 'Dr. Demo Ophthalmologist',
    role: 'ophthalmologist',
    passwordEnv: 'DEMO_OPHTHALMOLOGIST_PASSWORD',
    fallback: 'DemoOphth-2026',
  },
  {
    email: 'admin@demo.netrasetu.local',
    name: 'Demo District Admin',
    role: 'district_admin',
    passwordEnv: 'DEMO_ADMIN_PASSWORD',
    fallback: 'DemoAdmin-2026',
  },
];

async function run() {
  const production = process.env.NODE_ENV === 'production';
  try {
    for (const u of DEMO_USERS) {
      const fromEnv = process.env[u.passwordEnv];
      if (!fromEnv && production) {
        throw new Error(`${u.passwordEnv} must be set when NODE_ENV=production; ` +
          'refusing to create an account with the published demo password.');
      }
      const password = fromEnv || u.fallback;
      const hash = await bcrypt.hash(password, BCRYPT_COST);

      const { rows } = await pool.query(`
        INSERT INTO users (email, name, role, password_hash)
        VALUES ($1, $2, $3, $4)
        ON CONFLICT (email) DO UPDATE
          SET name = EXCLUDED.name, role = EXCLUDED.role,
              password_hash = EXCLUDED.password_hash,
              -- Re-seeding also REACTIVATES: a demo account someone
              -- deactivated (migration 0012) should come back with its id, its
              -- reviews and its access-log history intact.
              is_active = true, deactivated_at = NULL
        RETURNING user_id, (xmax = 0) AS inserted
      `, [u.email, u.name, u.role, hash]);

      console.log(`[seedDemoUsers] ${rows[0].inserted ? 'created' : 'reset  '}  ` +
        `${u.role.padEnd(16)} ${u.email}  (${fromEnv ? `password from ${u.passwordEnv}` : 'documented demo password'})`);
    }
  } catch (err) {
    console.error('[seedDemoUsers] FAILED:', err.message);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

run();
