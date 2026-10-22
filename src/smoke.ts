import { app } from './app.js';
import { pool } from './db.js';
import { config } from './config.js';
import { randomUUID } from 'node:crypto';

if (!['development','test'].includes(config.NODE_ENV)) throw new Error('Smoke test may run only in development or test');
const server=app.listen(0);
const address=server.address();if(!address||typeof address==='string') throw new Error('Missing test port');
const base=`http://127.0.0.1:${address.port}/v1`;
const request=async(path:string,options?:RequestInit)=>{const response=await fetch(`${base}${path}`,options);return{status:response.status,headers:response.headers,body:await response.json() as {data?:unknown;error?:unknown}};};
const assert=(condition:unknown,message:string)=>{if(!condition) throw new Error(message);};
let orderId='';
let categoryId='';
let productId='';
let customerId='';
let testPhone='';
let originalSlogan:string|undefined;
try{
  const health=await request('/health');assert(health.status===200,'Health endpoint failed');
  const products=await request('/products');assert(products.status===200,'Products endpoint failed');
  const noAuth=await request('/admin/summary');assert(noAuth.status===401,'Admin summary allowed guest');
  const allowedPreflight=await fetch(`${base}/admin/auth/login`,{method:'OPTIONS',headers:{Origin:new URL(config.DASHBOARD_ORIGIN??'http://localhost:4201').origin,'Access-Control-Request-Method':'POST'}});assert(allowedPreflight.status===204,'Dashboard preflight failed');
  const deniedPreflight=await fetch(`${base}/admin/auth/login`,{method:'OPTIONS',headers:{Origin:'https://not-allowed.example','Access-Control-Request-Method':'POST'}});assert(deniedPreflight.status===403,'Unknown origin was allowed');
  const login=await request('/admin/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:'owner@souk.local',password:process.env['MOCK_ADMIN_PASSWORD']||'DemoAdmin123!'})});
  assert(login.status===200,'Admin login failed');
  const token=(login.body.data as {token:string}).token;
  const summary=await request('/admin/summary',{headers:{Authorization:`Bearer ${token}`}});assert(summary.status===200,'Summary failed');
  for(const path of ['/content/strings?locale=ar','/categories','/products/facets','/search/popular','/search/suggest?q=tomato','/faq','/pages/about','/seo/resolve?path=%2F','/seo/sitemap','/announcements']){
    const result=await request(path);assert(result.status===200,`Public route failed: ${path}`);
  }
  for(const path of ['/permissions','/products','/categories','/areas','/orders','/customers','/contacts','/content/strings?locale=ar','/faqs','/pages','/announcements','/roles','/users','/audit']){
    const result=await request(`/admin${path}`,{headers:{Authorization:`Bearer ${token}`}});assert(result.status===200,`Dashboard route failed: ${path}`);
  }
  const settings=await request('/admin/settings',{headers:{Authorization:`Bearer ${token}`}});assert(settings.status===200,'Settings failed');
  originalSlogan=(settings.body.data as {brand:{sloganEn:string}}).brand.sloganEn;
  const changedSlogan=`Smoke ${randomUUID().slice(0,8)}`;
  const changedSetting=await request('/admin/settings',{method:'PATCH',headers:{'Content-Type':'application/json',Authorization:`Bearer ${token}`},body:JSON.stringify({brand:{sloganEn:changedSlogan}})});assert(changedSetting.status===200,'Settings update failed');
  const publicSettings=await request('/config/site');assert(publicSettings.status===200&&(publicSettings.body.data as {brand:{sloganEn:string}}).brand.sloganEn===changedSlogan,'Storefront did not see settings update');
  const restoredSetting=await request('/admin/settings',{method:'PATCH',headers:{'Content-Type':'application/json',Authorization:`Bearer ${token}`},body:JSON.stringify({brand:{sloganEn:originalSlogan}})});assert(restoredSetting.status===200,'Settings restore failed');originalSlogan=undefined;
  const unauthorizedWrite=await request('/admin/settings',{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({features:{maintenance:true}})});assert(unauthorizedWrite.status===401,'Settings write allowed guest');
  const viewerLogin=await request('/admin/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:'viewer@souk.local',password:process.env['MOCK_ADMIN_PASSWORD']||'DemoAdmin123!'})});assert(viewerLogin.status===200,'Viewer login failed');
  const viewerToken=(viewerLogin.body.data as {token:string}).token;
  const forbidden=await request('/admin/settings',{method:'PATCH',headers:{'Content-Type':'application/json',Authorization:`Bearer ${viewerToken}`},body:JSON.stringify({features:{maintenance:true}})});assert(forbidden.status===403,'Viewer can edit settings');
  const category=await request('/admin/categories',{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${token}`},body:JSON.stringify({slug:`smoke-${randomUUID().slice(0,8)}`,name:'Smoke',nameEn:'Smoke',imageUrl:'/assets/products/placeholder.svg',sortOrder:100})});assert(category.status===200,`Category create failed: ${JSON.stringify(category.body.error)}`);categoryId=(category.body.data as {id:string}).id;
  const updated=await request(`/admin/categories/${categoryId}`,{method:'PATCH',headers:{'Content-Type':'application/json',Authorization:`Bearer ${token}`},body:JSON.stringify({name:'Smoke Updated'})});assert(updated.status===200&&(updated.body.data as {name:string}).name==='Smoke Updated','Category edit failed');
  const productSlug=`smoke-${randomUUID().slice(0,8)}`;
  const newProduct={slug:productSlug,name:'اختبار',nameEn:'Smoke Produce',categoryId,unitType:'crate',unitLabel:'قفص',unitLabelEn:'crate',estimatedWeightKg:{min:1,max:2},price:10000,cover:{url:'/assets/products/placeholder.svg',width:640,height:480},availability:{inStock:true,maxPerOrder:5},tags:['new'],description:'Test',descriptionEn:'Test'};
  const productCreated=await request('/admin/products',{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${token}`},body:JSON.stringify(newProduct)});assert(productCreated.status===200,`Product create failed: ${JSON.stringify(productCreated.body.error)}`);productId=(productCreated.body.data as {id:string}).id;
  const priceChanged=await request(`/admin/products/${productId}`,{method:'PATCH',headers:{'Content-Type':'application/json',Authorization:`Bearer ${token}`},body:JSON.stringify({price:12000})});assert(priceChanged.status===200&&(priceChanged.body.data as {price:number}).price===12000,'Product price edit failed');
  const storefrontProduct=await request(`/products/${productSlug}`);assert(storefrontProduct.status===200&&(storefrontProduct.body.data as {price:number}).price===12000,'Storefront did not see product edit');
  const quote=await request('/cart/validate',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({items:[{productId,quantity:1}]})});assert(quote.status===200&&(quote.body.data as {subtotal:number}).subtotal===12000,'Cart did not reprice product');
  const productRemoved=await request(`/admin/products/${productId}`,{method:'DELETE',headers:{Authorization:`Bearer ${token}`}});assert(productRemoved.status===200,`Product delete failed: ${JSON.stringify(productRemoved.body.error)}`);productId='';
  const removed=await request(`/admin/categories/${categoryId}`,{method:'DELETE',headers:{Authorization:`Bearer ${token}`}});assert(removed.status===200,'Category delete failed');categoryId='';
  const areas=await request('/areas');assert(areas.status===200,'Areas failed');
  const status=await request('/store/status');assert(status.status===200,'Store status failed');
  const catalogStream=await fetch(`${base}/stream/catalog`);assert(catalogStream.status===200&&catalogStream.headers.get('content-type')?.includes('text/event-stream'),'Catalog SSE failed');await catalogStream.body?.cancel();
  const announcementStream=await fetch(`${base}/announcements/stream`);assert(announcementStream.status===200&&announcementStream.headers.get('content-type')?.includes('text/event-stream'),'Announcement SSE failed');await announcementStream.body?.cancel();
  const item=(products.body.data as {items?:{id:string;price:number}[]} | {id:string;price:number}[]);
  const product=Array.isArray(item)?item[0]:item.items?.[0];
  const area=(areas.body.data as {id:string;shippingFee:number;isActive:boolean}[]).find(entry=>entry.isActive);
  if(area){
    testPhone=`+2010${Math.floor(Math.random()*100000000).toString().padStart(8,'0')}`;
    const otp=await request('/auth/otp/request',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({phone:testPhone,purpose:'register'})});assert(otp.status===200,`OTP request failed: ${JSON.stringify(otp.body.error)}`);
    const requestId=(otp.body.data as {requestId:string}).requestId;
    const verified=await request('/auth/otp/verify',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({requestId,code:process.env['OTP_FIXED_CODE']||'123456'})});assert(verified.status===200,'OTP verify failed');
    const registrationToken=(verified.body.data as {registrationToken:string}).registrationToken;
    const registered=await request('/auth/register',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({registrationToken,password:'TestPass123!',name:'Smoke Customer',email:`smoke-${randomUUID()}@example.test`,age:25,city:area.id})});assert(registered.status===200,`Registration failed: ${JSON.stringify(registered.body.error)}`);
    customerId=(registered.body.data as {user:{id:string}}).user.id;
    const cookie=registered.headers.get('set-cookie')?.split(';')[0]??'';assert(cookie.includes('souk_session='),'Customer cookie missing');
    const profile=await request('/me',{headers:{Cookie:cookie}});assert(profile.status===200,'Customer profile failed');
    const saved=await request('/me/addresses',{method:'POST',headers:{'Content-Type':'application/json',Cookie:cookie},body:JSON.stringify({areaId:area.id,street:'Smoke Street',building:'1'})});assert(saved.status===200&&(saved.body.data as {isDefault:boolean}).isDefault,'Saved address failed');
    const history=await request('/me/orders',{headers:{Cookie:cookie}});assert(history.status===200,'Account order history failed');
  }
  if((status.body.data as {isOrderingOpen:boolean}).isOrderingOpen && product && area){
    const payload={customer:{name:'Smoke Test',phone:'+201000000001'},address:{areaId:area.id,street:'Test Street',building:'1'},items:[{productId:product.id,quantity:1}],expectedTotal:product.price+area.shippingFee,paymentMethod:'cash_on_delivery'};
    const options={method:'POST',headers:{'Content-Type':'application/json','Idempotency-Key':randomUUID()},body:JSON.stringify(payload)};
    const created=await request('/orders',options);assert(created.status===200,`Order create failed: ${JSON.stringify(created.body.error)}`);
    const first=created.body.data as {id:string;trackingToken:string};orderId=first.id;
    const repeated=await request('/orders',options);assert(repeated.status===200&&(repeated.body.data as {id:string}).id===orderId,'Idempotency failed');
    const fetched=await request(`/orders/${orderId}?token=${first.trackingToken}`);assert(fetched.status===200,'Order tracking failed');
    const orderStream=await fetch(`${base}/orders/${orderId}/events?token=${first.trackingToken}`);assert(orderStream.status===200&&orderStream.headers.get('content-type')?.includes('text/event-stream'),'Order SSE failed');await orderStream.body?.cancel();
    const confirmed=await request(`/admin/orders/${orderId}`,{method:'PATCH',headers:{'Content-Type':'application/json',Authorization:`Bearer ${token}`},body:JSON.stringify({status:'confirmed'})});assert(confirmed.status===200&&(confirmed.body.data as {status:string}).status==='confirmed','Admin order transition failed');
    const tracked=await request(`/orders/${orderId}?token=${first.trackingToken}`);assert(tracked.status===200&&(tracked.body.data as {status:string}).status==='confirmed','Customer tracking missed admin transition');
    const cancelled=await request(`/orders/${orderId}/cancel?token=${first.trackingToken}`,{method:'POST'});assert(cancelled.status===200&&(cancelled.body.data as {status:string}).status==='cancelled','Cancellation failed');
  }
  console.log(`Smoke passed: health, catalog, admin login, RBAC, summary, settings, catalog CRUD/repricing, customer OTP/registration/address/history${orderId?', order creation/idempotency/tracking/cancellation':''}`);
}finally{if(originalSlogan!==undefined)await pool.query("UPDATE site_config SET value=jsonb_set(value,'{brand,sloganEn}',$1::jsonb) WHERE id=true",[JSON.stringify(originalSlogan)]);if(productId){await pool.query('DELETE FROM product_price_history WHERE product_id=$1',[productId]);await pool.query('DELETE FROM products WHERE id=$1',[productId]);}if(categoryId)await pool.query('DELETE FROM categories WHERE id=$1',[categoryId]);if(orderId){await pool.query('DELETE FROM idempotency_records WHERE order_id=$1',[orderId]);await pool.query('DELETE FROM order_status_events WHERE order_id=$1',[orderId]);await pool.query('DELETE FROM order_items WHERE order_id=$1',[orderId]);await pool.query('DELETE FROM orders WHERE id=$1',[orderId]);}if(customerId){await pool.query('DELETE FROM customer_sessions WHERE customer_id=$1',[customerId]);await pool.query('DELETE FROM saved_addresses WHERE customer_id=$1',[customerId]);await pool.query('DELETE FROM customers WHERE id=$1',[customerId]);}if(testPhone){await pool.query('DELETE FROM registration_tokens WHERE phone_e164=$1',[testPhone]);await pool.query('DELETE FROM otp_challenges WHERE phone_e164=$1',[testPhone]);await pool.query('DELETE FROM auth_attempts WHERE subject_key=$1',[testPhone]);}server.close();server.closeAllConnections();await pool.end();}
