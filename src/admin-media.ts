import { randomUUID } from 'node:crypto';
import { Router, type RequestHandler } from 'express';
import multer from 'multer';
import { authorize, audit, requireAdmin } from './admin-auth.js';
import { pool } from './db.js';
import { ApiError, send } from './http.js';
import { deleteMedia, putMedia } from './media-storage.js';

export const adminMediaRouter = Router();

const maxImageBytes = 8 * 1024 * 1024;
const maxVideoBytes = 50 * 1024 * 1024;
const maxByType = { image: 4, video: 2 } as const;
type MediaType = keyof typeof maxByType;
type MediaRow = { id: string; url: string; media_type: MediaType; poster_url: string | null; sort_order: number; storage_key: string | null; byte_size: string | null; content_type: string | null };

const uploader = multer({ storage: multer.memoryStorage(), limits: { fileSize: maxVideoBytes, files: 1, fields: 0 } }).single('file');
const parseUpload: RequestHandler = (req, res, next) => uploader(req, res, error => {
  if (error instanceof multer.MulterError) {
    next(new ApiError(error.code === 'LIMIT_FILE_SIZE' ? 413 : 400, 'INVALID_MEDIA', error.code === 'LIMIT_FILE_SIZE' ? 'Video exceeds 50 MB' : 'Send one file in the file field'));
    return;
  }
  next(error);
});

function identify(file: Express.Multer.File): { type: MediaType; contentType: string; extension: string } {
  const b = file.buffer;
  const jpeg = b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;
  const png = b.length >= 8 && b.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  const webp = b.length >= 12 && b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP';
  const mp4 = b.length >= 12 && b.toString('ascii', 4, 8) === 'ftyp';
  const webm = b.length >= 4 && b.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]));
  const known = jpeg ? { type: 'image', contentType: 'image/jpeg', extension: 'jpg' }
    : png ? { type: 'image', contentType: 'image/png', extension: 'png' }
      : webp ? { type: 'image', contentType: 'image/webp', extension: 'webp' }
        : mp4 ? { type: 'video', contentType: 'video/mp4', extension: 'mp4' }
          : webm ? { type: 'video', contentType: 'video/webm', extension: 'webm' } : null;
  if (!known || file.mimetype !== known.contentType) throw new ApiError(400, 'INVALID_MEDIA', 'Use JPEG, PNG, WebP, MP4 or WebM files');
  if (b.length === 0 || b.length > (known.type === 'image' ? maxImageBytes : maxVideoBytes)) {
    throw new ApiError(413, 'MEDIA_TOO_LARGE', known.type === 'image' ? 'Image exceeds 8 MB' : 'Video exceeds 50 MB');
  }
  return known as { type: MediaType; contentType: string; extension: string };
}

async function existingProduct(id: string): Promise<void> {
  const row = await pool.query('SELECT 1 FROM products WHERE id=$1', [id]);
  if (!row.rowCount) throw new ApiError(404, 'NOT_FOUND', 'Product not found');
}

const view = (row: MediaRow & { cover_media_id?: string | null }) => ({
  id: row.id, url: row.url, type: row.media_type, posterUrl: row.poster_url,
  sortOrder: row.sort_order, storageManaged: row.storage_key !== null,
  isCover: row.cover_media_id === row.id,
  byteSize: row.byte_size === null ? null : Number(row.byte_size), contentType: row.content_type,
});

adminMediaRouter.get('/products/:id/media', authorize('products.read'), async (req, res) => {
  const id = String(req.params['id']);
  await existingProduct(id);
  const rows = await pool.query<MediaRow & { cover_media_id: string | null }>(`SELECT m.*, p.cover_media_id FROM product_media m
    JOIN products p ON p.id=m.product_id WHERE m.product_id=$1 ORDER BY m.sort_order,m.created_at,m.id`, [id]);
  send(res, rows.rows.map(view));
});

