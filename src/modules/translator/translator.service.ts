import { Injectable } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bull';
import { Queue } from 'bull';
import axios from 'axios';
import vision from '@google-cloud/vision';
import { SpeechClient } from '@google-cloud/speech';

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

  // ================== AUDIO TRANSLATION ==================
  async translateAudioDirect(file: Express.Multer.File, sourceLanguage: string, targetLanguage: string): Promise<any> {
    try {
      console.log('[Speech API] Starting audio transcription...');
      console.log('[Speech API] File size:', file.size, 'bytes');
      console.log('[Speech API] File type:', file.mimetype);
      console.log('[Speech API] Source language:', sourceLanguage);

      // Step 1: Convert audio to text using Google Cloud Speech-to-Text
      const client = new SpeechClient();

      // Determine audio encoding based on file type
      let encoding: 'MP3' | 'LINEAR16' | 'FLAC' | 'OGG_OPUS' | 'WEBM_OPUS' = 'MP3';

      if (file.mimetype === 'audio/wav' || file.mimetype === 'audio/wave') {
        encoding = 'LINEAR16';
      } else if (file.mimetype === 'audio/flac') {
        encoding = 'FLAC';
      } else if (file.mimetype === 'audio/ogg') {
        encoding = 'OGG_OPUS';
      } else if (file.mimetype === 'audio/webm') {
        encoding = 'WEBM_OPUS';
      } else if (file.mimetype === 'audio/mp4' || file.mimetype === 'audio/x-m4a' || file.mimetype === 'audio/3gpp') {
        // M4A and 3GP files - Google Speech API will auto-detect
        encoding = 'MP3'; // Use MP3 as default, API will handle M4A/3GP
      }

      const audio = {
        content: file.buffer.toString('base64'),
      };

      // Map language codes to Google Speech API language codes
      const languageCodeMap: Record<string, string> = {
        'auto': 'vi-VN',  // Default to Vietnamese when auto
        'vi': 'vi-VN',
        'en': 'en-US',
        'es': 'es-ES',
        'fr': 'fr-FR',
        'de': 'de-DE',
        'ja': 'ja-JP',
        'ko': 'ko-KR',
        'zh': 'zh-CN',
        'th': 'th-TH',
        'id': 'id-ID',
      };

      // Get primary language code
      const primaryLanguageCode = languageCodeMap[sourceLanguage] || 'vi-VN';

      // Build alternative language codes list (exclude the primary one)
      const allLanguages = ['vi-VN', 'en-US', 'es-ES', 'fr-FR', 'de-DE', 'ja-JP', 'ko-KR', 'zh-CN', 'zh-TW', 'th-TH', 'id-ID'];
      const alternativeLanguageCodes = sourceLanguage === 'auto'
        ? allLanguages.filter(lang => lang !== primaryLanguageCode)
        : []; // If specific language is selected, don't use alternatives

      const config = {
        encoding: encoding,
        sampleRateHertz: 16000,
        languageCode: primaryLanguageCode,
        ...(alternativeLanguageCodes.length > 0 && { alternativeLanguageCodes }),
        enableAutomaticPunctuation: true,
        model: 'latest_long',  // Use latest model for better accuracy
        useEnhanced: true,     // Enhanced model for better accuracy
        audioChannelCount: 1,  // Mono audio
      };

      console.log('[Speech API] Config:', JSON.stringify({
        languageCode: config.languageCode,
        alternativeLanguageCodes: config.alternativeLanguageCodes
      }));

      const request = {
        audio: audio,
        config: config,
      };

      console.log('[Speech API] Sending request to Google Speech-to-Text...');
      const [response] = await client.recognize(request);

      console.log('[Speech API] Response received:', JSON.stringify(response, null, 2));

      const transcription = response.results
        ?.map((result: any) => result.alternatives?.[0]?.transcript)
        .filter(Boolean)
        .join('\n') || '';

      // Log detected language
      const detectedLanguage = response.results?.[0]?.languageCode || 'unknown';
      console.log('[Speech API] Detected language:', detectedLanguage);

      if (!transcription) {
        console.log('[Speech API] No speech detected in audio');
        return {
          success: false,
          message: 'No speech detected in the audio file',
          originalText: '',
          translatedText: '',
        };
      }

      console.log('[Speech API] Transcription completed:', transcription.substring(0, 100) + '...');

      // Step 2: Translate the transcribed text
      console.log('[Translation API] Starting translation to', targetLanguage);
      const translatedText = await this.translateTextDirect(transcription, targetLanguage);

      console.log('[Translation API] Translation completed');

      return {
        success: true,
        originalText: transcription,
        translatedText: translatedText,
        audioDetails: {
          duration: response.results?.[0]?.resultEndTime?.seconds || 0,
          detectedLanguage: detectedLanguage,  // Actual detected language
          primaryLanguage: config.languageCode, // Primary config language
        },
      };
    } catch (error) {
      console.error('[Audio Translation] Error:', error.message);
      throw new Error(`Audio translation failed: ${error.message}`);
    }
  }
}
