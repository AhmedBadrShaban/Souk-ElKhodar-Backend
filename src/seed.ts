import { readFile } from 'node:fs/promises';
import { pool } from './db.js';
import { config } from './config.js';
import { hashPassword } from './auth.js';
import { permissions } from './admin-auth.js';

interface FixtureCategory { id: string; slug: string; name: string; nameEn: string; imageUrl: string; sortOrder: number }
interface FixtureArea { id: string; name: string; nameEn: string; shippingFee: number; isActive: boolean }
interface FixtureProduct { slug: string; name: string; nameEn: string; categoryId: string; description: string; descriptionEn: string; unitType: string; unitLabel: string; unitLabelEn: string; estimatedWeightKg: { min: number; max: number }; price: number; availability: { inStock: boolean; maxPerOrder: number }; cover: { url: string; width: number; height: number }; tags: string[] }
interface Fixture { categories: FixtureCategory[]; areas: FixtureArea[]; products: FixtureProduct[]; faqs: { id: string; question: string; answer: string; sortOrder: number }[]; pages: { slug: string; title: string; bodyHtml: string }[]; announcements: { id: string; textAr: string; textEn: string }[]; config: Record<string, unknown>; strings: { ar: Record<string, string>; en: Record<string, string> } }

const fixture = JSON.parse((await readFile(new URL('./starter.json', import.meta.url), 'utf8')).replace(/^\uFEFF/, '')) as Fixture;
const client = await pool.connect();
try {
  await client.query('BEGIN');
  for (const category of fixture.categories) {
    await client.query(`INSERT INTO categories(slug,name_ar,name_en,image_url,sort_order) VALUES($1,$2,$3,$4,$5)
      ON CONFLICT(slug) DO NOTHING`, [category.slug, category.name, category.nameEn, category.imageUrl, category.sortOrder]);
  }
  for (const area of fixture.areas) {
    await client.query(`INSERT INTO delivery_areas(id,name_ar,name_en,shipping_fee_minor,is_active) VALUES($1,$2,$3,$4,$5)
      ON CONFLICT(id) DO NOTHING`, [area.id, area.name, area.nameEn, area.shippingFee, area.isActive]);
  }
  for (const product of fixture.products) {
    const result = await client.query<{ id: string }>(`INSERT INTO products(slug,category_id,name_ar,name_en,description_ar,description_en,unit_type,unit_label_ar,unit_label_en,weight_min_kg,weight_max_kg,price_minor,in_stock,max_per_order)
      SELECT $1,id,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14 FROM categories WHERE slug=$2
      ON CONFLICT(slug) DO UPDATE SET slug=EXCLUDED.slug RETURNING id`, [product.slug, product.categoryId, product.name, product.nameEn, product.description, product.descriptionEn, product.unitType, product.unitLabel, product.unitLabelEn, product.estimatedWeightKg.min, product.estimatedWeightKg.max, product.price, product.availability.inStock, product.availability.maxPerOrder]);
    const id = result.rows[0]?.id;
    if (!id) throw new Error(`Missing category for ${product.slug}`);
    const media = await client.query<{ id: string }>(`INSERT INTO product_media(product_id,url,media_type,width,height,sort_order)
      SELECT $1,$2,'image',$3,$4,0 WHERE NOT EXISTS(SELECT 1 FROM product_media WHERE product_id=$1)
      RETURNING id`, [id, product.cover.url, product.cover.width, product.cover.height]);
    if (media.rows[0]) await client.query('UPDATE products SET cover_media_id=$2 WHERE id=$1', [id, media.rows[0].id]);
    for (const tag of product.tags) {
      await client.query('INSERT INTO tags(text) VALUES($1) ON CONFLICT(text) DO NOTHING', [tag]);
      await client.query('INSERT INTO product_tags(product_id,tag_id) SELECT $1,id FROM tags WHERE text=$2 ON CONFLICT DO NOTHING', [id, tag]);
    }
  }
  for (const faq of fixture.faqs) await client.query(`INSERT INTO faqs(question,answer,sort_order) SELECT $1,$2,$3 WHERE NOT EXISTS(SELECT 1 FROM faqs WHERE question=$1)`, [faq.question, faq.answer, faq.sortOrder]);
  for (const page of fixture.pages) await client.query(`INSERT INTO static_pages(slug,title,body_html) VALUES($1,$2,$3) ON CONFLICT(slug) DO NOTHING`, [page.slug, page.title, page.bodyHtml]);
  for (const [index, message] of fixture.announcements.entries()) await client.query(`INSERT INTO announcements(text_ar,text_en,sort_order) SELECT $1,$2,$3 WHERE NOT EXISTS(SELECT 1 FROM announcements WHERE text_en=$2)`, [message.textAr, message.textEn, index]);
  const { apiBaseUrl: _ignored, ...publicConfig } = fixture.config;
  await client.query('INSERT INTO site_config(id,value) VALUES(true,$1) ON CONFLICT(id) DO NOTHING', [JSON.stringify(publicConfig)]);
  for (const locale of ['ar', 'en'] as const) for (const [key, value] of Object.entries(fixture.strings[locale])) await client.query(`INSERT INTO content_strings(locale,key,value) VALUES($1,$2,$3) ON CONFLICT(locale,key) DO NOTHING`, [locale, key, value]);
  if (config.NODE_ENV === 'development' || config.NODE_ENV === 'test') {
    const roles = [
      { name: 'Owner', description: 'All dashboard access', keys: [...permissions], system: true },
      { name: 'Operations', description: 'Orders and delivery', keys: ['dashboard.read','orders.read','orders.write','areas.read','areas.write','customers.read','contacts.read','contacts.write'], system: false },
      { name: 'Catalog editor', description: 'Products and categories', keys: ['dashboard.read','products.read','products.write','categories.read','categories.write'], system: false },
      { name: 'Viewer', description: 'Read only overview', keys: permissions.filter(key=>key.endsWith('.read')), system: false },
    ];
    const password = process.env['MOCK_ADMIN_PASSWORD'] || 'DemoAdmin123!';
    for (const role of roles) {
      const result = await client.query<{id:string}>(`INSERT INTO admin_roles(name,description,system) VALUES($1,$2,$3) ON CONFLICT(name) DO UPDATE SET name=EXCLUDED.name RETURNING id`,[role.name,role.description,role.system]);
      const roleId=result.rows[0]?.id;
      if (!roleId) continue;
      for (const key of role.keys) await client.query('INSERT INTO admin_role_permissions(role_id,permission_key) VALUES($1,$2) ON CONFLICT DO NOTHING',[roleId,key]);
      const email = `${role.name === 'Catalog editor' ? 'catalog' : role.name.toLowerCase()}@souk.local`;
      const user = await client.query<{id:string}>(`INSERT INTO admin_users(email,name,password_hash) VALUES($1,$2,$3) ON CONFLICT(email) DO UPDATE SET email=EXCLUDED.email RETURNING id`,[email,role.name,hashPassword(password)]);
      if (user.rows[0]) await client.query('INSERT INTO admin_user_roles(admin_user_id,role_id) VALUES($1,$2) ON CONFLICT DO NOTHING',[user.rows[0].id,roleId]);
    }
  }
  await client.query('COMMIT');
  console.log(`Seeded ${fixture.categories.length} categories, ${fixture.areas.length} areas and ${fixture.products.length} products`);
} catch (error) {
  await client.query('ROLLBACK');
  throw error;
} finally {
  client.release();
  await pool.end();
}