adminMediaRouter.post('/products/:id/media', authorize('products.write'), parseUpload, async (req, res) => {
  const productId = String(req.params['id']);
  const file = req.file;
  if (!file) throw new ApiError(400, 'INVALID_MEDIA', 'Select one file to upload');
  const media = identify(file);
  const actor = await requireAdmin(req);
  const client = await pool.connect();
  let storageKey: string | undefined;
  let committed = false;
  try {
    await client.query('BEGIN');
    const product = await client.query<{ cover_media_id: string | null }>('SELECT cover_media_id FROM products WHERE id=$1 FOR UPDATE', [productId]);
    if (!product.rows[0]) throw new ApiError(404, 'NOT_FOUND', 'Product not found');
    if (media.type === 'image') {
      await client.query("DELETE FROM product_media WHERE product_id=$1 AND url='/assets/products/placeholder.svg' AND storage_key IS NULL", [productId]);
    }
    const currentCover = await client.query<{ cover_media_id: string | null }>('SELECT cover_media_id FROM products WHERE id=$1', [productId]);
    const coverId = currentCover.rows[0]?.cover_media_id ?? null;
    const count = await client.query<{ count: string }>('SELECT count(*) FROM product_media WHERE product_id=$1 AND media_type=$2', [productId, media.type]);
    if (Number(count.rows[0]?.count ?? 0) >= maxByType[media.type]) {
      throw new ApiError(409, 'MEDIA_LIMIT', `A product can have at most ${maxByType[media.type]} ${media.type === 'image' ? 'images' : 'videos'}`);
    }
    const order = await client.query<{ next_order: number }>('SELECT COALESCE(MAX(sort_order),-1)+1 AS next_order FROM product_media WHERE product_id=$1', [productId]);
    storageKey = `${productId}/${randomUUID()}.${media.extension}`;
    const url = await putMedia(storageKey, file.buffer, media.contentType);
    const posterUrl = media.type === 'video'
      ? (await client.query<{ url: string }>('SELECT m.url FROM products p JOIN product_media m ON m.id=p.cover_media_id WHERE p.id=$1', [productId])).rows[0]?.url ?? null
      : null;
    const inserted = await client.query<MediaRow>(`INSERT INTO product_media(product_id,url,media_type,poster_url,sort_order,storage_key,byte_size,content_type)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [productId, url, media.type, posterUrl, order.rows[0]?.next_order ?? 0, storageKey, file.size, media.contentType]);
    if (media.type === 'image' && !coverId) {
      await client.query('UPDATE products SET cover_media_id=$2,updated_at=now() WHERE id=$1', [productId, inserted.rows[0]?.id]);
      await client.query("UPDATE product_media SET poster_url=$2,updated_at=now() WHERE product_id=$1 AND media_type='video' AND poster_url IS NULL", [productId, url]);
    }
    await client.query('INSERT INTO audit_entries(admin_user_id,action,target_type,target_id,request_id) VALUES($1,$2,$3,$4,$5)',
      [actor.id, 'product.media.upload', 'product', productId, res.locals['requestId']]);
    await client.query('COMMIT');
    committed = true;
    send(res, view({ ...inserted.rows[0]!, cover_media_id: media.type === 'image' && !coverId ? inserted.rows[0]!.id : coverId }));
  } catch (error) {
    if (!committed) await client.query('ROLLBACK');
    if (!committed && storageKey) {
      try { await deleteMedia(storageKey); } catch { console.error('Could not clean up failed product media upload'); }
    }
    throw error;
  } finally { client.release(); }
});

adminMediaRouter.put('/products/:id/media/order', authorize('products.write'), async (req, res) => {
  const productId = String(req.params['id']);
  const actor = await requireAdmin(req);
  const ids: unknown = req.body?.ids;
  if (!Array.isArray(ids) || ids.length > 6 || ids.some(id => typeof id !== 'string') || new Set(ids).size !== ids.length) {
    throw new ApiError(400, 'INVALID_MEDIA_ORDER', 'Send each media ID once');
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const product = await client.query('SELECT 1 FROM products WHERE id=$1 FOR UPDATE', [productId]);
    if (!product.rowCount) throw new ApiError(404, 'NOT_FOUND', 'Product not found');
    const current = await client.query<{ id: string }>('SELECT id FROM product_media WHERE product_id=$1', [productId]);
    if (current.rows.length !== ids.length || current.rows.some(row => !ids.includes(row.id))) {
      throw new ApiError(400, 'INVALID_MEDIA_ORDER', 'Include every media item for this product');
    }
    for (const [index, id] of ids.entries()) await client.query('UPDATE product_media SET sort_order=$3,updated_at=now() WHERE product_id=$1 AND id=$2', [productId, id, index]);
    await client.query('INSERT INTO audit_entries(admin_user_id,action,target_type,target_id,request_id) VALUES($1,$2,$3,$4,$5)',
      [actor.id, 'product.media.order', 'product', productId, res.locals['requestId']]);
    await client.query('COMMIT');
    send(res, { ok: true });
  } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
});

adminMediaRouter.put('/products/:id/media/:mediaId/cover', authorize('products.write'), async (req, res) => {
  const productId = String(req.params['id']), mediaId = String(req.params['mediaId']);
  const row = await pool.query(`UPDATE products SET cover_media_id=$2,updated_at=now()
    WHERE id=$1 AND EXISTS(SELECT 1 FROM product_media WHERE id=$2 AND product_id=$1 AND media_type='image') RETURNING id`, [productId, mediaId]);
  if (!row.rowCount) throw new ApiError(404, 'NOT_FOUND', 'Product image not found');
  const actor = await requireAdmin(req);
  await audit(req, actor.id, 'product.media.cover', 'product', productId);
  send(res, { ok: true });
});

adminMediaRouter.delete('/products/:id/media/:mediaId', authorize('products.write'), async (req, res) => {
  const productId = String(req.params['id']), mediaId = String(req.params['mediaId']);
  const actor = await requireAdmin(req);
  const client = await pool.connect();
  let storageKey: string | null = null;
  try {
    await client.query('BEGIN');
    const product = await client.query('SELECT 1 FROM products WHERE id=$1 FOR UPDATE', [productId]);
    if (!product.rowCount) throw new ApiError(404, 'NOT_FOUND', 'Product not found');
    const removed = await client.query<MediaRow>('DELETE FROM product_media WHERE id=$1 AND product_id=$2 RETURNING *', [mediaId, productId]);
    if (!removed.rows[0]) throw new ApiError(404, 'NOT_FOUND', 'Product media not found');
    storageKey = removed.rows[0].storage_key;
    await client.query(`UPDATE products SET cover_media_id=(SELECT id FROM product_media WHERE product_id=$1 AND media_type='image' ORDER BY sort_order,id LIMIT 1),updated_at=now()
      WHERE id=$1 AND cover_media_id IS NULL`, [productId]);
    if (removed.rows[0].media_type === 'image') {
      await client.query(`UPDATE product_media SET poster_url=(SELECT m.url FROM products p JOIN product_media m ON m.id=p.cover_media_id WHERE p.id=$1),updated_at=now()
        WHERE product_id=$1 AND media_type='video' AND poster_url=$2`, [productId, removed.rows[0].url]);
    }
    await client.query('INSERT INTO audit_entries(admin_user_id,action,target_type,target_id,request_id) VALUES($1,$2,$3,$4,$5)',
      [actor.id, 'product.media.delete', 'product', productId, res.locals['requestId']]);
    await client.query('COMMIT');
  } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
  let storageCleanupPending = false;
  if (storageKey) {
    try { await deleteMedia(storageKey); } catch { storageCleanupPending = true; console.error('Could not delete product media object from storage'); }
  }
  send(res, { ok: true, storageCleanupPending });
});
