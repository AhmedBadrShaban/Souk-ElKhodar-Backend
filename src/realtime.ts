import { Router } from 'express';
import type { Server } from 'node:http';
import { WebSocket, WebSocketServer } from 'ws';
import { pool } from './db.js';
import { ApiError, asText } from './http.js';
import { customerFromRequest, hashToken } from './auth.js';
import { allowedOrigins } from './config.js';

export const realtimeRouter=Router();
function startStream(res:import('express').Response):void{res.setHeader('Content-Type','text/event-stream');res.setHeader('Cache-Control','no-cache, no-transform');res.setHeader('Connection','keep-alive');res.flushHeaders();}
const event=(res:import('express').Response,name:string,payload:unknown)=>res.write(`event: ${name}\ndata: ${JSON.stringify(payload)}\n\n`);
realtimeRouter.get('/orders/:id/events',async(req,res)=>{
  const id=String(req.params['id']), token=asText(req.query['token'],150),user=await customerFromRequest(req);
  const order=await pool.query<{tracking_token_hash:string;customer_id:string|null;status:string;updated_at:Date}>('SELECT tracking_token_hash,customer_id,status,updated_at FROM orders WHERE id=$1',[id]);
  if(!order.rows[0] || order.rows[0].tracking_token_hash!==hashToken(token) && order.rows[0].customer_id!==user?.id) throw new ApiError(404,'ORDER_NOT_FOUND','Order not found');
  startStream(res);
  event(res,'order.status',{type:'order.status',orderId:id,status:order.rows[0].status,at:order.rows[0].updated_at.toISOString()});
  const seen=new Set<string>();
  const initial=await pool.query<{id:string}>('SELECT id FROM order_status_events WHERE order_id=$1',[id]);initial.rows.forEach(row=>seen.add(row.id));
  const poll=async()=>{try{const rows=await pool.query<{id:string;to_status:string;at:Date}>('SELECT id,to_status,at FROM order_status_events WHERE order_id=$1 ORDER BY at DESC LIMIT 30',[id]);for(const row of rows.rows.reverse()){if(seen.has(row.id)) continue;seen.add(row.id);event(res,'order.status',{type:'order.status',orderId:id,status:row.to_status,at:row.at.toISOString()});}}catch{res.end();}};
  const timer=setInterval(()=>void poll(),3000),heartbeat=setInterval(()=>res.write(': heartbeat\n\n'),25000);res.on('close',()=>{clearInterval(timer);clearInterval(heartbeat);});
});
realtimeRouter.get('/stream/catalog',async(req,res)=>{
  startStream(res);event(res,'store.status',{type:'store.status',at:new Date().toISOString()});
  const seen=new Set<string>();const initial=await pool.query<{id:string}>("SELECT id FROM outbox_events WHERE event_type IN ('price.updated','stock.updated','store.status') AND created_at>now()-interval '2 minutes'");initial.rows.forEach(row=>seen.add(row.id));
  const poll=async()=>{try{const rows=await pool.query<{id:string;event_type:string;payload:Record<string,unknown>}>("SELECT id,event_type,payload FROM outbox_events WHERE event_type IN ('price.updated','stock.updated','store.status') AND created_at>now()-interval '2 minutes' ORDER BY created_at DESC LIMIT 100");for(const row of rows.rows.reverse()){if(seen.has(row.id)) continue;seen.add(row.id);event(res,row.event_type,row.payload);}}catch{res.end();}};
  const timer=setInterval(()=>void poll(),3000),heartbeat=setInterval(()=>res.write(': heartbeat\n\n'),25000);res.on('close',()=>{clearInterval(timer);clearInterval(heartbeat);});
});
export function attachAnnouncements(server:Server):()=>void{
  const sockets=new WebSocketServer({noServer:true,maxPayload:1024});
  const upgrade=(req:import('node:http').IncomingMessage,socket:import('node:stream').Duplex,head:Buffer)=>{
    const path=new URL(req.url??'/',`http://${req.headers.host??'localhost'}`).pathname;
    if(path!=='/v1/announcements/ws') return;
    const origin=req.headers.origin;
    if(origin && !allowedOrigins.has(origin)){socket.destroy();return;}
    sockets.handleUpgrade(req,socket,head,client=>sockets.emit('connection',client,req));
  };
  server.on('upgrade',upgrade);
  const snapshot=async()=>{const rows=await pool.query<{id:string;text_ar:string;text_en:string}>('SELECT id,text_ar,text_en FROM announcements WHERE active ORDER BY sort_order');return rows.rows.map(row=>({id:row.id,textAr:row.text_ar,textEn:row.text_en}));};
  sockets.on('connection',client=>{void snapshot().then(messages=>client.send(JSON.stringify({type:'announcements.snapshot',messages,at:new Date().toISOString()}))).catch(()=>client.close());});
  let last='';
  const poll=async()=>{try{const messages=await snapshot(),fingerprint=JSON.stringify(messages);if(fingerprint===last)return;last=fingerprint;const payload=JSON.stringify({type:'announcements.snapshot',messages,at:new Date().toISOString()});for(const client of sockets.clients) if(client.readyState===WebSocket.OPEN) client.send(payload);}catch{/* Try again after a transient database failure. */}};
  void poll();const timer=setInterval(()=>void poll(),3000);
  return()=>{clearInterval(timer);for(const client of sockets.clients) client.close();sockets.close();server.off('upgrade',upgrade);};
}
