import { Injectable } from '@nestjs/common';
import { CreateTranslatorDto } from './dto/create-translator.dto';
import { UpdateTranslatorDto } from './dto/update-translator.dto';
import { InjectQueue } from '@nestjs/bull';
import { Queue } from 'bull';

@Injectable()
export class TranslatorService {
  constructor(
    @InjectQueue('translation-queue') private readonly translationQueue: Queue,
  ) {}

  async startTranslationJob(file: Express.Multer.File, targetLanguage: string = 'Vietnamese', socketId: string, isUserPremium: boolean) {
    const jobData = {
      buffer: file.buffer,
      originalname: file.originalname,
      targetLanguage: targetLanguage,
      socketId: socketId,
      isUserPremium: isUserPremium
    };

    const jobOptions = {
      removeOnComplete: true,
      removeOnFail: true
    };

    const job = await this.translationQueue.add(jobData, jobOptions);
    return job;
  }

  async getJobStatus(jobId: string) {
    const job = await this.translationQueue.getJob(jobId);
    if (!job) {
      return { status: 'not_found' };
    }

    const isCompleted = await job.isCompleted();
    const isFailed = await job.isFailed();

    if (isCompleted) {
      return { status: 'completed', result: job.returnvalue };
    }
    if (isFailed) {
      return { status: 'failed', reason: job.failedReason };
    }
    return { status: 'processing' };
  }
}
