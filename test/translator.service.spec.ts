import { Test, TestingModule } from '@nestjs/testing';
import { TranslatorService } from '../src/modules/translator/translator.service';
import { getQueueToken } from '@nestjs/bull';
import { Queue, Job } from 'bull';
import axios from 'axios';

// Mock axios
jest.mock('axios');
const mockedAxios = axios as jest.Mocked<typeof axios>;

describe('TranslatorService', () => {
  let service: TranslatorService;
  let translationQueue: Queue;

  // Mock environment variables
  const originalEnv = process.env;
  beforeEach(() => {
    process.env = {
      ...originalEnv,
      OPENROUTER_BASE_URL: 'https://api.openrouter.ai/api',
      OPENROUTER_API_KEY: 'test-api-key',
      OPENROUTER_MODEL: 'test-model',
      OPENROUTER_REFERER: 'http://localhost:5010',
      OPENROUTER_APP_NAME: 'Transearly Service',
    };
  });

  afterEach(() => {
    process.env = originalEnv;
    jest.clearAllMocks();
  });

  // Mock Queue
  const mockQueue = {
    add: jest.fn(),
    getJob: jest.fn(),
  };

  // Mock Job
  const createMockJob = (
    id: string,
    isCompleted: boolean = false,
    isFailed: boolean = false,
    returnvalue?: any,
    failedReason?: string,
  ): Partial<Job> => ({
    id,
    isCompleted: jest.fn().mockResolvedValue(isCompleted),
    isFailed: jest.fn().mockResolvedValue(isFailed),
    returnvalue,
    failedReason,
  });

  // Mock file data
  const createMockFile = (
    originalname: string = 'test.pdf',
    size: number = 5000,
    mimetype: string = 'application/pdf',
  ): Express.Multer.File => ({
    fieldname: 'file',
    originalname,
    encoding: '7bit',
    mimetype,
    size,
    buffer: Buffer.from('mock file content'),
    stream: {} as any,
    destination: '',
    filename: '',
    path: '',
  });

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TranslatorService,
        {
          provide: getQueueToken('translation-queue'),
          useValue: mockQueue,
        },
      ],
    }).compile();

    service = module.get<TranslatorService>(TranslatorService);
    translationQueue = module.get<Queue>(getQueueToken('translation-queue'));

    // Clear all mocks before each test
    jest.clearAllMocks();
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  it('should throw error if environment variables are missing during initialization', async () => {
    // Save original env
    const originalEnv = process.env;
    
    try {
      // Clear required env vars
      process.env = {
        ...originalEnv,
        OPENROUTER_BASE_URL: '',
        OPENROUTER_API_KEY: '',
        OPENROUTER_MODEL: '',
      };

      // This should throw during module creation
      await expect(async () => {
        const module: TestingModule = await Test.createTestingModule({
          providers: [
            TranslatorService,
            {
              provide: getQueueToken('translation-queue'),
              useValue: mockQueue,
            },
          ],
        }).compile();
      }).rejects.toThrow('Missing OpenRouter API configuration in environment.');
    } finally {
      // Restore original env
      process.env = originalEnv;
    }
  });

  describe('startTranslationJob', () => {
    const mockFile = createMockFile();
    const mockTargetLanguage = 'Vietnamese';
    const mockSocketId = 'socket-123';
    const mockJobId = 'job-456';

    it('should add a job to the translation queue with correct data', async () => {
      const mockJob = { id: mockJobId };
      mockQueue.add.mockResolvedValue(mockJob);

      const result = await service.startTranslationJob(
        mockFile,
        mockTargetLanguage,
        mockSocketId,
        false,
      );

      expect(mockQueue.add).toHaveBeenCalledWith(
        {
          buffer: mockFile.buffer,
          originalname: mockFile.originalname,
          targetLanguage: mockTargetLanguage,
          socketId: mockSocketId,
          isUserPremium: false,
        },
        {
          removeOnComplete: true,
          removeOnFail: true,
        },
      );

      expect(result).toEqual(mockJob);
      expect(result.id).toBe(mockJobId);
    });

    it('should handle premium user flag correctly', async () => {
      const mockJob = { id: mockJobId };
      mockQueue.add.mockResolvedValue(mockJob);

      await service.startTranslationJob(
        mockFile,
        mockTargetLanguage,
        mockSocketId,
        true, // Premium user
      );

      expect(mockQueue.add).toHaveBeenCalledWith(
        expect.objectContaining({
          isUserPremium: true,
        }),
        expect.any(Object),
      );
    });

    it('should use default target language when provided', async () => {
      const mockJob = { id: mockJobId };
      mockQueue.add.mockResolvedValue(mockJob);

      await service.startTranslationJob(
        mockFile,
        'Spanish',
        mockSocketId,
        false,
      );

      expect(mockQueue.add).toHaveBeenCalledWith(
        expect.objectContaining({
          targetLanguage: 'Spanish',
        }),
        expect.any(Object),
      );
    });

    it('should pass socket ID for real-time updates', async () => {
      const mockJob = { id: mockJobId };
      const customSocketId = 'custom-socket-xyz';
      mockQueue.add.mockResolvedValue(mockJob);

      await service.startTranslationJob(
        mockFile,
        mockTargetLanguage,
        customSocketId,
        false,
      );

      expect(mockQueue.add).toHaveBeenCalledWith(
        expect.objectContaining({
          socketId: customSocketId,
        }),
        expect.any(Object),
      );
    });

    it('should set removeOnComplete and removeOnFail options', async () => {
      const mockJob = { id: mockJobId };
      mockQueue.add.mockResolvedValue(mockJob);

      await service.startTranslationJob(
        mockFile,
        mockTargetLanguage,
        mockSocketId,
        false,
      );

      expect(mockQueue.add).toHaveBeenCalledWith(
        expect.any(Object),
        {
          removeOnComplete: true,
          removeOnFail: true,
        },
      );
    });

    it('should handle different file types', async () => {
      const testCases = [
        { name: 'test.pdf', mimetype: 'application/pdf' },
        { name: 'test.docx', mimetype: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' },
        { name: 'test.txt', mimetype: 'text/plain' },
        { name: 'test.xlsx', mimetype: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' },
        { name: 'test.pptx', mimetype: 'application/vnd.openxmlformats-officedocument.presentationml.presentation' },
      ];

      for (const testCase of testCases) {
        mockQueue.add.mockResolvedValue({ id: mockJobId });
        const file = createMockFile(testCase.name, 5000, testCase.mimetype);

        await service.startTranslationJob(
          file,
          mockTargetLanguage,
          mockSocketId,
          false,
        );

        expect(mockQueue.add).toHaveBeenCalledWith(
          expect.objectContaining({
            originalname: testCase.name,
          }),
          expect.any(Object),
        );
      }
    });

    it('should return the created job', async () => {
      const mockJob = { 
        id: mockJobId,
        data: {},
        opts: {},
      };
      mockQueue.add.mockResolvedValue(mockJob);

      const result = await service.startTranslationJob(
        mockFile,
        mockTargetLanguage,
        mockSocketId,
        false,
      );

      expect(result).toEqual(mockJob);
    });
  });

  describe('getJobStatus', () => {
    it('should return not_found status when job does not exist', async () => {
      mockQueue.getJob.mockResolvedValue(null);

      const result = await service.getJobStatus('non-existent-job');

      expect(mockQueue.getJob).toHaveBeenCalledWith('non-existent-job');
      expect(result).toEqual({ status: 'not_found' });
    });

    it('should return completed status with result when job is completed', async () => {
      const mockResult = { translatedFileName: 'translated-file.pdf' };
      const mockJob = createMockJob('job-123', true, false, mockResult);
      mockQueue.getJob.mockResolvedValue(mockJob);

      const result = await service.getJobStatus('job-123');

      expect(mockQueue.getJob).toHaveBeenCalledWith('job-123');
      expect(mockJob.isCompleted).toHaveBeenCalled();
      expect(result).toEqual({
        status: 'completed',
        result: mockResult,
      });
    });

    it('should return failed status with reason when job has failed', async () => {
      const mockFailReason = 'Translation API error';
      const mockJob = createMockJob('job-123', false, true, undefined, mockFailReason);
      mockQueue.getJob.mockResolvedValue(mockJob);

      const result = await service.getJobStatus('job-123');

      expect(mockQueue.getJob).toHaveBeenCalledWith('job-123');
      expect(mockJob.isCompleted).toHaveBeenCalled();
      expect(mockJob.isFailed).toHaveBeenCalled();
      expect(result).toEqual({
        status: 'failed',
        reason: mockFailReason,
      });
    });

    it('should return processing status when job is in progress', async () => {
      const mockJob = createMockJob('job-123', false, false);
      mockQueue.getJob.mockResolvedValue(mockJob);

      const result = await service.getJobStatus('job-123');

      expect(mockQueue.getJob).toHaveBeenCalledWith('job-123');
      expect(mockJob.isCompleted).toHaveBeenCalled();
      expect(mockJob.isFailed).toHaveBeenCalled();
      expect(result).toEqual({ status: 'processing' });
    });

    it('should handle multiple job status checks', async () => {
      const jobIds = ['job-1', 'job-2', 'job-3'];
      
      for (const jobId of jobIds) {
        const mockJob = createMockJob(jobId, false, false);
        mockQueue.getJob.mockResolvedValue(mockJob);

        const result = await service.getJobStatus(jobId);

        expect(result.status).toBe('processing');
      }

      expect(mockQueue.getJob).toHaveBeenCalledTimes(3);
    });

    it('should return correct status for completed job with empty result', async () => {
      const mockJob = createMockJob('job-123', true, false, null);
      mockQueue.getJob.mockResolvedValue(mockJob);

      const result = await service.getJobStatus('job-123');

      expect(result).toEqual({
        status: 'completed',
        result: null,
      });
    });

    it('should prioritize completed status over failed if both are true', async () => {
      // Edge case: if somehow both flags are true, completed should take precedence
      const mockJob = createMockJob('job-123', true, true, { data: 'test' }, 'some error');
      mockQueue.getJob.mockResolvedValue(mockJob);

      const result = await service.getJobStatus('job-123');

      expect(result.status).toBe('completed');
      expect(result).toHaveProperty('result');
    });

    it('should handle job IDs with special characters', async () => {
      const specialJobId = 'job-abc-123-xyz';
      const mockJob = createMockJob(specialJobId, false, false);
      mockQueue.getJob.mockResolvedValue(mockJob);

      const result = await service.getJobStatus(specialJobId);

      expect(mockQueue.getJob).toHaveBeenCalledWith(specialJobId);
      expect(result.status).toBe('processing');
    });
  });

  describe('translateTextDirect', () => {
    const mockTranslationResponse = {
      data: {
        choices: [
          {
            message: {
              content: 'Xin chào, bạn khỏe không?',
            },
          },
        ],
      },
    };

    it('should translate text successfully', async () => {
      mockedAxios.post.mockResolvedValue(mockTranslationResponse);

      const result = await service.translateTextDirect(
        'Hello, how are you?',
        'Vietnamese',
      );

      expect(result).toBe('Xin chào, bạn khỏe không?');
      expect(mockedAxios.post).toHaveBeenCalledWith(
        'https://api.openrouter.ai/api',
        {
          model: 'test-model',
          messages: [
            {
              role: 'system',
              content: expect.stringContaining('professional translation engine'),
            },
            {
              role: 'user',
              content: 'Hello, how are you?',
            },
          ],
          temperature: 0,
        },
        {
          headers: {
            Authorization: 'Bearer test-api-key',
            'Content-Type': 'application/json',
            'HTTP-Referer': 'http://localhost:5010',
            'X-Title': 'Transearly Service',
          },
        },
      );
    });

    it.skip('should handle missing environment variables', async () => {
      process.env.OPENROUTER_API_KEY = '';

      await expect(
        service.translateTextDirect('Hello', 'Vietnamese'),
      ).rejects.toThrow('Missing OpenRouter API configuration');
    });

    it('should handle API errors', async () => {
      mockedAxios.post.mockRejectedValue(new Error('API Error'));

      await expect(
        service.translateTextDirect('Hello', 'Vietnamese'),
      ).rejects.toThrow('API Error');
    });

    it('should handle invalid API response', async () => {
      mockedAxios.post.mockResolvedValue({
        data: {
          choices: [],
        },
      });

      await expect(
        service.translateTextDirect('Hello', 'Vietnamese'),
      ).rejects.toThrow('Invalid response from translation API');
    });

    it('should handle empty API response content', async () => {
      mockedAxios.post.mockResolvedValue({
        data: {
          choices: [
            {
              message: {
                content: null,
              },
            },
          ],
        },
      });

      await expect(
        service.translateTextDirect('Hello', 'Vietnamese'),
      ).rejects.toThrow('Invalid response from translation API');
    });

    it('should use default environment values when optional values are missing', async () => {
      delete process.env.OPENROUTER_REFERER;
      delete process.env.OPENROUTER_APP_NAME;

      mockedAxios.post.mockResolvedValue(mockTranslationResponse);

      await service.translateTextDirect('Hello', 'Vietnamese');

      expect(mockedAxios.post).toHaveBeenCalledWith(
        expect.any(String),
        expect.any(Object),
        {
          headers: expect.objectContaining({
            'HTTP-Referer': 'http://localhost:5010',
            'X-Title': 'Transearly Service',
          }),
        },
      );
    });

    it('should trim whitespace from translated text', async () => {
      mockedAxios.post.mockResolvedValue({
        data: {
          choices: [
            {
              message: {
                content: '  Translated text with spaces  ',
              },
            },
          ],
        },
      });

      const result = await service.translateTextDirect('Hello', 'Vietnamese');

      expect(result).toBe('Translated text with spaces');
    });

    it('should handle different target languages', async () => {
      const languages = ['Spanish', 'French', 'German', 'Japanese'];

      for (const language of languages) {
        mockedAxios.post.mockResolvedValue(mockTranslationResponse);

        await service.translateTextDirect('Hello', language);

        expect(mockedAxios.post).toHaveBeenCalledWith(
          expect.any(String),
          expect.objectContaining({
            messages: expect.arrayContaining([
              expect.objectContaining({
                role: 'system',
                content: expect.stringContaining(language),
              }),
            ]),
          }),
          expect.any(Object),
        );
      }
    });

    it('should include proper system prompt with target language', async () => {
      mockedAxios.post.mockResolvedValue(mockTranslationResponse);

      await service.translateTextDirect('Hello', 'Spanish');

      expect(mockedAxios.post).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          messages: [
            {
              role: 'system',
              content: expect.stringContaining('Spanish'),
            },
            expect.any(Object),
          ],
        }),
        expect.any(Object),
      );
    });
  });

  describe('translateImageDirect', () => {
    const mockImageTranslationResponse = {
      data: {
        choices: [
          {
            message: {
              content: 'Translated text from image',
            },
          },
        ],
      },
    };

    const createMockImageFile = (
      mimetype: string = 'image/jpeg',
      size: number = 5000,
      originalname: string = 'test.jpg',
    ): Express.Multer.File => ({
      fieldname: 'file',
      originalname,
      encoding: '7bit',
      mimetype,
      size,
      buffer: Buffer.from('mock image data'),
      stream: {} as any,
      destination: '',
      filename: '',
      path: '',
    });

    it('should translate image successfully', async () => {
      const mockImageFile = createMockImageFile();
      mockedAxios.post.mockResolvedValue(mockImageTranslationResponse);

      const result = await service.translateImageDirect(
        mockImageFile,
        'Vietnamese',
      );

      expect(result).toBe('Translated text from image');
      expect(mockedAxios.post).toHaveBeenCalledWith(
        'https://api.openrouter.ai/api',
        {
          model: 'test-model',
          messages: [
            {
              role: 'system',
              content: expect.stringContaining('visual translation assistant'),
            },
            {
              role: 'user',
              content: [
                { type: 'text', text: 'Translate this image:' },
                {
                  type: 'image_url',
                  image_url: `data:${mockImageFile.mimetype};base64,${mockImageFile.buffer.toString('base64')}`,
                },
              ],
            },
          ],
          temperature: 0,
        },
        {
          headers: {
            Authorization: 'Bearer test-api-key',
            'Content-Type': 'application/json',
            'HTTP-Referer': 'http://localhost:5010',
            'X-Title': 'Transearly Service',
          },
        },
      );
    });

    it('should handle different image formats', async () => {
      const imageFormats = [
        { mimetype: 'image/jpeg', filename: 'test.jpg' },
        { mimetype: 'image/png', filename: 'test.png' },
        { mimetype: 'image/gif', filename: 'test.gif' },
        { mimetype: 'image/webp', filename: 'test.webp' },
      ];

      for (const format of imageFormats) {
        const mockImageFile = createMockImageFile(format.mimetype, 5000, format.filename);
        mockedAxios.post.mockResolvedValue(mockImageTranslationResponse);

        const result = await service.translateImageDirect(mockImageFile, 'Spanish');

        expect(result).toBe('Translated text from image');
        expect(mockedAxios.post).toHaveBeenCalledWith(
          expect.any(String),
          expect.objectContaining({
            messages: expect.arrayContaining([
              expect.objectContaining({
                content: expect.arrayContaining([
                  expect.objectContaining({
                    image_url: expect.stringContaining(format.mimetype),
                  }),
                ]),
              }),
            ]),
          }),
          expect.any(Object),
        );
      }
    });

    it.skip('should handle missing environment variables', async () => {
      process.env.OPENROUTER_API_KEY = '';
      const mockImageFile = createMockImageFile();

      await expect(
        service.translateImageDirect(mockImageFile, 'Vietnamese'),
      ).rejects.toThrow('Missing OpenRouter API configuration');
    });

    it('should handle API errors', async () => {
      const mockImageFile = createMockImageFile();
      mockedAxios.post.mockRejectedValue(new Error('Vision API Error'));

      await expect(
        service.translateImageDirect(mockImageFile, 'Vietnamese'),
      ).rejects.toThrow('Vision API Error');
    });

    it('should handle invalid API response structure', async () => {
      const mockImageFile = createMockImageFile();
      mockedAxios.post.mockResolvedValue({
        data: {
          choices: [],
        },
      });

      await expect(
        service.translateImageDirect(mockImageFile, 'Vietnamese'),
      ).rejects.toThrow('Invalid or empty AI response');
    });

    it('should handle empty response content', async () => {
      const mockImageFile = createMockImageFile();
      mockedAxios.post.mockResolvedValue({
        data: {
          choices: [
            {
              message: {
                content: null,
              },
            },
          ],
        },
      });

      await expect(
        service.translateImageDirect(mockImageFile, 'Vietnamese'),
      ).rejects.toThrow('Invalid or empty AI response');
    });

    it.skip('should handle alternative response format', async () => {
      const mockImageFile = createMockImageFile();
      mockedAxios.post.mockResolvedValue({
        data: {
          choices: [
            {
              message: {
                content: [
                  {
                    text: 'Alternative format translation',
                  },
                ],
              },
            },
          ],
        },
      });

      const result = await service.translateImageDirect(mockImageFile, 'French');

      expect(result).toBe('Alternative format translation');
    });

    it('should trim whitespace from response', async () => {
      const mockImageFile = createMockImageFile();
      mockedAxios.post.mockResolvedValue({
        data: {
          choices: [
            {
              message: {
                content: '  Translated text with spaces  ',
              },
            },
          ],
        },
      });

      const result = await service.translateImageDirect(mockImageFile, 'German');

      expect(result).toBe('Translated text with spaces');
    });

    it('should convert image buffer to base64 correctly', async () => {
      const mockImageFile = createMockImageFile('image/png', 1000, 'test.png');
      const expectedBase64 = mockImageFile.buffer.toString('base64');
      
      mockedAxios.post.mockResolvedValue(mockImageTranslationResponse);

      await service.translateImageDirect(mockImageFile, 'Japanese');

      expect(mockedAxios.post).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          messages: expect.arrayContaining([
            expect.objectContaining({
              content: expect.arrayContaining([
                {
                  type: 'image_url',
                  image_url: `data:image/png;base64,${expectedBase64}`,
                },
              ]),
            }),
          ]),
        }),
        expect.any(Object),
      );
    });

    it('should include correct system prompt for target language', async () => {
      const mockImageFile = createMockImageFile();
      const targetLanguage = 'Korean';
      
      mockedAxios.post.mockResolvedValue(mockImageTranslationResponse);

      await service.translateImageDirect(mockImageFile, targetLanguage);

      expect(mockedAxios.post).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          messages: [
            {
              role: 'system',
              content: expect.stringContaining(targetLanguage),
            },
            expect.any(Object),
          ],
        }),
        expect.any(Object),
      );
    });

    it('should handle large image files', async () => {
      const largeImageBuffer = Buffer.alloc(5 * 1024 * 1024); // 5MB
      const mockImageFile: Express.Multer.File = {
        ...createMockImageFile(),
        buffer: largeImageBuffer,
        size: largeImageBuffer.length,
      };
      
      mockedAxios.post.mockResolvedValue(mockImageTranslationResponse);

      const result = await service.translateImageDirect(mockImageFile, 'Vietnamese');

      expect(result).toBe('Translated text from image');
      expect(mockedAxios.post).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          messages: expect.arrayContaining([
            expect.objectContaining({
              content: expect.arrayContaining([
                {
                  type: 'image_url',
                  image_url: expect.stringContaining('base64'),
                },
              ]),
            }),
          ]),
        }),
        expect.any(Object),
      );
    });
  });

  describe('Edge Cases', () => {
    it('should handle queue errors gracefully in startTranslationJob', async () => {
      const mockFile = createMockFile();
      mockQueue.add.mockRejectedValue(new Error('Queue is full'));

      await expect(
        service.startTranslationJob(mockFile, 'Vietnamese', 'socket-123', false),
      ).rejects.toThrow('Queue is full');
    });

    it('should handle queue errors gracefully in getJobStatus', async () => {
      mockQueue.getJob.mockRejectedValue(new Error('Database connection error'));

      await expect(
        service.getJobStatus('job-123'),
      ).rejects.toThrow('Database connection error');
    });

    it('should handle large file buffers', async () => {
      const largeBuffer = Buffer.alloc(10 * 1024 * 1024); // 10MB
      const largeFile: Express.Multer.File = {
        ...createMockFile(),
        buffer: largeBuffer,
        size: largeBuffer.length,
      };

      const mockJob = { id: 'job-large' };
      mockQueue.add.mockResolvedValue(mockJob);

      const result = await service.startTranslationJob(
        largeFile,
        'Vietnamese',
        'socket-123',
        true,
      );

      expect(result.id).toBe('job-large');
      expect(mockQueue.add).toHaveBeenCalledWith(
        expect.objectContaining({
          buffer: largeBuffer,
        }),
        expect.any(Object),
      );
    });
  });
});
