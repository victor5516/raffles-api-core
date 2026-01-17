import { SendMessageCommand, SQSClient } from '@aws-sdk/client-sqs';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class SqsService {
  private readonly logger = new Logger(SqsService.name);
  private readonly client: SQSClient;
  private readonly purchasesQueueUrl: string;

  constructor(private readonly configService: ConfigService) {
    this.purchasesQueueUrl = this.configService.getOrThrow<string>(
      'SQS_PURCHASES_QUEUE_URL',
    );

    // Credentials are read from env automatically by the AWS SDK:
    // AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY / AWS_SESSION_TOKEN (optional)
    this.client = new SQSClient({
      region: this.configService.getOrThrow<string>('AWS_REGION'),
      credentials: {
        accessKeyId: this.configService.getOrThrow<string>('AWS_ACCESS_KEY_ID'),
        secretAccessKey: this.configService.getOrThrow<string>(
          'AWS_SECRET_ACCESS_KEY',
        ),
      },
    });
  }

  async sendPurchaseCreatedMessage(purchase: unknown): Promise<{
    messageId: string | undefined;
  }> {
    const res = await this.client.send(
      new SendMessageCommand({
        QueueUrl: this.purchasesQueueUrl,
        MessageBody: JSON.stringify(purchase),
      }),
    );

    if (!res.MessageId) {
      this.logger.warn(
        'SQS message sent but no MessageId returned by AWS SDK.',
      );
    }

    return { messageId: res.MessageId };
  }
}
