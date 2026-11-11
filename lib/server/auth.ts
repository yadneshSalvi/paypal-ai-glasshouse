import { randomBytes, randomUUID, createHash } from 'node:crypto';
import type { Actor, Role } from '@/packages/domain/types';
import { database } from '@/packages/db/client';
import { HttpError, sameOrigin } from './errors';
import { ensurePaymentsSchema } from './payments/schema';

const COOKIE = process.env.GLASSHOUSE_SESSION_COOKIE&&/^[a-z][a-z0-9_]{0,60}$/.test(process.env.GLASSHOUSE_SESSION_COOKIE)?process.env.GLASSHOUSE_SESSION_COOKIE:'glasshouse_session';
const digest = (token: string) => createHash('sha256').update(token).digest('hex');
/** Agent jobs retain the exact authenticated session hash, never the cookie token. */
export function authenticatedSessionHash(request:Request){
  const token=request.headers.get('cookie')?.split(';').map(part=>part.trim()).find(part=>part.startsWith(COOKIE+'='))?.slice(COOKIE.length+1);
  if(!token||!/^[a-f0-9]{64}$/.test(token))throw new HttpError(401,'SESSION_REQUIRED','Start an investigation session to continue.');
  return digest(token);
}
export async function actor(request: Request): Promise<Actor> {
  const token = request.headers.get('cookie')?.split(';').map(p => p.trim()).find(p => p.startsWith(COOKIE + '='))?.slice(COOKIE.length + 1);
  if (!token || !/^[a-f0-9]{64}$/.test(token)) throw new HttpError(401, 'SESSION_REQUIRED', 'Start an investigation session to continue.');
  const db = await database();
  const rows = await db.query<{ actor: Actor }>('SELECT actor FROM gh_sessions WHERE token_hash=$1 AND expires_at > now()', [digest(token)]);
  if (!rows[0]) throw new HttpError(401, 'SESSION_EXPIRED', 'Your session expired. Start a new investigation session.');
  const saved = rows[0].actor;
  await ensurePaymentsSchema(db);
  // Only a valid server-issued session may bootstrap membership. Existing revocations win.
  await db.query('INSERT INTO gh_memberships(tenant_id,actor_id,role,version) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING', [saved.tenantId,saved.id,saved.role,saved.membershipVersion]);
  const members = await db.query<{role: Role; version: number; active: boolean}>('SELECT role,version,active FROM gh_memberships WHERE tenant_id=$1 AND actor_id=$2', [saved.tenantId,saved.id]);
  if (!members[0]?.active) throw new HttpError(403, 'MEMBERSHIP_REVOKED', 'This workspace membership is no longer active.');
  return {...saved,role:members[0].role,membershipVersion:members[0].version};
}
export function requireRole(value: Actor, roles: Role[]) {
  if (!roles.includes(value.role)) throw new HttpError(403, 'AUTHORITY_DENIED', 'This role cannot authorize financial actions. Send a proposal to the recovery planner.');
}
export async function startSession(request: Request): Promise<{ actor: Actor; cookie?: string }> {
  sameOrigin(request);
  try { return { actor: await actor(request) }; } catch (error) { if (!(error instanceof HttpError) || error.status !== 401) throw error; }
  const token = randomBytes(32).toString('hex');
  const id = randomUUID();
  const value: Actor = { id: 'judge-' + id.slice(0, 8), tenantId: 'fernwood-' + id, role: 'judge', membershipVersion: 1, grantId: 'sample-' + id };
  const db = await database();
  await ensurePaymentsSchema(db);
  await db.query('INSERT INTO gh_sessions (token_hash,actor,expires_at) VALUES ($1,$2::jsonb,now()+interval \'7 days\')', [digest(token), JSON.stringify(value)]);
  await db.query('INSERT INTO gh_memberships(tenant_id,actor_id,role,version) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING', [value.tenantId,value.id,value.role,value.membershipVersion]);
  return { actor: value, cookie: `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=604800${new URL(request.url).protocol === 'https:' ? '; Secure' : ''}` };
}
