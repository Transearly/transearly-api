import { Injectable } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bull';
import { Queue } from 'bull';
import axios from 'axios';
import vision from '@google-cloud/vision';

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
  async translateImageDirect(file: Express.Multer.File, targetLanguage: string): Promise<any> {
    try {
      // Step 1: Use Google Cloud Vision API for accurate text detection
      console.log('[Vision API] Starting text detection...');

      const client = new vision.ImageAnnotatorClient();

      const [result] = await client.textDetection({
        image: { content: file.buffer },
      });

      const detections = result.textAnnotations;

      if (!detections || detections.length === 0) {
        console.log('[Vision API] No text detected');
        return { segments: [] };
      }

      // Get image dimensions from the first detection
      const fullTextAnnotation = result.fullTextAnnotation;
      const imageWidth = fullTextAnnotation?.pages?.[0]?.width || 1000;
      const imageHeight = fullTextAnnotation?.pages?.[0]?.height || 1000;

      // Step 2: Group text by blocks (paragraphs, lines, words)
      // Use blocks and paragraphs from fullTextAnnotation for better grouping
      const segments: any[] = [];

      if (fullTextAnnotation?.pages) {
        for (const page of fullTextAnnotation.pages) {
          for (const block of page.blocks || []) {
            for (const paragraph of block.paragraphs || []) {
              // Combine all words in the paragraph
              const words: string[] = [];
              let minX = Infinity, minY = Infinity, maxX = 0, maxY = 0;

              for (const word of paragraph.words || []) {
                // Build word from symbols
                const wordText = word.symbols?.map(s => s.text).join('') || '';
                words.push(wordText);

                // Calculate bounding box
                const vertices = word.boundingBox?.vertices || [];
                for (const v of vertices) {
                  minX = Math.min(minX, v.x || 0);
                  minY = Math.min(minY, v.y || 0);
                  maxX = Math.max(maxX, v.x || 0);
                  maxY = Math.max(maxY, v.y || 0);
                }
              }

              // Join words with space for better readability
              const text = words.join(' ');
              if (!text.trim()) continue;

              segments.push({
                position: {
                  x: (minX / imageWidth) * 100,
                  y: (minY / imageHeight) * 100,
                  width: ((maxX - minX) / imageWidth) * 100,
                  height: ((maxY - minY) / imageHeight) * 100,
                },
                original: text,
                translated: '', // Will be filled by AI
              });
            }
          }
        }
      }

      console.log('[Vision API] Grouped into', segments.length, 'text segments');

      // Step 3: Batch translate all text segments using AI
      if (segments.length > 0) {
        const textsToTranslate = segments.map((s) => s.original).join('\n');

        const systemPrompt = `You are a professional translation engine. Translate each line into ${targetLanguage}. Preserve the number of lines and order. Return only the translated text, one line per input line.`;

        const payload = {
          model: this.model,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: textsToTranslate },
          ],
          temperature: 0,
        };

        const response = await axios.post(this.apiUrl, payload, {
          headers: this.getHeaders(),
        });

        const translatedText = response.data?.choices?.[0]?.message?.content?.trim();
        if (!translatedText) throw new Error('Translation API returned empty response');

        const translatedLines = translatedText.split('\n');

        // Map translations back to segments
        for (let i = 0; i < segments.length && i < translatedLines.length; i++) {
          segments[i].translated = translatedLines[i].trim();
        }
      }

      return { segments };
    } catch (error) {
      console.error('[Vision API] Error:', error.message);
      // Fallback to AI vision if Google Cloud Vision fails
      return this.translateImageWithVision(file, targetLanguage);
    }
  }

  // Fallback method using AI vision (old approach)
  private async translateImageWithVision(file: Express.Multer.File, targetLanguage: string): Promise<any> {
    const base64 = file.buffer.toString('base64');

    const systemPrompt = `
      You are a professional visual translation assistant with OCR capabilities.
      Your task:
      1. Detect all text regions in the image with their bounding box coordinates
      2. Extract the original text from each region
      3. Translate each text segment into ${targetLanguage}

      You MUST respond with a valid JSON object in this exact format:
      {
        "segments": [
          {
            "position": {
              "x": <percentage from left, 0-100>,
              "y": <percentage from top, 0-100>,
              "width": <percentage width, 0-100>,
              "height": <percentage height, 0-100>
            },
            "original": "<original text>",
            "translated": "<translated text>"
          }
        ]
      }

      Important:
      - Position coordinates should be percentages (0-100) relative to image dimensions
      - If no text is found, return {"segments": []}
      - Return ONLY the JSON, no markdown code blocks or explanations
    `;

    const payload = {
      model: this.model,
      messages: [
        { role: 'system', content: systemPrompt },
        {
          role: 'user',
          content: [
            { type: 'text', text: 'Detect and translate all text in this image:' },
            {
              type: 'image_url',
              image_url: `data:${file.mimetype};base64,${base64}`,
            },
          ],
        },
      ],
      temperature: 0,
      response_format: { type: 'json_object' },
    };

    const response = await axios.post(this.apiUrl, payload, {
      headers: this.getHeaders(),
    });

    const content =
      response.data?.choices?.[0]?.message?.content?.trim() ??
      response.data?.choices?.[0]?.message?.content?.[0]?.text?.trim();

    if (!content) throw new Error('Invalid or empty AI response.');

    // Parse JSON response
    let result;
    try {
      const cleanContent = content.replace(/```json\n?|\n?```/g, '').trim();
      result = JSON.parse(cleanContent);
    } catch (error) {
      throw new Error(`Failed to parse AI response as JSON: ${error.message}`);
    }

    if (!result.segments || !Array.isArray(result.segments)) {
      throw new Error('Invalid response structure: missing segments array');
    }

    return result;
  }
}
