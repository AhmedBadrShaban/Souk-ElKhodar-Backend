import { Router } from 'express';
import { allAreas, allProducts, publicConfig } from './public.js';
import { ApiError, asObject, asText, send } from './http.js';

export interface StoreStatus { isOrderingOpen: boolean; now: string; cutoffAt: string; nextDeliveryDate: string; deliveryWindow: { start: string; end: string }; pricesUpdatedAt: string }
const localParts = (instant: Date, timezone: string) => {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(instant);
  const number = (type: string) => Number(parts.find(part => part.type === type)?.value);
  return { year: number('year'), month: number('month'), day: number('day'), hour: number('hour'), minute: number('minute') };
};
const localToUtc = (year: number, month: number, day: number, hour: number, minute: number, timezone: string): Date => {
  const guess = Date.UTC(year, month - 1, day, hour, minute);
  const local = localParts(new Date(guess), timezone);
  const offset = Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute) - guess;
  return new Date(guess - offset);
};
export async function storeStatus(): Promise<StoreStatus> {
  const config = await publicConfig(), commerce = asObject(config['commerce']), features = asObject(config['features']);
  const timezone = asText(commerce['timezone']) || 'Africa/Cairo';
  const instant = new Date(), local = localParts(instant, timezone);
  const [hour = 20, minute = 0] = (asText(commerce['cutoffTime']) || '20:00').split(':').map(Number);
  const cutoff = localToUtc(local.year, local.month, local.day, hour, minute, timezone);
  const open = instant.getTime() < cutoff.getTime() && features['maintenance'] !== true;
  const base = new Date(Date.UTC(local.year, local.month - 1, local.day));
  const delivery = new Date(base.getTime() + (open ? 1 : 2) * 86400000);
  const nextDay = new Date(base.getTime() + 86400000);
  const nextCutoff = open ? cutoff : localToUtc(nextDay.getUTCFullYear(), nextDay.getUTCMonth() + 1, nextDay.getUTCDate(), hour, minute, timezone);
  return { isOrderingOpen: open, now: instant.toISOString(), cutoffAt: nextCutoff.toISOString(), nextDeliveryDate: delivery.toISOString().slice(0, 10),
    deliveryWindow: { start: asText(commerce['deliveryWindowStart']) || '08:00', end: asText(commerce['deliveryWindowEnd']) || '12:00' }, pricesUpdatedAt: instant.toISOString() };
}
export const commerceRouter = Router();
commerceRouter.get('/store/status', async (_req,res) => send(res, await storeStatus()));
commerceRouter.post('/cart/validate', async (req,res) => {
  const raw = Array.isArray(req.body?.items) ? req.body.items as unknown[] : [];
  if (raw.length > 100) throw new ApiError(400, 'VALIDATION_FAILED', 'Too many cart lines');
  const products = await allProducts(), areas = await allAreas(), area = areas.find(item => item.id === req.body?.areaId && item.isActive);
  const warnings: { code: string; message: string; productId?: string }[] = [];
  const lines = raw.map(input => {
    const item = asObject(input), productId = asText(item['productId'], 80), quantity = Number(item['quantity']);
    if (!productId || !Number.isInteger(quantity) || quantity < 1) throw new ApiError(400, 'VALIDATION_FAILED', 'Invalid cart line');
    const product = products.find(candidate => candidate.id === productId);
    if (!product?.availability.inStock) { warnings.push({ code: 'OUT_OF_STOCK', message: 'Product is unavailable', productId }); return { productId, quantity, unitPrice: 0, lineTotal: 0, status: 'out_of_stock' }; }
    const capped = Math.min(quantity, product.availability.maxPerOrder);
    if (capped !== quantity) warnings.push({ code: 'QUANTITY_CAPPED', message: 'Quantity adjusted', productId });
    return { productId, quantity: capped, unitPrice: product.price, lineTotal: product.price * capped, status: capped === quantity ? 'ok' : 'quantity_capped', allowedQuantity: capped };
  });
  if (req.body?.areaId && !area) warnings.push({ code: 'AREA_NOT_SERVED', message: 'Area is not served' });
  const status = await storeStatus();
  if (!status.isOrderingOpen) warnings.push({ code: 'ORDERING_CLOSED', message: 'Ordering is closed for today' });
  const config = await publicConfig(), commerce = asObject(config['commerce']), subtotal = lines.reduce((sum,line) => sum + line.lineTotal,0), shippingFee = area?.shippingFee ?? Number(commerce['shippingFee'] ?? 0);
  send(res,{ lines, subtotal, shippingFee, total: subtotal + shippingFee, warnings, canCheckout: lines.length > 0 && warnings.length === 0 });
});
