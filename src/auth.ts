import { createHash, randomBytes, randomUUID, scryptSync, timingSafeEqual } from 'node:crypto';
import { Router } from 'express';
import type { Request, Response } from 'express';
import { pool } from './db.js';
import { ApiError, asObject, asText, send } from './http.js';
import { allAreas, publicConfig } from './public.js';
import { deliverOtp } from './otp-delivery.js';

const phonePattern = /^(?:\+20|20|0)1[0125]\d{8}$/;
export const normalizePhone = (value: string): string => {
  const compact = value.replace(/\s/g, '');
  if (!phonePattern.test(compact)) throw new ApiError(400, 'VALIDATION_FAILED', 'Enter an Egyptian mobile number');
  return compact.replace(/^(?:\+20|20|0)/, '+20');
};
export const hashToken = (value: string): string => createHash('sha256').update(value).digest('hex');
export const hashPassword = (value: string): string => {
  const salt = randomBytes(16).toString('hex');
  return `${salt}:${scryptSync(value, salt, 64).toString('hex')}`;
};
export const passwordMatches = (value: string, stored: string): boolean => {
  const [salt, encoded] = stored.split(':');
  if (!salt || !encoded || !/^[0-9a-f]+$/i.test(encoded)) return false;
  const expected = Buffer.from(encoded, 'hex');
  return timingSafeEqual(expected, scryptSync(value, salt, expected.length));
};
export const validCustomerPassword = (value: string): boolean => value.length >= 8 && value.length <= 128 && /[a-z]/.test(value) && /[A-Z]/.test(value) && /\d/.test(value) && /[^A-Za-z0-9]/.test(value);
export const validAdminPassword = (value: string): boolean => value.length >= 12 && value.length <= 128 && /[a-z]/.test(value) && /[A-Z]/.test(value) && /\d/.test(value) && /[^A-Za-z0-9]/.test(value);

