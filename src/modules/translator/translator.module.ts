import { Module } from '@nestjs/common';
import { TranslatorService } from './translator.service';
import { TranslatorController } from './translator.controller';
import { BullModule } from '@nestjs/bull';
import { TranslatorProcessor } from './translator.processor';
import { EventsModule } from '../events/events.module';

@Module({
  imports: [
    BullModule.registerQueue({
      name: 'translation-queue',
    }),
    EventsModule,
  ],
  controllers: [TranslatorController],
  providers: [TranslatorService, TranslatorProcessor],
})
export class TranslatorModule {}
