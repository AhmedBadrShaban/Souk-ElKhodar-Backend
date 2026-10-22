import { randomBytes } from 'node:crypto';
import { Router } from 'express';
import type { Request, RequestHandler } from 'express';
import { pool } from './db.js';
import { ApiError, asText, send } from './http.js';
import { hashToken, passwordMatches } from './auth.js';

export const permissions = ['dashboard.read','products.read','products.write','categories.read','categories.write','areas.read','areas.write','orders.read','orders.write','settings.read','settings.write','content.read','content.write','announcements.read','announcements.write','roles.read','roles.write','users.read','users.write','audit.read','customers.read','contacts.read','contacts.write'] as const;
export type Permission = typeof permissions[number];
type AdminRow = { id:string; name:string; email:string; active:boolean; password_hash:string; role_ids:string[]; permissions:string[] };
const adminSql = `SELECT u.*, COALESCE((SELECT array_agg(r.id::text) FROM admin_user_roles ur JOIN admin_roles r ON r.id=ur.role_id WHERE ur.admin_user_id=u.id),ARRAY[]::text[]) role_ids, COALESCE((SELECT array_agg(DISTINCT p.permission_key) FROM admin_user_roles ur JOIN admin_role_permissions p ON p.role_id=ur.role_id WHERE ur.admin_user_id=u.id),ARRAY[]::text[]) permissions FROM admin_users u`;
const view=(row:AdminRow)=>({id:row.id,name:row.name,email:row.email,active:row.active,roleIds:row.role_ids});
export async function adminFromRequest(req:Request):Promise<AdminRow|null>{
  const token=/^Bearer ([A-Za-z0-9_-]+)$/.exec(req.header('authorization')??'')?.[1];
  if(!token) return null;
  const result=await pool.query<AdminRow>(`${adminSql} JOIN admin_sessions s ON s.admin_user_id=u.id WHERE s.token_hash=$1 AND s.expires_at>now() AND s.revoked_at IS NULL AND u.active=true`,[hashToken(token)]);
  return result.rows[0]??null;
}
export async function requireAdmin(req:Request,permission?:Permission):Promise<AdminRow>{
  const user=await adminFromRequest(req);
  if(!user) throw new ApiError(401,'UNAUTHENTICATED','Sign in to the dashboard');
  if(permission && !user.permissions.includes(permission)) throw new ApiError(403,'FORBIDDEN',`Missing ${permission}`);
  return user;
}
export const authorize=(permission:Permission):RequestHandler=>(req,_res,next)=>{requireAdmin(req,permission).then(()=>next(),next);};
export async function audit(req:Request,actorId:string,action:string,targetType:string,targetId?:string,summary?:unknown):Promise<void>{
  await pool.query('INSERT INTO audit_entries(admin_user_id,action,target_type,target_id,request_id,change_summary) VALUES($1,$2,$3,$4,$5,$6)',[actorId,action,targetType,targetId??null,req.res?.locals['requestId']??null,summary===undefined?null:JSON.stringify(summary)]);
}
export const adminAuthRouter=Router();
adminAuthRouter.post('/auth/login',async(req,res)=>{
  const email=asText(req.body?.email,160).toLowerCase(),password=String(req.body?.password??'');
  const attempts=await pool.query<{count:number}>("SELECT count FROM auth_attempts WHERE subject_key=$1 AND action='admin.login' AND window_start=date_trunc('hour',now())",[email]);
  if((attempts.rows[0]?.count??0)>=20) throw new ApiError(429,'RATE_LIMITED','Try again later');
  const result=await pool.query<AdminRow>(`${adminSql} WHERE lower(u.email)=$1 AND u.active=true`,[email]);
  const user=result.rows[0];
  if(!user || !passwordMatches(password,user.password_hash)) {
    await pool.query("INSERT INTO auth_attempts(subject_key,action,window_start,count) VALUES($1,'admin.login',date_trunc('hour',now()),1) ON CONFLICT(subject_key,action,window_start) DO UPDATE SET count=auth_attempts.count+1",[email]);
    throw new ApiError(401,'UNAUTHENTICATED','Invalid credentials');
  }
  await pool.query("DELETE FROM auth_attempts WHERE subject_key=$1 AND action='admin.login'",[email]);
  const token=randomBytes(32).toString('base64url');
  await pool.query("INSERT INTO admin_sessions(token_hash,admin_user_id,expires_at) VALUES($1,$2,now()+interval '8 hours')",[hashToken(token),user.id]);
  await audit(req,user.id,'auth.login','admin_user',user.id);
  send(res,{token,expiresInSec:28800,user:view(user),permissions:user.permissions});
});
adminAuthRouter.get('/auth/me',async(req,res)=>{const user=await requireAdmin(req);send(res,{user:view(user),permissions:user.permissions});});
adminAuthRouter.post('/auth/logout',async(req,res)=>{const token=/^Bearer ([A-Za-z0-9_-]+)$/.exec(req.header('authorization')??'')?.[1];if(token) await pool.query('UPDATE admin_sessions SET revoked_at=now() WHERE token_hash=$1',[hashToken(token)]);send(res,{ok:true});});
adminAuthRouter.get('/permissions',authorize('dashboard.read'),(_req,res)=>send(res,permissions));
