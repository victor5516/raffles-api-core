import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
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

  constructor(private readonly configService: ConfigService) {
    this.bucket = this.configService.getOrThrow<string>('S3_BUCKET');

    // Credentials are read from env automatically by the AWS SDK:
    // AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY / AWS_SESSION_TOKEN (optional)
    this.client = new S3Client({
      region: this.configService.getOrThrow<string>('AWS_REGION'),
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

  async getPresignedGetUrl(
    key: string | undefined | null,
    expiresSeconds = 900,
  ): Promise<string | undefined | null> {
    if (!key) return key;
    if (this.isHttpUrl(key)) return key;

    const cmd = new GetObjectCommand({
      Bucket: this.bucket,
      Key: key,
    });

    return await getSignedUrl(this.client, cmd, { expiresIn: expiresSeconds });
  }

  private normalizePrefix(prefix: string) {
    if (!prefix) return '';
    return prefix.endsWith('/') ? prefix : `${prefix}/`;
  }

  private isHttpUrl(value: string) {
    return value.startsWith('http://') || value.startsWith('https://');
  }

  private getExtension(originalName: string) {
    const idx = originalName.lastIndexOf('.');
    if (idx === -1) return '';
    const ext = originalName.slice(idx);
    return ext.length > 20 ? '' : ext;
  }
}
