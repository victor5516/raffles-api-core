import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { randomUUID } from 'crypto';

type UploadBufferArgs = {
  keyPrefix: string;
  originalName: string;
  buffer: Buffer;
  contentType?: string;
};

@Injectable()
export class S3Service {
  private readonly client: S3Client;
  private readonly bucket: string;
  private readonly region: string;

  constructor(private readonly configService: ConfigService) {
    this.bucket = this.configService.getOrThrow<string>('S3_BUCKET');
    this.region = this.configService.getOrThrow<string>('AWS_REGION');

    // Credentials are read from env automatically by the AWS SDK:
    // AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY / AWS_SESSION_TOKEN (optional)
    this.client = new S3Client({
      region: this.region,
      credentials: {
        accessKeyId: this.configService.getOrThrow<string>('AWS_ACCESS_KEY_ID'),
        secretAccessKey: this.configService.getOrThrow<string>(
          'AWS_SECRET_ACCESS_KEY',
        ),
      },
    });
  }

  async uploadBuffer(args: UploadBufferArgs): Promise<{ key: string }> {
    const ext = this.getExtension(args.originalName);
    const key = `${this.normalizePrefix(args.keyPrefix)}${randomUUID()}${ext}`;

    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: args.buffer,
        ContentType: args.contentType,
      }),
    );

    return { key };
  }

  async deleteObject(key: string): Promise<void> {
    if (!key || this.isHttpUrl(key)) return;
    await this.client.send(
      new DeleteObjectCommand({ Bucket: this.bucket, Key: key }),
    );
  }

  async getPresignedGetUrl(
    key: string | undefined | null,
    expiresSeconds?: number,
  ): Promise<string | undefined | null> {
    if (!key) return key;
    const keyToSign = this.resolveS3KeyForSigning(key);
    if (!keyToSign) return key;

    const fromEnv = Number(
      this.configService.get<string>('S3_PRESIGN_EXPIRES_SECONDS'),
    );
    const expires =
      expiresSeconds ??
      (Number.isFinite(fromEnv) && fromEnv > 0 ? fromEnv : 900);

    const cmd = new GetObjectCommand({
      Bucket: this.bucket,
      Key: keyToSign,
    });

    return await getSignedUrl(this.client, cmd, { expiresIn: expires });
  }

  getCdnUrl(key: string | undefined | null): string | undefined | null {
    if (!key) return key;
    if (this.isHttpUrl(key)) return key;
    const cdnUrl = this.configService.get<string>('CLOUDFRONT_URL');
    if (!cdnUrl) return key;
    return `${cdnUrl.replace(/\/$/, '')}/${key.replace(/^\//, '')}`;
  }

  private normalizePrefix(prefix: string) {
    if (!prefix) return '';
    return prefix.endsWith('/') ? prefix : `${prefix}/`;
  }

  private isHttpUrl(value: string) {
    return value.startsWith('http://') || value.startsWith('https://');
  }

  private resolveS3KeyForSigning(
    value: string,
  ): string | null {
    if (!this.isHttpUrl(value)) {
      return value;
    }

    let parsed: URL;
    try {
      parsed = new URL(value);
    } catch {
      return null;
    }

    const host = parsed.hostname;
    const path = parsed.pathname.replace(/^\/+/, '');

    // Virtual-hosted-style: <bucket>.s3.<region>.amazonaws.com/<key>
    if (host === `${this.bucket}.s3.${this.region}.amazonaws.com`) {
      return path || null;
    }
    if (host === `${this.bucket}.s3.amazonaws.com`) {
      return path || null;
    }

    // Path-style: s3.<region>.amazonaws.com/<bucket>/<key>
    if (host === `s3.${this.region}.amazonaws.com`) {
      const bucketPrefix = `${this.bucket}/`;
      if (path === this.bucket) return null;
      if (path.startsWith(bucketPrefix)) {
        return path.slice(bucketPrefix.length) || null;
      }
      return null;
    }

    // Any external HTTP URL should pass through unchanged.
    return null;
  }

  private getExtension(originalName: string) {
    const idx = originalName.lastIndexOf('.');
    if (idx === -1) return '';
    const ext = originalName.slice(idx);
    return ext.length > 20 ? '' : ext;
  }
}
