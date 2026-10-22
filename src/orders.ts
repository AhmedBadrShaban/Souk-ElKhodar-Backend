import { createHash, createHmac, randomUUID } from "node:crypto";
import { Router } from "express";
import type { PoolClient } from "pg";
import { pool } from "./db.js";
import { ApiError, asObject, asText, moneyInt, send } from "./http.js";
import {
  customerFromRequest,
  hashToken,
  normalizePhone,
  requireCustomer,
} from "./auth.js";
import { storeStatus } from "./commerce.js";

const secret =
  process.env["TRACKING_TOKEN_SECRET"] ||
  (process.env["NODE_ENV"] === "production"
    ? ""
    : "local-tracking-token-secret");
if (!secret) throw new Error("TRACKING_TOKEN_SECRET is required in production");
const tokenFor = (id: string): string =>
  createHmac("sha256", secret).update(id).digest("base64url");
const canCancel = (status: string): boolean =>
  ["pending_confirmation", "confirmed"].includes(status);
type OrderRow = {
  id: string;
  number: string;
  status: string;
  customer_id: string | null;
  customer_name: string;
  customer_phone_e164: string;
  address_snapshot: Record<string, unknown>;
  subtotal_minor: string;
  shipping_fee_minor: string;
  total_minor: string;
  delivery_date: string;
  window_start: string;
  window_end: string;
  created_at: Date;
};
type ItemRow = {
  product_id: string;
  product_name_snapshot: string;
  quantity: number;
  unit_price_minor: string;
  line_total_minor: string;
};
export async function orderView(
  id: string,
  db: PoolClient | typeof pool = pool,
): Promise<Record<string, unknown>> {
  const result = await db.query<OrderRow>("SELECT * FROM orders WHERE id=$1", [
    id,
  ]);
  const row = result.rows[0];
  if (!row) throw new ApiError(404, "ORDER_NOT_FOUND", "Order not found");
  const items = await db.query<ItemRow>(
    "SELECT * FROM order_items WHERE order_id=$1 ORDER BY id",
    [id],
  );
  return {
    id: row.id,
    number: row.number,
    status: row.status,
    trackingToken: tokenFor(id),
    items: items.rows.map((item) => ({
      productId: item.product_id,
      name: item.product_name_snapshot,
      quantity: item.quantity,
      unitPrice: Number(item.unit_price_minor),
      lineTotal: Number(item.line_total_minor),
    })),
    subtotal: Number(row.subtotal_minor),
    shippingFee: Number(row.shipping_fee_minor),
    total: Number(row.total_minor),
    customer: { name: row.customer_name, phone: row.customer_phone_e164 },
    address: row.address_snapshot,
    deliveryDate: String(row.delivery_date).slice(0, 10),
    deliveryWindow: {
      start: String(row.window_start).slice(0, 5),
      end: String(row.window_end).slice(0, 5),
    },
    createdAt: row.created_at.toISOString(),
    canCancel: canCancel(row.status),
  };
}
async function accessible(
  id: string,
  token: string,
  customerId?: string,
): Promise<void> {
  const row = await pool.query<{
    tracking_token_hash: string;
    customer_id: string | null;
  }>("SELECT tracking_token_hash,customer_id FROM orders WHERE id=$1", [id]);
  if (
    !row.rows[0] ||
    (row.rows[0].tracking_token_hash !== hashToken(token) &&
      row.rows[0].customer_id !== customerId)
  )
    throw new ApiError(404, "ORDER_NOT_FOUND", "Order not found");
}
export const ordersRouter = Router();
ordersRouter.post("/orders", async (req, res) => {
  const key = asText(req.header("Idempotency-Key"), 150);
  if (!key)
    throw new ApiError(400, "VALIDATION_FAILED", "Idempotency-Key required");
  const body = asObject(req.body),
    customer = asObject(body["customer"]),
    address = asObject(body["address"]);
  const name = asText(customer["name"], 100),
    phone = normalizePhone(asText(customer["phone"], 30));
  const areaId = asText(address["areaId"], 100),
    street = asText(address["street"], 200),
    building = asText(address["building"], 100);
  if (
    !name ||
    !areaId ||
    !street ||
    !building ||
    body["paymentMethod"] !== "cash_on_delivery"
  )
    throw new ApiError(
      400,
      "VALIDATION_FAILED",
      "Check customer, address and payment",
    );
  const inputs = Array.isArray(body["items"])
    ? body["items"].map(asObject)
    : [];
  if (!inputs.length || inputs.length > 100)
    throw new ApiError(400, "VALIDATION_FAILED", "Add valid items");
  const requested = inputs.map((item) => ({
    id: asText(item["productId"], 80),
    quantity: Number(item["quantity"]),
  }));
  if (
    requested.some(
      (item) =>
        !item.id || !Number.isInteger(item.quantity) || item.quantity < 1,
    ) ||
    new Set(requested.map((item) => item.id)).size !== requested.length
  )
    throw new ApiError(400, "VALIDATION_FAILED", "Invalid cart lines");
  const expected = moneyInt(body["expectedTotal"]);
  const fingerprint = createHash("sha256")
    .update(JSON.stringify({ name, phone, address, requested, expected }))
    .digest("hex");
  const signedIn = await customerFromRequest(req);
  const db = await pool.connect();
  try {
    await db.query("BEGIN");
    await db.query("SELECT pg_advisory_xact_lock(hashtext($1))", [key]);
    const previous = await db.query<{
      request_fingerprint: string;
      order_id: string;
    }>(
      "SELECT request_fingerprint,order_id FROM idempotency_records WHERE scope=$1 AND key=$2",
      ["orders", key],
    );
    if (previous.rows[0]) {
      if (previous.rows[0].request_fingerprint !== fingerprint)
        throw new ApiError(
          409,
          "IDEMPOTENCY_CONFLICT",
          "Request key already used for another order",
        );
      const existing = await orderView(previous.rows[0].order_id, db);
      await db.query("COMMIT");
      send(res, existing);
      return;
    }
    const status = await storeStatus();
    if (!status.isOrderingOpen)
      throw new ApiError(409, "ORDERING_CLOSED", "Ordering is closed for today");
    const area = await db.query<{
      name_ar: string;
      shipping_fee_minor: string;
    }>(
      "SELECT name_ar,shipping_fee_minor FROM delivery_areas WHERE id=$1 AND is_active=true FOR SHARE",
      [areaId],
    );
    if (!area.rows[0])
      throw new ApiError(400, "AREA_NOT_SERVED", "Area is not served");
    const products = await db.query<{
      id: string;
      name_ar: string;
      unit_label_ar: string;
      price_minor: string;
      in_stock: boolean;
      max_per_order: number;
    }>(
      "SELECT id,name_ar,unit_label_ar,price_minor,in_stock,max_per_order FROM products WHERE id=ANY($1::uuid[]) FOR SHARE",
      [requested.map((item) => item.id)],
    );
    const lines = requested.map((item) => {
      const p = products.rows.find((row) => row.id === item.id);
      if (!p?.in_stock)
        throw new ApiError(400, "OUT_OF_STOCK", "Product is unavailable");
      if (item.quantity > p.max_per_order)
        throw new ApiError(
          400,
          "VALIDATION_FAILED",
          "Quantity exceeds the per-order limit",
        );
      return {
        product: p,
        quantity: item.quantity,
        price: Number(p.price_minor),
      };
    });
    const subtotal = lines.reduce(
        (sum, line) => sum + line.quantity * line.price,
        0,
      ),
      shipping = Number(area.rows[0].shipping_fee_minor),
      total = subtotal + shipping;
    if (!Number.isSafeInteger(total) || total !== expected)
      throw new ApiError(409, "PRICE_CHANGED", "Please review updated total");
    const id = randomUUID();
    const sequence = await db.query<{value:string}>("SELECT nextval('order_number_seq')::text AS value");
    const number = `SK-${String(sequence.rows[0]?.value ?? '').padStart(8, '0')}`;
    await db.query(
      `INSERT INTO orders(id,number,customer_id,tracking_token_hash,customer_name,customer_phone_e164,area_id,area_name_snapshot,address_snapshot,subtotal_minor,shipping_fee_minor,total_minor,delivery_date,window_start,window_end,payment_method,notes) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,'cash_on_delivery',$16)`,
      [
        id,
        number,
        signedIn?.id ?? null,
        hashToken(tokenFor(id)),
        name,
        phone,
        areaId,
        area.rows[0].name_ar,
        JSON.stringify({
          areaId,
          street,
          building,
          floor: asText(address["floor"], 100),
          apartment: asText(address["apartment"], 100),
          landmark: asText(address["landmark"], 200),
        }),
        subtotal,
        shipping,
        total,
        status.nextDeliveryDate,
        status.deliveryWindow.start,
        status.deliveryWindow.end,
        asText(body["notes"], 1000),
      ],
    );
    for (const line of lines)
      await db.query(
        "INSERT INTO order_items(order_id,product_id,product_name_snapshot,unit_label_snapshot,quantity,unit_price_minor,line_total_minor) VALUES($1,$2,$3,$4,$5,$6,$7)",
        [
          id,
          line.product.id,
          line.product.name_ar,
          line.product.unit_label_ar,
          line.quantity,
          line.price,
          line.quantity * line.price,
        ],
      );
    await db.query(
      "INSERT INTO order_status_events(order_id,to_status,actor_kind) VALUES($1,'pending_confirmation','customer')",
      [id],
    );
    await db.query(
      "INSERT INTO idempotency_records(scope,key,request_fingerprint,order_id,expires_at) VALUES('orders',$1,$2,$3,now()+interval '7 days')",
      [key, fingerprint, id],
    );
    const view = await orderView(id, db);
    await db.query("COMMIT");
    send(res, view);
  } catch (error) {
    await db.query("ROLLBACK");
    throw error;
  } finally {
    db.release();
  }
});
ordersRouter.get("/me/orders", async (req, res) => {
  const user = await requireCustomer(req);
  const rows = await pool.query<{ id: string }>(
    "SELECT id FROM orders WHERE customer_id=$1 ORDER BY created_at DESC LIMIT 100",
    [user.id],
  );
  send(res, await Promise.all(rows.rows.map((row) => orderView(row.id))));
});
ordersRouter.get("/orders/:id", async (req, res) => {
  const id = String(req.params["id"]),
    user = await customerFromRequest(req);
  await accessible(id, asText(req.query["token"]), user?.id);
  send(res, await orderView(id));
});
ordersRouter.post("/orders/:id/cancel", async (req, res) => {
  const id = String(req.params["id"]),
    user = await customerFromRequest(req);
  await accessible(id, asText(req.query["token"]), user?.id);
  const db = await pool.connect();
  try {
    await db.query("BEGIN");
    const row = await db.query<{ status: string }>(
      "SELECT status FROM orders WHERE id=$1 FOR UPDATE",
      [id],
    );
    if (!row.rows[0] || !canCancel(row.rows[0].status))
      throw new ApiError(
        409,
        "ORDER_CANNOT_CANCEL",
        "This order can no longer be cancelled",
      );
    await db.query(
      "UPDATE orders SET status='cancelled',updated_at=now() WHERE id=$1",
      [id],
    );
    await db.query(
      "INSERT INTO order_status_events(order_id,from_status,to_status,actor_kind,actor_id) VALUES($1,$2,'cancelled','customer',$3)",
      [id, row.rows[0].status, user?.id ?? null],
    );
    const view = await orderView(id, db);
    await db.query("COMMIT");
    send(res, view);
  } catch (error) {
    await db.query("ROLLBACK");
    throw error;
  } finally {
    db.release();
  }
});
