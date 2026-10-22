# Render API and Neon PostgreSQL

1. Create a Neon database and copy its **direct, non-pooled** connection string with `?sslmode=require`. From your PC, set `DATABASE_URL` in the process environment only while running `npm run migrate`; optionally run `npm run seed` the same way for demo data. For example, in PowerShell, run the block below after replacing the placeholder locally. It restores the previous process value even if the command fails. Use the direct URL for migrations, never the pooled URL.

   ```powershell
   $previousDatabaseUrl = $env:DATABASE_URL
   try {
     $env:DATABASE_URL = 'postgresql://USER:PASSWORD@ep-example.neon.tech/neondb?sslmode=require'
     npm run migrate
     # Optional demo data: npm run seed
   } finally {
     $env:DATABASE_URL = $previousDatabaseUrl
   }
   ```

   Keep connection strings out of source control. Avoid saving a real connection string in shell history; paste it into an ignored local script or set it through your shell's secret manager instead.
2. Create a Render Blueprint from this repository's `render.yaml`. It creates one free Node web service and no database.
3. In Render, set `DATABASE_URL` to Neon's **pooled** connection string with `?sslmode=require`. Set `STOREFRONT_ORIGIN` and `DASHBOARD_ORIGIN` to the exact HTTPS origins of the deployed portals, without trailing slashes. Set `BUSINESS_TIMEZONE` (for example `Africa/Cairo`) and a long random `TRACKING_TOKEN_SECRET`. The latter is required by existing guest order tracking. Render supplies `PORT`.
4. Create a public-read object-storage bucket named `products` on the same Neon branch used by the API database. Set `AWS_ENDPOINT_URL_S3`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_REGION`, and `S3_BUCKET=products` only in the backend environment. Rotate any key that has been shared in chat. In the dashboard's product editor, save a product first, then upload its media. The backend uploads to storage and records the object key plus public URL in `product_media`. Limits are 4 images (8 MB each) and 2 videos (50 MB each) per product. Existing storefront asset images count toward the image limit. The old `products.images` and video URL columns are no longer used by the API.
5. Check `https://YOUR-RENDER-SERVICE.onrender.com/v1/health`; expect `data.status` and `data.database` to both be `ok`. Then point the storefront and dashboard API settings to this origin and test both portals.

## Free tier limits

[Render free web services](https://render.com/docs/free) sleep after 15 minutes without traffic and can take about a minute to wake. [Neon free compute](https://neon.com/docs/manage/endpoints/) can scale to zero while idle. Store media in a public bucket, never in PostgreSQL or on Render's ephemeral disk.
