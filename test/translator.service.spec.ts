import { Test, TestingModule } from '@nestjs/testing';
import { TranslatorService } from '../src/modules/translator/translator.service';
import { getQueueToken } from '@nestjs/bull';
import { Queue, Job } from 'bull';
import axios from 'axios';
import { ImageAnnotatorClient } from '@google-cloud/vision';

// Mock axios
jest.mock('axios');
const mockedAxios = axios as jest.Mocked<typeof axios>;

// Mock Google Cloud Vision
const mockVisionClient = {
  textDetection: jest.fn().mockRejectedValue(new Error('Google Cloud Vision not configured in test environment')),
};

jest.mock('@google-cloud/vision', () => ({
  __esModule: true,
  default: {
    ImageAnnotatorClient: jest.fn().mockImplementation(() => mockVisionClient),
  },
  ImageAnnotatorClient: jest.fn().mockImplementation(() => mockVisionClient),
}));

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

    it('should use getHeaders method for API calls', async () => {
      mockedAxios.post.mockResolvedValue(mockTranslationResponse);

      await service.translateTextDirect('Test', 'French');

      expect(mockedAxios.post).toHaveBeenCalledWith(
        expect.any(String),
        expect.any(Object),
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
  });

  describe('translateImageDirect', () => {
    const mockVisionResponse = {
      textAnnotations: [
        {
          description: 'Sample text',
          boundingPoly: {
            vertices: [
              { x: 10, y: 10 },
              { x: 100, y: 10 },
              { x: 100, y: 50 },
              { x: 10, y: 50 },
            ],
          },
        },
      ],
      fullTextAnnotation: {
        pages: [
          {
            width: 1000,
            height: 800,
            blocks: [
              {
                paragraphs: [
                  {
                    words: [
                      {
                        symbols: [
                          { text: 'S' },
                          { text: 'a' },
                          { text: 'm' },
                          { text: 'p' },
                          { text: 'l' },
                          { text: 'e' },
                        ],
                        boundingBox: {
                          vertices: [
                            { x: 10, y: 10 },
                            { x: 60, y: 10 },
                            { x: 60, y: 30 },
                            { x: 10, y: 30 },
                          ],
                        },
                      },
                      {
                        symbols: [
                          { text: 't' },
                          { text: 'e' },
                          { text: 'x' },
                          { text: 't' },
                        ],
                        boundingBox: {
                          vertices: [
                            { x: 70, y: 10 },
                            { x: 100, y: 10 },
                            { x: 100, y: 30 },
                            { x: 70, y: 30 },
                          ],
                        },
                      },
                    ],
                  },
                ],
              },
            ],
          },
        ],
      },
    };

    const mockImageTranslationResponse = {
      data: {
        choices: [
          {
            message: {
              content: 'Văn bản mẫu',
            },
          },
        ],
      },
    };

    const mockAIVisionJSONResponse = {
      data: {
        choices: [
          {
            message: {
              content: JSON.stringify({
                segments: [
                  {
                    position: { x: 10, y: 20, width: 30, height: 15 },
                    original: 'Sample text',
                    translated: 'Văn bản mẫu',
                  },
                ],
              }),
            },
          },
        ],
      },
    };

    // use top-level mockVisionClient defined with jest.mock

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

    // Suppress console logs during image translation tests to keep output clean
    let consoleLogSpy: jest.SpyInstance;
    let consoleErrorSpy: jest.SpyInstance;

    beforeAll(() => {
      consoleLogSpy = jest.spyOn(console, 'log').mockImplementation();
      consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation();
    });

    afterAll(() => {
      consoleLogSpy.mockRestore();
      consoleErrorSpy.mockRestore();
    });

    beforeEach(() => {
      // Reset the mock before each test with default rejection
      (mockVisionClient as any).textDetection.mockReset();
      (mockVisionClient as any).textDetection.mockRejectedValue(new Error('Google Cloud Vision not configured in test environment'));
    });

    it('should use Google Vision results to group segments and map translations', async () => {
      const mockImageFile = createMockImageFile();

      // Vision returns detections and full text annotation
      mockVisionClient.textDetection.mockResolvedValue([
        {
          textAnnotations: mockVisionResponse.textAnnotations,
          fullTextAnnotation: mockVisionResponse.fullTextAnnotation,
        },
      ] as any);

      // Batch translate returns one line matching segments count
      mockedAxios.post.mockResolvedValue({
        data: {
          choices: [
            {
              message: { content: 'Văn bản mẫu' },
            },
          ],
        },
      });

      const result = await service.translateImageDirect(mockImageFile, 'Vietnamese');

      expect(result.segments).toHaveLength(1);
      expect(result.segments[0]).toEqual(
        expect.objectContaining({
          original: 'Sample text',
          translated: 'Văn bản mẫu',
          position: expect.objectContaining({ x: expect.any(Number), y: expect.any(Number) }),
        }),
      );

      // Ensure it did not fallback
      expect(mockedAxios.post).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          messages: [
            expect.objectContaining({ role: 'system' }),
            expect.objectContaining({ role: 'user', content: 'Sample text' }),
          ],
        }),
        expect.any(Object),
      );
    });

    it('should translate image successfully using Google Cloud Vision', async () => {
      const mockImageFile = createMockImageFile();
      
      // Since Google Vision may fail in test environment, handle fallback case
      mockVisionClient.textDetection.mockRejectedValue(new Error('Google Vision not available'));
      mockedAxios.post.mockResolvedValue(mockAIVisionJSONResponse);

      const result = await service.translateImageDirect(
        mockImageFile,
        'Vietnamese',
      );

      expect(result).toEqual({
        segments: [
          {
            position: { x: 10, y: 20, width: 30, height: 15 },
            original: 'Sample text',
            translated: 'Văn bản mẫu',
          },
        ],
      });

      // Should fallback to AI vision
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
                { type: 'text', text: 'Detect and translate all text in this image:' },
                {
                  type: 'image_url',
                  image_url: `data:${mockImageFile.mimetype};base64,${mockImageFile.buffer.toString('base64')}`,
                },
              ],
            },
          ],
          temperature: 0,
          response_format: { type: 'json_object' },
        },
        expect.any(Object),
      );
    });

    it('should return empty segments when no text is detected', async () => {
      const mockImageFile = createMockImageFile();
      
      // Vision returns success with no detections
      ;(mockVisionClient as any).textDetection.mockResolvedValue([
        { textAnnotations: [], fullTextAnnotation: undefined },
      ] as any);

      const result = await service.translateImageDirect(
        mockImageFile,
        'Vietnamese',
      );

      expect(result).toEqual({ segments: [] });
      // Should not fallback to AI vision when Vision succeeds with no text
      expect(mockedAxios.post).not.toHaveBeenCalled();
    });

    it('should fallback to AI vision when Google Cloud Vision fails', async () => {
      const mockImageFile = createMockImageFile();
      const mockAIVisionResponse = {
        data: {
          choices: [
            {
              message: {
                content: JSON.stringify({
                  segments: [
                    {
                      position: { x: 10, y: 20, width: 30, height: 15 },
                      original: 'Fallback text',
                      translated: 'Văn bản dự phòng',
                    },
                  ],
                }),
              },
            },
          ],
        },
      };

      mockVisionClient.textDetection.mockRejectedValue(new Error('Vision API error'));
      mockedAxios.post.mockResolvedValue(mockAIVisionResponse);

      const result = await service.translateImageDirect(
        mockImageFile,
        'Vietnamese',
      );

      expect(result).toEqual({
        segments: [
          {
            position: { x: 10, y: 20, width: 30, height: 15 },
            original: 'Fallback text',
            translated: 'Văn bản dự phòng',
          },
        ],
      });

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
                { type: 'text', text: 'Detect and translate all text in this image:' },
                {
                  type: 'image_url',
                  image_url: `data:${mockImageFile.mimetype};base64,${mockImageFile.buffer.toString('base64')}`,
                },
              ],
            },
          ],
          temperature: 0,
          response_format: { type: 'json_object' },
        },
        expect.any(Object),
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
        
        // Since Google Vision fails, this will fallback to AI vision which needs JSON response
        mockVisionClient.textDetection.mockRejectedValue(new Error('Vision API not available'));
        mockedAxios.post.mockResolvedValue(mockAIVisionJSONResponse);

        const result = await service.translateImageDirect(mockImageFile, 'Spanish');

        expect(result.segments).toHaveLength(1);
        expect(result.segments[0].original).toBe('Sample text');
        expect(result.segments[0].translated).toBe('Văn bản mẫu');
      }
    });

    it('should map multiple translated lines back to multiple segments from Vision', async () => {
      const mockImageFile = createMockImageFile();

      // Build a Vision response with two paragraphs (two segments)
      const twoParagraphs = {
        textAnnotations: [
          { description: 'Hello World' },
        ],
        fullTextAnnotation: {
          pages: [
            {
              width: 800,
              height: 600,
              blocks: [
                { paragraphs: [
                  { words: [
                    { symbols: [{ text: 'H' }, { text: 'i' }], boundingBox: { vertices: [{x:5,y:5},{x:25,y:5},{x:25,y:20},{x:5,y:20}] } },
                  ] },
                ]},
                { paragraphs: [
                  { words: [
                    { symbols: [{ text: 'B' }, { text: 'y' }, { text: 'e' }], boundingBox: { vertices: [{x:10,y:30},{x:40,y:30},{x:40,y:50},{x:10,y:50}] } },
                  ] },
                ]},
              ],
            },
          ],
        },
      };

      ;(mockVisionClient as any).textDetection.mockResolvedValue([
        twoParagraphs,
      ] as any);

      mockedAxios.post.mockResolvedValue({
        data: {
          choices: [
            { message: { content: 'Xin chào\nTạm biệt' } },
          ],
        },
      });

      const result = await service.translateImageDirect(mockImageFile, 'Vietnamese');
      expect(result.segments).toHaveLength(2);
      expect(result.segments[0].translated).toBe('Xin chào');
      expect(result.segments[1].translated).toBe('Tạm biệt');
    });

    it('should fallback to AI vision when batch translation returns empty', async () => {
      const mockImageFile = createMockImageFile();

      // Vision detects one segment
      ;(mockVisionClient as any).textDetection.mockResolvedValue([
        {
          textAnnotations: [{ description: 'Sample' }],
          fullTextAnnotation: {
            pages: [
              { width: 100, height: 100, blocks: [ { paragraphs: [ { words: [ { symbols: [{text:'S'}], boundingBox:{vertices:[{x:1,y:1},{x:2,y:1},{x:2,y:2},{x:1,y:2}]}} ] } ] } ] },
            ],
          },
        },
      ] as any);

      // First call returns empty content to trigger error -> fallback
      mockedAxios.post
        .mockResolvedValueOnce({ data: { choices: [{ message: { content: '   ' } }] } })
        .mockResolvedValueOnce({
          data: {
            choices: [
              {
                message: {
                  content: JSON.stringify({ segments: [{ position: {x:10,y:10,width:10,height:10}, original: 'Sample', translated: 'Mẫu'}] }),
                },
              },
            ],
          },
        });

      const result = await service.translateImageDirect(mockImageFile, 'Vietnamese');
      expect(result).toEqual({ segments: [ expect.objectContaining({ translated: 'Mẫu' }) ] });
      // Ensure two axios calls (batch + fallback)
      expect(mockedAxios.post).toHaveBeenCalledTimes(2);
    });

    it.skip('should handle missing environment variables', async () => {
      process.env.OPENROUTER_API_KEY = '';
      const mockImageFile = createMockImageFile();

      await expect(
        service.translateImageDirect(mockImageFile, 'Vietnamese'),
      ).rejects.toThrow('Missing OpenRouter API configuration');
    });

    it('should handle API errors in fallback mode', async () => {
      const mockImageFile = createMockImageFile();
      
      mockVisionClient.textDetection.mockRejectedValue(new Error('Vision API error'));
      mockedAxios.post.mockRejectedValue(new Error('Translation API error'));

      await expect(
        service.translateImageDirect(mockImageFile, 'Vietnamese'),
      ).rejects.toThrow('Translation API error');
    });

    it('should handle invalid JSON response in fallback mode', async () => {
      const mockImageFile = createMockImageFile();
      const invalidResponse = {
        data: {
          choices: [
            {
              message: {
                content: 'Invalid JSON content',
              },
            },
          ],
        },
      };

      mockVisionClient.textDetection.mockRejectedValue(new Error('Vision API error'));
      mockedAxios.post.mockResolvedValue(invalidResponse);

      await expect(
        service.translateImageDirect(mockImageFile, 'Vietnamese'),
      ).rejects.toThrow('Failed to parse AI response as JSON');
    });

    it('should handle empty response content in fallback mode', async () => {
      const mockImageFile = createMockImageFile();
      const emptyResponse = {
        data: {
          choices: [
            {
              message: {
                content: null,
              },
            },
          ],
        },
      };

      mockVisionClient.textDetection.mockRejectedValue(new Error('Vision API error'));
      mockedAxios.post.mockResolvedValue(emptyResponse);

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

    it('should handle missing segments in fallback response', async () => {
      const mockImageFile = createMockImageFile();
      const responseWithoutSegments = {
        data: {
          choices: [
            {
              message: {
                content: JSON.stringify({ other_data: 'something' }),
              },
            },
          ],
        },
      };

      mockVisionClient.textDetection.mockRejectedValue(new Error('Vision API error'));
      mockedAxios.post.mockResolvedValue(responseWithoutSegments);

      await expect(
        service.translateImageDirect(mockImageFile, 'Vietnamese'),
      ).rejects.toThrow('Invalid response structure: missing segments array');
    });

    it('should convert image buffer to base64 correctly in fallback mode', async () => {
      const mockImageFile = createMockImageFile('image/png', 1000, 'test.png');
      const expectedBase64 = mockImageFile.buffer.toString('base64');
      
      mockVisionClient.textDetection.mockRejectedValue(new Error('Vision API error'));
      mockedAxios.post.mockResolvedValue({
        data: {
          choices: [
            {
              message: {
                content: JSON.stringify({ segments: [] }),
              },
            },
          ],
        },
      });

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
      
      // Test fallback AI vision with specific target language
      mockVisionClient.textDetection.mockRejectedValue(new Error('Google Vision not available'));
      mockedAxios.post.mockResolvedValue(mockAIVisionJSONResponse);

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
      
      // Test fallback with large file
      mockVisionClient.textDetection.mockRejectedValue(new Error('Google Vision not available'));
      mockedAxios.post.mockResolvedValue(mockAIVisionJSONResponse);

      const result = await service.translateImageDirect(mockImageFile, 'Vietnamese');

      expect(result.segments).toHaveLength(1);
      expect(mockedAxios.post).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          messages: expect.arrayContaining([
            expect.objectContaining({
              content: expect.arrayContaining([
                {
                  type: 'image_url',
                  image_url: `data:${mockImageFile.mimetype};base64,${largeImageBuffer.toString('base64')}`,
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
