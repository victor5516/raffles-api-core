import { Global, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { SqsService } from './sqs.service';

@Global()
@Module({
  imports: [ConfigModule],
  providers: [SqsService],
  exports: [SqsService],
})
export class SqsModule {}

