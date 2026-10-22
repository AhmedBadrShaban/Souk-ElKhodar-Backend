ALTER TABLE product_media
  ADD COLUMN IF NOT EXISTS storage_key text,
  ADD COLUMN IF NOT EXISTS byte_size bigint,
  ADD COLUMN IF NOT EXISTS content_type text;

CREATE UNIQUE INDEX IF NOT EXISTS product_media_storage_key_unique
  ON product_media(storage_key) WHERE storage_key IS NOT NULL;
