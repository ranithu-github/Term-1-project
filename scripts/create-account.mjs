// Prints the SQL that creates (or resets) an admin or developer account.
// These accounts can't be made through signup (it only accepts student index numbers).
// Run: node scripts/create-account.mjs
// Then paste the output into the Supabase SQL Editor. The password is hashed
// here the same way as lib/password.ts, so only the hash reaches the database.
import crypto from 'crypto';
import readline from 'readline';

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const lines = rl[Symbol.asyncIterator]();
const ask = async (prompt) => {
  process.stdout.write(prompt);
  return ((await lines.next()).value || '').trim();
};
const role = ((await ask('Role, admin or dev [admin]: ')) || 'admin').toLowerCase();
if (role !== 'admin' && role !== 'dev') throw new Error('Role must be admin or dev.');
const fallback = role === 'admin' ? 'admin-astrix' : 'DEV001';
const index = ((await ask(`Username [${fallback}]: `)) || fallback).toUpperCase();
const email = await ask('Email for password resets: ');
const password = await ask('Password (min 8 characters): ');
rl.close();

if (!email.includes('@')) throw new Error('Enter a valid email.');
if (password.length < 8) throw new Error('Password must be at least 8 characters.');

const salt = crypto.randomBytes(16).toString('hex');
const hash = `${salt}:${crypto.scryptSync(password, salt, 64).toString('hex')}`;
const q = (s) => `'${s.replace(/'/g, "''")}'`;

console.log(`
INSERT INTO public.users (index_no, username, email, password, is_verified, is_locked)
VALUES (${q(index)}, ${q(index.toLowerCase())}, ${q(email)}, ${q(hash)}, TRUE, FALSE)
ON CONFLICT (index_no) DO UPDATE
  SET email = EXCLUDED.email, password = EXCLUDED.password,
      is_verified = TRUE, is_locked = FALSE, updated_at = NOW();
`);
console.log(`Also add ${index} to ${role === 'admin' ? 'ADMIN_INDEXES' : 'DEV_INDEXES'} where the site is hosted, then redeploy.`);
