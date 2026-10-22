import { Router } from 'express';
import type { Request } from 'express';
import { createHash } from 'node:crypto';
import { pool } from './db.js';
import { ApiError, asText, localeOf, moneyInt, positiveInt, send, siteOrigin } from './http.js';

export interface Product {
  id: string; slug: string; name: string; nameEn: string; categoryId: string; unitType: string;
  unitLabel: string; unitLabelEn: string; estimatedWeightKg: { min: number; max: number };
  price: number; pricePerKgEstimate: number; cover: { url: string; width: number; height: number };
  availability: { inStock: boolean; maxPerOrder: number }; priceUpdatedAt: string;
  tags: string[]; description: string; descriptionEn: string; capturedAt?: string;
  images: string[]; videoUrl: string | null; videoPosterUrl: string | null;
  priceChange?: { previousPrice: number; direction: 'up' | 'down' };
}
export interface Category { id: string; slug: string; name: string; nameEn: string; productCount: number; imageUrl: string; sortOrder: number }
type Raw = Record<string, unknown>;
const date = (value: unknown): string => value instanceof Date ? value.toISOString() : String(value ?? '');
const numeric = (value: unknown): number => Number(value ?? 0);

export async function allCategories(): Promise<Category[]> {
  const rows = (await pool.query(`SELECT c.*, count(p.id)::int AS product_count FROM categories c LEFT JOIN products p ON p.category_id=c.id GROUP BY c.id ORDER BY c.sort_order,c.slug`)).rows as Raw[];
  return rows.map(row => ({ id: String(row['id']), slug: String(row['slug']), name: String(row['name_ar']), nameEn: String(row['name_en']), productCount: numeric(row['product_count']), imageUrl: String(row['image_url'] ?? ''), sortOrder: numeric(row['sort_order']) }));
}
export async function allAreas(ids?: string[]): Promise<{ id: string; name: string; nameEn: string; shippingFee: number; isActive: boolean }[]> {
  const rows = (await pool.query(`SELECT * FROM delivery_areas ${ids ? 'WHERE id = ANY($1::text[])' : ''} ORDER BY name_en`, ids ? [ids] : [])).rows as Raw[];
  return rows.map(row => ({ id: String(row['id']), name: String(row['name_ar']), nameEn: String(row['name_en']), shippingFee: numeric(row['shipping_fee_minor']), isActive: Boolean(row['is_active']) }));
}
export async function allProducts(ids?: string[]): Promise<Product[]> {
  const rows = (await pool.query(`SELECT p.*,c.slug AS category_slug,m.url AS cover_url,m.width AS cover_width,m.height AS cover_height,
    (SELECT array_agg(t.text ORDER BY t.text) FROM product_tags pt JOIN tags t ON t.id=pt.tag_id WHERE pt.product_id=p.id) AS tags,
    (SELECT pm.captured_at FROM product_media pm WHERE pm.product_id=p.id ORDER BY pm.sort_order LIMIT 1) AS captured_at,
    (SELECT array_agg(pm.url ORDER BY pm.sort_order,pm.id) FROM product_media pm WHERE pm.product_id=p.id AND pm.media_type='image') AS media_images,
    (SELECT pm.url FROM product_media pm WHERE pm.product_id=p.id AND pm.media_type='video' ORDER BY pm.sort_order,pm.id LIMIT 1) AS media_video_url,
    (SELECT pm.poster_url FROM product_media pm WHERE pm.product_id=p.id AND pm.media_type='video' ORDER BY pm.sort_order,pm.id LIMIT 1) AS media_video_poster_url,
    (SELECT h.previous_price_minor FROM product_price_history h WHERE h.product_id=p.id ORDER BY h.changed_at DESC LIMIT 1) AS previous_price_minor
    FROM products p JOIN categories c ON c.id=p.category_id LEFT JOIN product_media m ON m.id=p.cover_media_id ${ids ? 'WHERE p.id = ANY($1::uuid[])' : ''} ORDER BY p.created_at,p.slug`, ids ? [ids] : [])).rows as Raw[];
  return rows.map(row => {
    const price = numeric(row['price_minor']);
    const weightMin = numeric(row['weight_min_kg']), weightMax = numeric(row['weight_max_kg']);
    const previousPrice = row['previous_price_minor'] === null ? undefined : numeric(row['previous_price_minor']);
    return {
      id: String(row['id']), slug: String(row['slug']), name: String(row['name_ar']), nameEn: String(row['name_en']), categoryId: String(row['category_id']),
      unitType: String(row['unit_type']), unitLabel: String(row['unit_label_ar']), unitLabelEn: String(row['unit_label_en']),
      estimatedWeightKg: { min: weightMin, max: weightMax }, price, pricePerKgEstimate: Math.round(price / ((weightMin + weightMax) / 2)),
      cover: { url: String(row['cover_url'] ?? '/assets/products/placeholder.svg'), width: numeric(row['cover_width'] ?? 640), height: numeric(row['cover_height'] ?? 480) },
      availability: { inStock: Boolean(row['in_stock']), maxPerOrder: numeric(row['max_per_order']) }, priceUpdatedAt: date(row['price_updated_at']),
      tags: Array.isArray(row['tags']) ? row['tags'].map(String) : [], description: String(row['description_ar']), descriptionEn: String(row['description_en']),
      images: Array.isArray(row['media_images']) ? row['media_images'].map(String) : [],
      videoUrl: row['media_video_url'] ? String(row['media_video_url']) : null,
      videoPosterUrl: row['media_video_poster_url'] ? String(row['media_video_poster_url']) : null,
      ...(row['captured_at'] ? { capturedAt: date(row['captured_at']) } : {}),
      ...(previousPrice !== undefined ? { priceChange: { previousPrice, direction: previousPrice > price ? 'down' as const : 'up' as const } } : {}),
    };
  });
}
export async function publicConfig(): Promise<Raw> {
  const result = await pool.query<{ value: Raw }>('SELECT value FROM site_config WHERE id=true');
  if (!result.rows[0]) throw new ApiError(503, 'SERVICE_UNAVAILABLE', 'Site configuration is not seeded');
  const publicSections=['brand','theme','commerce','locales','contact','features','seo'];
  return { ...Object.fromEntries(publicSections.filter(key=>key in result.rows[0]!.value).map(key=>[key,result.rows[0]!.value[key]])), apiBaseUrl: process.env['PUBLIC_API_BASE_URL'] || '/v1' };
}
const normalize = (value: string): string => value.toLocaleLowerCase().normalize('NFKD').replace(/[\u064b-\u065f\u0670\u0640]/g, '').replace(/[أإآ]/g, 'ا').replace(/ى/g, 'ي').replace(/ة/g, 'ه').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
const score = (product: Product, term: string): number => {
  const q = normalize(term), name = normalize(`${product.name} ${product.nameEn}`);
  if (!q) return 1;
  if (name === q) return 100;
  if (name.startsWith(q)) return 70;
  if (name.includes(q)) return 50;
  return q.split(' ').every(token => name.split(' ').some(word => word.includes(token))) ? 20 : 0;
};
type Filters = { q: string; categorySlug: string; categoryIds: string[]; unitTypes: string[]; tags: string[]; priceMin: number; priceMax: number; perKgMin: number; perKgMax: number; inStock: boolean; sort: string; page: number; pageSize: number; includeFacets: boolean };
const csv = (value: unknown): string[] => asText(value, 500).split(',').map(item => item.trim()).filter(Boolean).slice(0, 30);
function filters(req: Request): Filters {
  const q = asText(req.query['q'], 80);
  if (typeof req.query['q'] === 'string' && req.query['q'].length > 80) throw new ApiError(400, 'QUERY_TOO_LONG', 'Search query is too long');
  const priceMin = moneyInt(req.query['priceMin'], 0), priceMax = moneyInt(req.query['priceMax'], Number.MAX_SAFE_INTEGER);
  const perKgMin = moneyInt(req.query['perKgMin'], 0), perKgMax = moneyInt(req.query['perKgMax'], Number.MAX_SAFE_INTEGER);
  if (priceMin > priceMax || perKgMin > perKgMax) throw new ApiError(400, 'INVALID_FILTER', 'Minimum cannot exceed maximum');
  const unitTypes = csv(req.query['unitTypes']);
  if (unitTypes.some(unit => !['crate','sack','carton','basket','bundle'].includes(unit))) throw new ApiError(400, 'INVALID_FILTER', 'Unknown unit type');
  const sort = asText(req.query['sort']) || (q ? 'relevance' : 'default');
  if (!['default','relevance','price_asc','price_desc','perkg_asc','popular','newest','name'].includes(sort)) throw new ApiError(400, 'INVALID_FILTER', 'Unknown sort');
  return { q, categorySlug: asText(req.query['categorySlug']), categoryIds: csv(req.query['categoryIds']), unitTypes, tags: csv(req.query['tags']), priceMin, priceMax, perKgMin, perKgMax, inStock: req.query['inStock'] !== 'false' && req.query['inStock'] !== '0', sort, page: positiveInt(req.query['page'], 1, 100000), pageSize: positiveInt(req.query['pageSize'], 24, 60), includeFacets: csv(req.query['include']).includes('facets') };
}
function filtered(products: Product[], categories: Category[], f: Filters, ignore?: string): Product[] {
  const slugId = categories.find(category => category.slug === f.categorySlug)?.id;
  return products.filter(product => (!f.q || score(product, f.q) > 0) && (!f.categorySlug || product.categoryId === slugId)
    && (ignore === 'categories' || !f.categoryIds.length || f.categoryIds.includes(product.categoryId))
    && (ignore === 'unitTypes' || !f.unitTypes.length || f.unitTypes.includes(product.unitType))
    && (ignore === 'price' || product.price >= f.priceMin && product.price <= f.priceMax)
    && (ignore === 'perKg' || product.pricePerKgEstimate >= f.perKgMin && product.pricePerKgEstimate <= f.perKgMax)
    && (ignore === 'availability' || !f.inStock || product.availability.inStock)
    && (ignore === 'tags' || f.tags.every(tag => product.tags.includes(tag))));
}
function facets(products: Product[], categories: Category[], f: Filters): Raw {
  const by = (group: string) => filtered(products, categories, f, group);
  const bounds = (items: Product[], key: 'price' | 'pricePerKgEstimate') => ({ min: items.length ? Math.min(...items.map(item => item[key])) : 0, max: items.length ? Math.max(...items.map(item => item[key])) : 0 });
  const tags = [...new Set(products.flatMap(product => product.tags))];
  return { categories: categories.map(category => ({ id: category.id, slug: category.slug, name: category.name, count: by('categories').filter(product => product.categoryId === category.id).length })),
    unitTypes: ['crate','sack','carton','basket','bundle'].map(value => ({ value, label: value, count: by('unitTypes').filter(product => product.unitType === value).length })),
    price: bounds(by('price'), 'price'), perKg: bounds(by('perKg'), 'pricePerKgEstimate'),
    availability: { inStock: by('availability').filter(product => product.availability.inStock).length, outOfStock: by('availability').filter(product => !product.availability.inStock).length },
    tags: tags.map(value => ({ value, label: value, count: by('tags').filter(product => product.tags.includes(value)).length })) };
}
function orderProducts(products: Product[], f: Filters): Product[] {
  const sorted = [...products];
  sorted.sort((a,b) => {
    if (f.sort === 'price_asc') return a.price-b.price;
    if (f.sort === 'price_desc') return b.price-a.price;
    if (f.sort === 'perkg_asc') return a.pricePerKgEstimate-b.pricePerKgEstimate;
    if (f.sort === 'popular') return Number(b.tags.includes('popular'))-Number(a.tags.includes('popular'));
    if (f.sort === 'newest') return b.priceUpdatedAt.localeCompare(a.priceUpdatedAt);
    if (f.sort === 'name') return a.name.localeCompare(b.name,'ar');
    if (f.sort === 'relevance') return score(b,f.q)-score(a,f.q);
    return a.slug.localeCompare(b.slug);
  });
  return sorted;
}
export const publicRouter = Router();
publicRouter.get('/health', async (_req,res) => { await pool.query('SELECT 1'); send(res,{ status:'ok', database:'ok', time:new Date().toISOString() }); });
publicRouter.get('/config/site', async (_req,res) => send(res, await publicConfig()));
publicRouter.get('/content/strings', async (req,res) => {
  const rows = await pool.query<{ key: string; value: string }>('SELECT key,value FROM content_strings WHERE locale=$1', [localeOf(req)]);
  send(res, Object.fromEntries(rows.rows.map(row => [row.key,row.value])));
});
publicRouter.get('/categories', async (_req,res) => send(res, await allCategories()));
publicRouter.get('/areas', async (_req,res) => send(res, await allAreas()));
publicRouter.get('/announcements', async (_req,res) => {
  const rows = (await pool.query('SELECT id,text_ar,text_en FROM announcements WHERE active=true ORDER BY sort_order,id')).rows as Raw[];
  send(res, rows.map(row => ({ id: String(row['id']), textAr: String(row['text_ar']), textEn: String(row['text_en']) })));
});
publicRouter.get('/products', async (req,res) => {
  const [products,categories] = await Promise.all([allProducts(),allCategories()]), f = filters(req), result = orderProducts(filtered(products,categories,f),f);
  const total = result.length;
  send(res,result.slice((f.page-1)*f.pageSize,f.page*f.pageSize), { page:f.page, pageSize:f.pageSize, total, totalPages:Math.ceil(total/f.pageSize), sortApplied:f.sort,
    appliedFilters:{categoryIds:f.categoryIds,unitTypes:f.unitTypes,priceMin:f.priceMin,priceMax:f.priceMax,inStock:f.inStock},
    ...(f.q ? { query:{raw:f.q,normalized:normalize(f.q)} } : {}), ...(f.includeFacets ? {facets:facets(products,categories,f)} : {}) });
});
publicRouter.get('/products/facets', async (req,res) => {
  const [products,categories] = await Promise.all([allProducts(),allCategories()]);
  send(res,facets(products,categories,filters(req)));
});
publicRouter.get('/products/:slug', async (req,res) => {
  const products = await allProducts(), product = products.find(item => item.slug === req.params['slug']);
  if (!product) throw new ApiError(404,'PRODUCT_NOT_FOUND','Product not found');
  const mediaRows = (await pool.query('SELECT url,media_type,width,height,poster_url,captured_at FROM product_media WHERE product_id=$1 ORDER BY sort_order,id',[product.id])).rows as Raw[];
  send(res,{...product,media:mediaRows.map(row => ({url:String(row['url']),width:numeric(row['width'] ?? 640),height:numeric(row['height'] ?? 480),type:String(row['media_type']),...(row['poster_url'] ? {posterUrl:String(row['poster_url'])} : {}),...(row['captured_at'] ? {capturedAt:date(row['captured_at'])} : {})})),related:products.filter(item => item.categoryId===product.categoryId && item.id!==product.id).slice(0,4)});
});
publicRouter.get('/faq', async (_req,res) => {
  const rows = (await pool.query('SELECT * FROM faqs ORDER BY sort_order,id')).rows as Raw[];
  send(res,rows.map(row=>({id:String(row['id']),question:String(row['question']),answer:String(row['answer']),sortOrder:numeric(row['sort_order'])})));
});
publicRouter.get('/pages/:slug', async (req,res) => {
  const result = await pool.query<{slug:string;title:string;body_html:string;updated_at:Date}>('SELECT * FROM static_pages WHERE slug=$1',[req.params['slug']]);
  const row=result.rows[0]; if(!row) throw new ApiError(404,'PAGE_NOT_FOUND','Page not found');
  send(res,{slug:row.slug,title:row.title,bodyHtml:row.body_html,updatedAt:row.updated_at.toISOString()});
});
publicRouter.post('/contact', async (req,res) => {
  const name=asText(req.body?.name,120),phone=asText(req.body?.phone,30),message=asText(req.body?.message,4000);
  if(!name || !message || (!phone && !asText(req.body?.email))) throw new ApiError(400,'VALIDATION_FAILED','Name, contact and message are required');
  const subject=createHash('sha256').update(req.ip||'unknown').digest('hex');
  const limit=await pool.query<{count:number}>("INSERT INTO auth_attempts(subject_key,action,window_start,count) VALUES($1,'contact',date_trunc('hour',now()),1) ON CONFLICT(subject_key,action,window_start) DO UPDATE SET count=auth_attempts.count+1 RETURNING count",[subject]);
  if((limit.rows[0]?.count??0)>5) throw new ApiError(429,'RATE_LIMITED','Try again later');
  await pool.query('INSERT INTO contact_messages(name,phone,email,message) VALUES($1,$2,$3,$4)',[name,phone||null,asText(req.body?.email,200)||null,message]);
  send(res,{ok:true});
});
publicRouter.get('/search/suggest', async (req,res) => {
  const q=asText(req.query['q'],80); if(normalize(q).length<2) throw new ApiError(400,'QUERY_TOO_SHORT','At least two characters required');
  const [products,categories]=await Promise.all([allProducts(),allCategories()]);
  send(res,{products:products.filter(item=>score(item,q)>0).sort((a,b)=>score(b,q)-score(a,q)).slice(0,5).map(item=>({id:item.id,slug:item.slug,name:localeOf(req)==='en'?item.nameEn:item.name,unitLabel:localeOf(req)==='en'?item.unitLabelEn:item.unitLabel,price:item.price,thumbUrl:item.cover.url,inStock:item.availability.inStock})),
    categories:categories.filter(item=>normalize(`${item.name} ${item.nameEn}`).includes(normalize(q))).slice(0,3).map(item=>({id:item.id,slug:item.slug,name:localeOf(req)==='en'?item.nameEn:item.name})),queries:[]});
});
publicRouter.get('/search/popular', async (req,res) => {
  const limit=positiveInt(req.query['limit'],10,30), rows=await pool.query<{query:string;count:string}>('SELECT query,count(*)::int AS count FROM search_events WHERE query IS NOT NULL GROUP BY query ORDER BY count DESC LIMIT $1',[limit]);
  send(res,{queries:rows.rows.map(row=>row.query),categories:(await allCategories()).slice(0,3)});
});
publicRouter.post('/search/track', async (req,res) => {
  const query=asText(req.body?.q,80), productId=asText(req.body?.clickedProductId,80);
  if(query) await pool.query('INSERT INTO search_events(query,selected_product_id,locale) VALUES($1,(SELECT id FROM products WHERE id::text=$2 OR slug=$2 LIMIT 1),$3)',[query,productId,localeOf(req)]);
  res.status(204).end();
});
publicRouter.get('/seo/resolve', async (req,res) => {
  const config=await publicConfig(), brand=config['brand'] as Raw, seo=config['seo'] as Raw, locale=localeOf(req);
  const raw=asText(req.query['path'],1000)||'/', path=raw.split('?')[0]||'/', products=await allProducts(), categories=await allCategories();
  const product=path.startsWith('/products/')?products.find(item=>item.slug===path.split('/')[2]):undefined;
  const category=path.startsWith('/catalog/')?categories.find(item=>item.slug===path.split('/')[2]):undefined;
  const brandName=String(brand[locale==='ar'?'nameAr':'nameEn']);
  const page=product?(locale==='ar'?product.name:product.nameEn):category?(locale==='ar'?category.name:category.nameEn):path==='/catalog'?(locale==='ar'?'المنتجات':'Products'):brandName;
  const title=page===brandName?brandName:`${page} | ${brandName}`;
  const description=product?(locale==='ar'?product.description:product.descriptionEn):String(seo[locale==='ar'?'descriptionAr':'descriptionEn']);
  const privatePage=['/checkout','/cart','/orders','/account','/login','/register','/error','/offline','/maintenance'].some(prefix=>path.startsWith(prefix));
  send(res,{title,description,canonicalUrl:`${siteOrigin()}${path}`,robots:privatePage||raw.includes('?')?'noindex,follow':'index,follow',og:{title,description,image:'/assets/illustrations/tricycle-1.svg',type:product?'product':'website'}});
});
publicRouter.get('/seo/sitemap', async (_req,res) => {
  const [products,categories]=await Promise.all([allProducts(),allCategories()]);
  send(res,[{path:'/',lastmod:new Date().toISOString(),changefreq:'daily',priority:1},...categories.map(item=>({path:`/catalog/${item.slug}`,lastmod:new Date().toISOString(),changefreq:'daily',priority:0.8})),...products.map(item=>({path:`/products/${item.slug}`,lastmod:item.priceUpdatedAt,changefreq:'daily',priority:0.6}))]);
});
