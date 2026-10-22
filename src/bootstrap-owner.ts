import { pool } from './db.js';
import { hashPassword, validAdminPassword } from './auth.js';
import { permissions } from './admin-auth.js';

const email=process.env['ADMIN_BOOTSTRAP_EMAIL']?.trim().toLowerCase()??'';
const password=process.env['ADMIN_BOOTSTRAP_PASSWORD']??'';
const name=process.env['ADMIN_BOOTSTRAP_NAME']?.trim()||'Owner';
if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)||!validAdminPassword(password)) throw new Error('Set ADMIN_BOOTSTRAP_EMAIL and a strong ADMIN_BOOTSTRAP_PASSWORD');
const client=await pool.connect();
try{
  await client.query('BEGIN');
  const exists=await client.query('SELECT id FROM admin_users LIMIT 1 FOR UPDATE');
  if(exists.rowCount) throw new Error('Admin bootstrap is only allowed before the first admin user exists');
  const role=await client.query<{id:string}>("INSERT INTO admin_roles(name,description,system) VALUES('Owner','All dashboard access',true) RETURNING id");
  const roleId=role.rows[0]?.id;if(!roleId) throw new Error('Owner role could not be created');
  for(const key of permissions) await client.query('INSERT INTO admin_role_permissions(role_id,permission_key) VALUES($1,$2)',[roleId,key]);
  const user=await client.query<{id:string}>('INSERT INTO admin_users(name,email,password_hash) VALUES($1,$2,$3) RETURNING id',[name,email,hashPassword(password)]);
  await client.query('INSERT INTO admin_user_roles(admin_user_id,role_id) VALUES($1,$2)',[user.rows[0]?.id,roleId]);
  await client.query('COMMIT');console.log('Owner account created');
}catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();await pool.end();}
