
import React, { createContext, useContext, useEffect, useState, ReactNode } from 'react';
import { kvGet, kvSet } from '../db/database';
import { secretGet, secretSet } from '../lib/secrets';
import { getPairing } from '../peer/pairing';
import { peerCall, PeerError } from '../peer/peerClient';
import { setPeerToken } from '../peer/replicate';
import { forgetCredentials, rememberCredentials, verifyOffline } from './offlineCredentials';

export interface Session {
  username: string;
  name: string;
  roleTitle: string;
  loggedInAt: string;
  /** Where the password was checked. */
  via: 'pc' | 'offline' | 'dev';
}

interface Account { username: string; password: string; name: string }

const IS_DEV = typeof __DEV__ !== 'undefined' ? __DEV__ : process.env.NODE_ENV !== 'production';

function devAccounts(): Account[] {
  if (!IS_DEV && !process.env.EXPO_PUBLIC_TECHNICIANS) return [];
  const raw: string = process.env.EXPO_PUBLIC_TECHNICIANS ?? 'technician:tech123:Demo Technician';
  return raw.split(',').map((entry: string): Account => {
    const [username, password, ...name] = entry.trim().split(':');
    return { username: username?.toLowerCase() ?? '', password: password ?? '', name: name.join(':') || username };
  }).filter((a: Account) => a.username && a.password);
}

export const DEMO_HINT = IS_DEV && !process.env.EXPO_PUBLIC_TECHNICIANS ? 'technician / tech123 (dev build, before pairing)' : null;

export type LoginResult =
  | { ok: true }
  | { ok: false; reason: 'invalid' | 'needs_pc' | 'locked' | 'error'; message: string };

interface AuthValue {
  session: Session | null;
  ready: boolean;
  login: (username: string, password: string) => Promise<LoginResult>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthValue | undefined>(undefined);
const KEY = 'session';
const TOKEN_KEY = 'peer_token';

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const v = await kvGet(KEY);
        if (v) setSession(JSON.parse(v));
        setPeerToken(await secretGet(TOKEN_KEY));
      } catch { /* start logged out */ }
      setReady(true);
    })();
  }, []);

  const start = async (s: Session, token: string | null) => {
    await kvSet(KEY, JSON.stringify(s));
    await secretSet(TOKEN_KEY, token);
    setPeerToken(token);
    setSession(s);
  };

  const login = async (usernameRaw: string, password: string): Promise<LoginResult> => {
    const username = usernameRaw.trim().toLowerCase();
    const paired = !!(await getPairing());
    const now = new Date().toISOString();

    if (paired) {
      try {
        const r = await peerCall<{ token: string; user: { userId: string; username: string; name: string; role: string } }>(
          '/peer/login', { username, password });
        await rememberCredentials(r.user, password);
        await start({ username: r.user.username, name: r.user.name, roleTitle: r.user.role === 'phc_admin' ? 'PHC ADMIN' : 'PHC TECHNICIAN', loggedInAt: now, via: 'pc' }, r.token);
        return { ok: true };
      } catch (err) {
        const e = err as PeerError;
        if (e?.code === 'invalid_credentials') {
          await forgetCredentials(username);
          return { ok: false, reason: 'invalid', message: 'Username or password is incorrect.' };
        }
        if (e?.code === 'too_many_attempts') return { ok: false, reason: 'locked', message: e.message };
        if (!(e instanceof PeerError) || !e.unreachable) {
          return { ok: false, reason: 'error', message: e?.message ?? String(err) };
        }
        // PC off or out of reach: fall through to the offline verifier.
      }
    }

    const offline = await verifyOffline(username, password);
    if (offline && offline !== 'no_cached') {
      await start({ username: offline.username, name: offline.name, roleTitle: offline.role === 'phc_admin' ? 'PHC ADMIN' : 'PHC TECHNICIAN', loggedInAt: now, via: 'offline' }, await secretGet(TOKEN_KEY));
      return { ok: true };
    }
    if (offline === null) return { ok: false, reason: 'invalid', message: 'Username or password is incorrect.' };

    if (!paired) {
      const acct = devAccounts().find((a) => a.username === username && a.password === password);
      if (acct) {
        await start({ username: acct.username, name: acct.name, roleTitle: 'PHC TECHNICIAN', loggedInAt: now, via: 'dev' }, null);
        return { ok: true };
      }
      return { ok: false, reason: 'needs_pc', message: 'Pair this phone with the PHC PC first; your account is on the PC.' };
    }
    return { ok: false, reason: 'needs_pc', message: 'First login on this phone needs the PHC PC. Connect to its Wi-Fi and try again.' };
  };

  // Logging out must work with the PC off, so it only forgets the token
  // locally; the PC-side session expires on its own (LOCAL_SESSION_HOURS).
  const logout = async () => {
    await kvSet(KEY, null);
    await secretSet(TOKEN_KEY, null);
    setPeerToken(null);
    setSession(null);
  };

  return <AuthContext.Provider value={{ session, ready, login, logout }}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
