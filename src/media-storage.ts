import { DeleteObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { ApiError } from './http.js';

let storageClient: S3Client | undefined;

function settings(): { endpoint: string; bucket: string; client: S3Client } {
  const endpoint = process.env['AWS_ENDPOINT_URL_S3'];
  const accessKeyId = process.env['AWS_ACCESS_KEY_ID'];
  const secretAccessKey = process.env['AWS_SECRET_ACCESS_KEY'];
  const region = process.env['AWS_REGION'];
  const bucket = process.env['S3_BUCKET'];
  if (!endpoint || !accessKeyId || !secretAccessKey || !region || !bucket || !/^https:\/\//.test(endpoint)) {
    throw new ApiError(503, 'MEDIA_STORAGE_UNAVAILABLE', 'Product media storage is not configured');
  }
  storageClient ??= new S3Client({
    endpoint,
    region,
    forcePathStyle: true,
    credentials: { accessKeyId, secretAccessKey },
  });
  return { endpoint: endpoint.replace(/\/$/, ''), bucket, client: storageClient };
}

export async function putMedia(key: string, body: Buffer, contentType: string): Promise<string> {
  const { endpoint, bucket, client } = settings();
  await client.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: body, ContentType: contentType }));
  return `${endpoint}/${encodeURIComponent(bucket)}/${key.split('/').map(encodeURIComponent).join('/')}`;
}

export async function deleteMedia(key: string): Promise<void> {
  const { bucket, client } = settings();
  await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
}
