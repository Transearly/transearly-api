import { Injectable } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bull';
import { Queue } from 'bull';
import axios from 'axios';

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


  async translateTextDirect(text: string, targetLanguage: string): Promise<string> {
    const apiUrl = process.env.OPENROUTER_BASE_URL;
    const apiKey = process.env.OPENROUTER_API_KEY;
    const model = process.env.OPENROUTER_MODEL;
    const referer = process.env.OPENROUTER_REFERER || 'http://localhost:5010';
    const appName = process.env.OPENROUTER_APP_NAME || 'Transearly Service';

    if (!apiUrl || !apiKey || !model) {
      throw new Error('Missing OpenRouter API configuration in environment.');
    }

    const systemPrompt = [
      'You are a professional translation engine.',
      `Translate the user content into ${targetLanguage}.`,
      'Preserve semantic meaning and formatting.',
      'Return only the translated text without comments.',
    ].join(' ');

    const payload = {
      model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: text },
      ],
      temperature: 0,
    };

    const headers = {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': referer,
      'X-Title': appName,
    };

    const response = await axios.post(apiUrl, payload, { headers });

    const translated = response.data?.choices?.[0]?.message?.content;
    if (!translated) throw new Error('Invalid response from translation API.');

    return translated.trim();
  }
}
