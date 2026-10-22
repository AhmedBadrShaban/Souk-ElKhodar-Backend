import type { Request } from 'express';
import { pool } from './db.js';
import { ApiError, positiveInt } from './http.js';

export interface ListMeta { page: number; pageSize: number; total: number; totalPages: number; sort: string; direction: 'asc' | 'desc' }
export interface ListSpec { from: string; id: string; columns: Record<string, string>; defaultSort: string; defaultDirection?: 'asc' | 'desc' }

export async function adminList(req: Request, spec: ListSpec): Promise<{ ids: string[]; meta: ListMeta }> {
  const page = positiveInt(req.query['page'], 1, 100000);
  const pageSize = positiveInt(req.query['pageSize'], 20, 100);
  const sort = typeof req.query['sort'] === 'string' ? req.query['sort'] : spec.defaultSort;
  if (!(sort in spec.columns)) throw new ApiError(400, 'INVALID_SORT', 'Unknown sort column');
  const direction = req.query['direction'] === undefined ? (spec.defaultDirection ?? 'asc') : req.query['direction'];
  if (direction !== 'asc' && direction !== 'desc') throw new ApiError(400, 'INVALID_SORT', 'Invalid sort direction');
  const values: string[] = [];
  const conditions: string[] = [];
  for (const [key, value] of Object.entries(req.query)) {
    if (!key.startsWith('filter_')) continue;
    const column = key.slice(7);
    if (!(column in spec.columns) || typeof value !== 'string' || value.length > 100) throw new ApiError(400, 'INVALID_FILTER', 'Invalid column filter');
    const term = value.trim();
    if (!term) continue;
    values.push(`%${term.replace(/[\\%_]/g, '\\$&')}%`);
    conditions.push(`(${spec.columns[column]})::text ILIKE $${values.length} ESCAPE '\\'`);
  }
  const where = conditions.length ? ` WHERE ${conditions.join(' AND ')}` : '';
  const count = await pool.query<{ total: string }>(`SELECT count(*)::text total FROM ${spec.from}${where}`, values);
  const total = Number(count.rows[0]?.total ?? 0);
  const order = spec.columns[sort]!;
  const rows = await pool.query<{ id: string }>(`SELECT ${spec.id} AS id FROM ${spec.from}${where} ORDER BY ${order} ${direction.toUpperCase()}, ${spec.id} ASC LIMIT $${values.length + 1} OFFSET $${values.length + 2}`, [...values, pageSize, (page - 1) * pageSize]);
  return { ids: rows.rows.map(row => row.id), meta: { page, pageSize, total, totalPages: Math.max(1, Math.ceil(total / pageSize)), sort, direction } };
}