const cookie = (req: Request): string => /(?:^|;\s*)souk_session=([^;]+)/.exec(req.headers.cookie ?? '')?.[1] ?? '';
const cookieOptions = (req: Request) => ({ httpOnly: true, sameSite: 'lax' as const, secure: process.env['NODE_ENV'] === 'production' || req.secure || req.header('x-forwarded-proto') === 'https', path: '/' });
type CustomerRow = { id: string; phone_e164: string; password_hash: string | null; name: string; email: string | null; age: number | null; city_area_id: string | null; city_name: string | null };
export type Customer = { id: string; phone: string; name: string; email: string; age: number; city: string };
const userView = (row: CustomerRow): Customer => ({ id: row.id, phone: row.phone_e164, name: row.name, email: row.email ?? '', age: row.age ?? 0, city: row.city_name ?? '' });
const customerSql = `SELECT c.*,a.name_ar AS city_name FROM customers c LEFT JOIN delivery_areas a ON a.id=c.city_area_id`;
export async function customerFromRequest(req: Request): Promise<Customer | null> {
  const token = cookie(req); if (!token) return null;
  const result = await pool.query<CustomerRow>(`${customerSql} JOIN customer_sessions s ON s.customer_id=c.id WHERE s.token_hash=$1 AND s.expires_at>now() AND s.revoked_at IS NULL`, [hashToken(token)]);
  return result.rows[0] ? userView(result.rows[0]) : null;
}
export async function requireCustomer(req: Request): Promise<Customer> {
  const user = await customerFromRequest(req);
  if (!user) throw new ApiError(401, 'UNAUTHENTICATED', 'Sign in first');
  return user;
}
async function signIn(req: Request, res: Response, user: Customer): Promise<void> {
  const token = randomBytes(32).toString('base64url');
  await pool.query(`INSERT INTO customer_sessions(token_hash,customer_id,expires_at) VALUES($1,$2,now()+interval '30 days')`, [hashToken(token), user.id]);
  res.cookie('souk_session', token, { ...cookieOptions(req), maxAge: 30 * 86400000 });
  send(res, { user });
}
async function areaForCity(value: string): Promise<{ id: string; name: string }> {
  const area = (await allAreas()).find(item => item.isActive && [item.id,item.name,item.nameEn].some(name => name.toLocaleLowerCase() === value.toLocaleLowerCase()));
  if (!area) throw new ApiError(400, 'AREA_NOT_SERVED', 'Choose a delivery city');
  return area;
}
function profileFields(body: unknown): { name: string; email: string; age: number; city: string } {
  const value = asObject(body), name = asText(value['name'], 100), email = asText(value['email'], 200).toLowerCase(), age = Number(value['age']), city = asText(value['city'], 100);
  if (name.length < 2 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || !Number.isInteger(age) || age < 18 || age > 120 || !city) throw new ApiError(400, 'VALIDATION_FAILED', 'Complete valid personal details');
  return { name, email, age, city };
}
async function ensureAccountsEnabled(): Promise<void> {
  const config = await publicConfig();
  if (asObject(config['commerce'])['authMode'] === 'guest') throw new ApiError(403, 'FORBIDDEN', 'Accounts are disabled');
}
async function limitAction(subject: string, action: string, max: number, minutes: number): Promise<void> {
  const result = await pool.query<{ count: number }>(`INSERT INTO auth_attempts(subject_key,action,window_start,count)
    VALUES($1,$2,date_trunc('minute',now()) - (extract(minute from now())::int % $3) * interval '1 minute',1)
    ON CONFLICT(subject_key,action,window_start) DO UPDATE SET count=auth_attempts.count+1 RETURNING count`, [subject, action, minutes]);
  if ((result.rows[0]?.count ?? 0) > max) throw new ApiError(429, 'RATE_LIMITED', 'Try again later');
}
export const authRouter = Router();
authRouter.post('/auth/otp/request', async (req,res) => {
  await ensureAccountsEnabled();
  const phone = normalizePhone(asText(req.body?.phone, 30)), purpose = req.body?.purpose === 'register' ? 'register' : 'login';
  const existing = await pool.query('SELECT id FROM customers WHERE phone_e164=$1', [phone]);
  if (purpose === 'register' && existing.rowCount) throw new ApiError(409, 'ALREADY_REGISTERED', 'This phone is already registered');
  if (purpose === 'login' && !existing.rowCount) throw new ApiError(401, 'UNAUTHENTICATED', 'Account not found');
  await limitAction(phone, `otp:${purpose}`, 5, 15);
  const recent = await pool.query('SELECT id FROM otp_challenges WHERE phone_e164=$1 AND purpose=$2 AND created_at>now()-interval \'60 seconds\' LIMIT 1', [phone,purpose]);
  if (recent.rowCount) throw new ApiError(429, 'OTP_RATE_LIMITED', 'Wait before requesting another code');
  const code = await deliverOtp(phone), id = randomUUID();
  await pool.query(`INSERT INTO otp_challenges(id,phone_e164,purpose,code_hash,expires_at,resend_after) VALUES($1,$2,$3,$4,now()+interval '5 minutes',now()+interval '60 seconds')`, [id,phone,purpose,hashToken(`${id}:${code}`)]);
  send(res,{requestId:id,expiresInSec:300,resendAfterSec:60});
});
authRouter.post('/auth/otp/verify', async (req,res) => {
  const id = asText(req.body?.requestId,100), code = asText(req.body?.code,20);
  const client=await pool.connect();
  let challenge:{phone_e164:string;purpose:string;code_hash:string;attempts:number;expires_at:Date;consumed_at:Date|null}|undefined;
  let registrationToken:string|undefined;
  let invalid=false;
  try {
    await client.query('BEGIN');
    const result=await client.query<{phone_e164:string;purpose:string;code_hash:string;attempts:number;expires_at:Date;consumed_at:Date|null}>('SELECT * FROM otp_challenges WHERE id=$1 FOR UPDATE',[id]);
    challenge=result.rows[0];
    if (!challenge || challenge.consumed_at || challenge.expires_at.getTime()<Date.now()) throw new ApiError(400,'OTP_EXPIRED','Code expired; request another');
    if (challenge.attempts>=5) throw new ApiError(429,'OTP_RATE_LIMITED','Too many attempts');
    invalid=hashToken(`${id}:${code}`)!==challenge.code_hash;
    await client.query('UPDATE otp_challenges SET attempts=attempts+1,consumed_at=CASE WHEN $2 THEN consumed_at ELSE now() END WHERE id=$1',[id,invalid]);
    if(!invalid && challenge.purpose==='register'){
      registrationToken=randomBytes(32).toString('base64url');
      await client.query("INSERT INTO registration_tokens(token_hash,phone_e164,expires_at) VALUES($1,$2,now()+interval '10 minutes')",[hashToken(registrationToken),challenge.phone_e164]);
    }
    await client.query('COMMIT');
  }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
  if(invalid) throw new ApiError(400,'OTP_INVALID','Incorrect code');
  if(!challenge) throw new ApiError(400,'OTP_EXPIRED','Code expired; request another');
  if (challenge.purpose === 'register') {
    send(res,{registrationToken}); return;
  }
  const user = await pool.query<CustomerRow>(`${customerSql} WHERE c.phone_e164=$1`,[challenge.phone_e164]);
  if (!user.rows[0]) throw new ApiError(401,'UNAUTHENTICATED','Account not found');
  await signIn(req,res,userView(user.rows[0]));
});
authRouter.post('/auth/register', async (req,res) => {
  await ensureAccountsEnabled();
  const token = asText(req.body?.registrationToken,200), password = String(req.body?.password ?? '');
  if (!validCustomerPassword(password)) throw new ApiError(400,'VALIDATION_FAILED','Password needs 8+ characters, upper/lowercase, number and symbol');
  const fields = profileFields(req.body), area = await areaForCity(fields.city);
  const client=await pool.connect();let created:CustomerRow|undefined;
  try{
    await client.query('BEGIN');
    const pending=await client.query<{phone_e164:string}>('SELECT phone_e164 FROM registration_tokens WHERE token_hash=$1 AND expires_at>now() AND consumed_at IS NULL FOR UPDATE',[hashToken(token)]);
    if(!pending.rows[0]) throw new ApiError(400,'OTP_EXPIRED','Verification expired');
    const result=await client.query<CustomerRow>(`INSERT INTO customers(phone_e164,password_hash,name,email,age,city_area_id) VALUES($1,$2,$3,$4,$5,$6) RETURNING *, $7::text AS city_name`,[pending.rows[0].phone_e164,hashPassword(password),fields.name,fields.email,fields.age,area.id,area.name]);
    created=result.rows[0];
    await client.query('UPDATE registration_tokens SET consumed_at=now() WHERE token_hash=$1',[hashToken(token)]);
    await client.query('COMMIT');
  }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
  if(!created) throw new ApiError(500,'INTERNAL_ERROR','Registration failed');
  await signIn(req,res,userView(created));
});
authRouter.post('/auth/login', async (req,res) => {
  await ensureAccountsEnabled();
  const phone = normalizePhone(asText(req.body?.phone,30));
  await limitAction(phone,'password_login',5,15);
  const result = await pool.query<CustomerRow>(`${customerSql} WHERE c.phone_e164=$1`,[phone]);
  const user = result.rows[0];
  if (!user?.password_hash || !passwordMatches(String(req.body?.password ?? ''),user.password_hash)) throw new ApiError(401,'UNAUTHENTICATED','Invalid phone or password');
  await signIn(req,res,userView(user));
});
authRouter.post('/auth/refresh', async (req,res) => { await requireCustomer(req); send(res,{ok:true}); });
authRouter.post('/auth/logout', async (req,res) => {
  const token=cookie(req);
  if(token) await pool.query('UPDATE customer_sessions SET revoked_at=now() WHERE token_hash=$1',[hashToken(token)]);
  res.clearCookie('souk_session',cookieOptions(req)); send(res,{ok:true});
});
authRouter.get('/me', async (req,res) => send(res,await requireCustomer(req)));
authRouter.patch('/me', async (req,res) => {
  const user=await requireCustomer(req), fields=profileFields({...user,...asObject(req.body)}), area=await areaForCity(fields.city);
  const updated=await pool.query<CustomerRow>(`UPDATE customers SET name=$2,email=$3,age=$4,city_area_id=$5,updated_at=now() WHERE id=$1 RETURNING *, $6::text AS city_name`,[user.id,fields.name,fields.email,fields.age,area.id,area.name]);
  send(res,userView(updated.rows[0]!));
});
type AddressRow={id:string;area_id:string;street:string;building:string;floor:string|null;apartment:string|null;landmark:string|null;is_default:boolean};
const addressView=(row:AddressRow)=>({id:row.id,areaId:row.area_id,street:row.street,building:row.building,floor:row.floor??'',apartment:row.apartment??'',landmark:row.landmark??'',isDefault:row.is_default});
authRouter.get('/me/addresses', async (req,res) => {
  const user=await requireCustomer(req), rows=await pool.query<AddressRow>('SELECT * FROM saved_addresses WHERE customer_id=$1 ORDER BY is_default DESC,created_at',[user.id]);
  send(res,rows.rows.map(addressView));
});
authRouter.post('/me/addresses', async (req,res) => {
  const user=await requireCustomer(req), body=asObject(req.body), area=await areaForCity(asText(body['areaId'])), street=asText(body['street'],200),building=asText(body['building'],80);
  if(!street||!building) throw new ApiError(400,'VALIDATION_FAILED','Complete the address');
  const client=await pool.connect();
  try {await client.query('BEGIN');await client.query('SELECT id FROM customers WHERE id=$1 FOR UPDATE',[user.id]);
    const count=await client.query<{count:string}>('SELECT count(*) FROM saved_addresses WHERE customer_id=$1',[user.id]);
    const makeDefault=Number(count.rows[0]?.count)===0 || body['isDefault']===true;
    if(makeDefault) await client.query('UPDATE saved_addresses SET is_default=false WHERE customer_id=$1',[user.id]);
    const result=await client.query<AddressRow>(`INSERT INTO saved_addresses(customer_id,area_id,street,building,floor,apartment,landmark,is_default) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,[user.id,area.id,street,building,asText(body['floor'])||null,asText(body['apartment'])||null,asText(body['landmark'])||null,makeDefault]);
    await client.query('COMMIT');send(res,addressView(result.rows[0]!));
  }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
});
authRouter.patch('/me/addresses/:id', async (req,res) => {
  const user=await requireCustomer(req), current=await pool.query<AddressRow>('SELECT * FROM saved_addresses WHERE id=$1 AND customer_id=$2',[req.params['id'],user.id]);
  if(!current.rows[0]) throw new ApiError(404,'NOT_FOUND','Address not found');
  const body=asObject(req.body), next={...addressView(current.rows[0]),...body};
  const area=await areaForCity(asText(next['areaId'])),street=asText(next['street'],200),building=asText(next['building'],80);
  if(!street||!building) throw new ApiError(400,'VALIDATION_FAILED','Complete the address');
  const client=await pool.connect();
  try{await client.query('BEGIN');await client.query('SELECT id FROM customers WHERE id=$1 FOR UPDATE',[user.id]);
    if(next['isDefault']===true) await client.query('UPDATE saved_addresses SET is_default=false WHERE customer_id=$1',[user.id]);
    const result=await client.query<AddressRow>(`UPDATE saved_addresses SET area_id=$3,street=$4,building=$5,floor=$6,apartment=$7,landmark=$8,is_default=$9,updated_at=now() WHERE id=$1 AND customer_id=$2 RETURNING *`,[req.params['id'],user.id,area.id,street,building,asText(next['floor'])||null,asText(next['apartment'])||null,asText(next['landmark'])||null,next['isDefault']===true]);
    if(!result.rows[0]) throw new ApiError(404,'NOT_FOUND','Address not found');
    await client.query('COMMIT');send(res,addressView(result.rows[0]));
  }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
});
authRouter.delete('/me/addresses/:id', async (req,res) => {
  const user=await requireCustomer(req),client=await pool.connect();
  try{await client.query('BEGIN');await client.query('SELECT id FROM customers WHERE id=$1 FOR UPDATE',[user.id]);
    const deleted=await client.query<AddressRow>('DELETE FROM saved_addresses WHERE id=$1 AND customer_id=$2 RETURNING *',[req.params['id'],user.id]);
    if(!deleted.rows[0]) throw new ApiError(404,'NOT_FOUND','Address not found');
    if(deleted.rows[0].is_default) await client.query(`UPDATE saved_addresses SET is_default=true WHERE id=(SELECT id FROM saved_addresses WHERE customer_id=$1 ORDER BY created_at LIMIT 1)`,[user.id]);
    await client.query('COMMIT');send(res,{ok:true});
  }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
});
