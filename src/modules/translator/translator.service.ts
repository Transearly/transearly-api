import { Injectable } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bull';
import { Queue } from 'bull';
import axios from 'axios';

@Injectable()
export class TranslatorService {
  private readonly apiUrl: string;
  private readonly apiKey: string;
  private readonly model: string;
  private readonly referer: string;
  private readonly appName: string;

  constructor(
    @InjectQueue('translation-queue') private readonly translationQueue: Queue,
  ) {
    this.apiUrl = process.env.OPENROUTER_BASE_URL!;
    this.apiKey = process.env.OPENROUTER_API_KEY!;
    this.model = process.env.OPENROUTER_MODEL!;
    this.referer = process.env.OPENROUTER_REFERER || 'http://localhost:5010';
    this.appName = process.env.OPENROUTER_APP_NAME || 'Transearly Service';

    if (!this.apiUrl || !this.apiKey || !this.model) {
      throw new Error('Missing OpenRouter API configuration in environment.');
    }
  }

  // ================== JOB QUEUE ==================
  async startTranslationJob(
    file: Express.Multer.File,
    targetLanguage: string = 'Vietnamese',
    socketId: string,
    isUserPremium: boolean,
  ) {
    const jobData = {
      buffer: file.buffer,
      originalname: file.originalname,
      targetLanguage,
      socketId,
      isUserPremium,
    };

    const jobOptions = {
      removeOnComplete: true,
      removeOnFail: true,
    };

    return this.translationQueue.add(jobData, jobOptions);
  }

  async getJobStatus(jobId: string) {
    const job = await this.translationQueue.getJob(jobId);
    if (!job) return { status: 'not_found' };

    if (await job.isCompleted())
      return { status: 'completed', result: job.returnvalue };

    if (await job.isFailed())
      return { status: 'failed', reason: job.failedReason };

    return { status: 'processing' };
  }

  // ================== COMMON HEADERS ==================
  private getHeaders() {
    return {
      Authorization: `Bearer ${this.apiKey}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': this.referer,
      'X-Title': this.appName,
    };
  }

  // ================== TEXT TRANSLATION ==================
  async translateTextDirect(text: string, targetLanguage: string): Promise<string> {
    const systemPrompt = [
      'You are a professional translation engine.',
      `Translate the user content into ${targetLanguage}.`,
      'Preserve semantic meaning and formatting.',
      'Return only the translated text without comments.',
    ].join(' ');

    const payload = {
      model: this.model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: text },
      ],
      temperature: 0,
    };

    const response = await axios.post(this.apiUrl, payload, {
      headers: this.getHeaders(),
    });

    const translated = response.data?.choices?.[0]?.message?.content;
    if (!translated) throw new Error('Invalid response from translation API.');

    return translated.trim();
  }

  // ================== IMAGE TRANSLATION ==================
  async translateImageDirect(file: Express.Multer.File, targetLanguage: string) {
    const base64 = file.buffer.toString('base64');

    const systemPrompt = `
      You are a professional visual translation assistant.
      Your task: read any text visible in the image and translate it into ${targetLanguage}.
      Output only the translated text (no explanations or markup).
    `;

    const payload = {
      model: this.model,
      messages: [
        { role: 'system', content: systemPrompt },
        {
          role: 'user',
          content: [
            { type: 'text', text: 'Translate this image:' },
            {
              type: 'image_url',
              image_url: `data:${file.mimetype};base64,${base64}`,
            },
          ],
        },
      ],
      temperature: 0,
    };

    const response = await axios.post(this.apiUrl, payload, {
      headers: this.getHeaders(),
    });

    const translated =
      response.data?.choices?.[0]?.message?.content?.trim() ??
      response.data?.choices?.[0]?.message?.content?.[0]?.text?.trim();

    if (!translated) throw new Error('Invalid or empty AI response.');

    return translated;
  }
}
