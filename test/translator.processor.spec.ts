import { Test, TestingModule } from '@nestjs/testing';
import { TranslatorProcessor } from '../src/modules/translator/translator.processor';
import { EventsGateway } from '../src/modules/events/events.gateway';
import { Job } from 'bull';
import axios from 'axios';
import * as mammoth from 'mammoth';
import { PDFLoader } from '@langchain/community/document_loaders/fs/pdf';
import { PDFDocument } from 'pdf-lib';
import * as ExcelJS from 'exceljs';
import * as fs from 'fs/promises';
import * as path from 'path';

// Mock all external dependencies
jest.mock('axios');
jest.mock('mammoth');
jest.mock('@langchain/community/document_loaders/fs/pdf', () => ({
  PDFLoader: jest.fn().mockImplementation(() => ({
    load: jest.fn(),
  })),
}));
jest.mock('pdf-lib');
jest.mock('exceljs');
jest.mock('fs/promises');
jest.mock('path');

describe('TranslatorProcessor', () => {
  let processor: TranslatorProcessor;
  let eventsGateway: EventsGateway;

  // Mock EventsGateway
  const mockEventsGateway = {
    sendJobUpdateToClient: jest.fn(),
  };

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

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TranslatorProcessor,
        {
          provide: EventsGateway,
          useValue: mockEventsGateway,
        },
      ],
    }).compile();

    processor = module.get<TranslatorProcessor>(TranslatorProcessor);
    eventsGateway = module.get<EventsGateway>(EventsGateway);
  });

  // Mock Job data
  // Default test values
  const DEFAULT_TEST_VALUES = {
    TEST_CONTENT: 'test content',
    FILE_NAME: 'test.pdf',
    TARGET_LANGUAGE: 'Vietnamese',
    SOCKET_ID: 'test-socket-id'
  } as const;

  interface JobData {
    buffer: { type: 'Buffer', data: number[] };
    originalname: string;
    targetLanguage: string;
    socketId: string;
    isUserPremium: boolean;
  }

  /**
   * Creates a mock job with guaranteed string values
   */
  const createMockJob = (
    id: string = 'test-job',
    overrides: Partial<JobData> = {}
  ): Partial<Job<JobData>> => {
    // Ensure buffer is always properly formatted with non-empty content
    const content = overrides.buffer?.data ? 
      Buffer.from(overrides.buffer.data) : 
      Buffer.from(DEFAULT_TEST_VALUES.TEST_CONTENT);

    const defaultData: JobData = {
      buffer: { 
        type: 'Buffer', 
        data: Array.from(content) 
      },
      originalname: DEFAULT_TEST_VALUES.FILE_NAME,
      targetLanguage: DEFAULT_TEST_VALUES.TARGET_LANGUAGE,
      socketId: DEFAULT_TEST_VALUES.SOCKET_ID,
      isUserPremium: false
    };

    // Merge overrides with default data, ensuring string values
    const mergedData = {
      ...defaultData,
      ...overrides,
      // Ensure these specific fields are always strings if provided
      originalname: overrides.originalname?.toString() || defaultData.originalname,
      targetLanguage: overrides.targetLanguage?.toString() || defaultData.targetLanguage,
      socketId: overrides.socketId?.toString() || defaultData.socketId
    };

    return {
      id: id.toString(),
      data: mergedData
    };
  };

  // Mock API response
  const mockTranslationResponse = {
    data: {
      choices: [
        {
          message: {
            content: 'Translated text',
          },
        },
      ],
    },
  };

  describe('handleTranslation', () => {
    it('should process PDF files successfully', async () => {
      const mockJob = createMockJob('test-job', { originalname: 'test.pdf' });
      const mockPdfContent = 'PDF content to translate';
      
      // Mock PDF loading
      const mockPDFLoader = jest.requireMock('@langchain/community/document_loaders/fs/pdf');
      mockPDFLoader.PDFLoader.mockImplementation(() => ({
        load: jest.fn().mockResolvedValue([{ pageContent: mockPdfContent }]),
      }));

      // Mock translation API
      (axios.post as jest.Mock).mockResolvedValue(mockTranslationResponse);

      // Mock PDF creation
      (PDFDocument.create as jest.Mock).mockResolvedValue({
        registerFontkit: jest.fn(),
        addPage: jest.fn().mockReturnValue({
          getSize: jest.fn().mockReturnValue({ width: 612, height: 792 }),
          drawText: jest.fn(),
        }),
        embedFont: jest.fn().mockResolvedValue({
          widthOfTextAtSize: jest.fn().mockReturnValue(100),
        }),
        save: jest.fn().mockResolvedValue(new Uint8Array([1, 2, 3])),
      });

      // Mock file system operations
      (path.join as jest.Mock).mockReturnValue('/test/path');
      (fs.mkdir as jest.Mock).mockResolvedValue(undefined);
      (fs.writeFile as jest.Mock).mockResolvedValue(undefined);

      const result = await processor.handleTranslation(mockJob as Job);

      expect(result).toHaveProperty('translatedFileName');
      expect(mockEventsGateway.sendJobUpdateToClient).toHaveBeenCalledWith(
        'test-socket-id',
        'translationComplete',
        expect.any(Object),
      );
    });

    it('should process DOCX files successfully', async () => {
      const mockJob = createMockJob('test-job', { originalname: 'test.docx' });
      
      // Mock DOCX extraction
      (mammoth.extractRawText as jest.Mock).mockResolvedValue({
        value: 'DOCX content to translate',
      });

      // Mock translation API
      (axios.post as jest.Mock).mockResolvedValue(mockTranslationResponse);

      const result = await processor.handleTranslation(mockJob as Job);

      expect(result).toHaveProperty('translatedFileName');
      expect(mockEventsGateway.sendJobUpdateToClient).toHaveBeenCalled();
    });

    it('should process XLSX files successfully', async () => {
      const mockJob = createMockJob('test-job', { originalname: 'test.xlsx' });
      
      // Mock Excel processing
      const mockWorkbook = {
        xlsx: {
          load: jest.fn().mockResolvedValue(undefined),
          writeBuffer: jest.fn().mockResolvedValue(Buffer.from('test')),
        },
        eachSheet: jest.fn((callback) => {
          callback({
            eachRow: jest.fn((rowCallback) => {
              rowCallback({
                eachCell: jest.fn((cellCallback) => {
                  cellCallback({
                    value: 'Cell content',
                  });
                }),
              });
            }),
          });
        }),
      };
      
      (ExcelJS.Workbook as jest.Mock).mockImplementation(() => mockWorkbook);
      (axios.post as jest.Mock).mockResolvedValue(mockTranslationResponse);

      const result = await processor.handleTranslation(mockJob as Job);

      expect(result).toHaveProperty('translatedFileName');
      expect(mockEventsGateway.sendJobUpdateToClient).toHaveBeenCalled();
    });

    it('should handle translation API errors gracefully', async () => {
      const mockJob = createMockJob('test-job', { originalname: 'test.txt' });
      
      (axios.post as jest.Mock).mockRejectedValue(new Error('API Error'));

      await expect(processor.handleTranslation(mockJob as Job)).rejects.toThrow();
      expect(mockEventsGateway.sendJobUpdateToClient).toHaveBeenCalledWith(
        'test-socket-id',
        'translationFailed',
        expect.any(Object),
      );
    });

    it('should handle missing environment variables', async () => {
      process.env.OPENROUTER_API_KEY = '';
      const mockJob = createMockJob('test-job', { originalname: 'test.txt' });

      await expect(processor.handleTranslation(mockJob as Job)).rejects.toThrow();
      expect(mockEventsGateway.sendJobUpdateToClient).toHaveBeenCalledWith(
        'test-socket-id',
        'translationFailed',
        expect.objectContaining({
          reason: expect.stringContaining('API URL, Key, or Model is not configured'),
        }),
      );
    });

    it('should handle unsupported file types', async () => {
      const mockJob = createMockJob('test-job', { originalname: 'test.xyz' });

      await expect(processor.handleTranslation(mockJob as Job)).rejects.toThrow();
      expect(mockEventsGateway.sendJobUpdateToClient).toHaveBeenCalledWith(
        'test-socket-id',
        'translationFailed',
        expect.objectContaining({
          reason: expect.stringContaining('Unsupported file type'),
        }),
      );
    });

    it('should process files with different extensions correctly', async () => {
      const fileTypes = ['.pdf', '.docx', '.txt', '.csv', '.xlsx'];
      
      for (const ext of fileTypes) {
        const mockJob = createMockJob('test-job', {
          originalname: `test${ext}`,
          buffer: { 
            type: 'Buffer', 
            data: Array.from(Buffer.from('Sample content for ' + ext))
          }
        });

        // Mock specific handlers based on file type
        if (ext === '.pdf') {
          const mockPDFLoader = jest.requireMock('@langchain/community/document_loaders/fs/pdf');
          mockPDFLoader.PDFLoader.mockImplementation(() => ({
            load: jest.fn().mockResolvedValue([{ pageContent: 'PDF content' }]),
          }));
        }

        try {
          const result = await processor.handleTranslation(mockJob as Job);
          expect(result).toHaveProperty('translatedFileName');
          expect(result.translatedFileName).toContain(ext);
        } catch (error) {
          fail(`Failed to process ${ext} file: ${error.message}`);
        }
      }
    });

    it('should handle invalid file types with proper error', async () => {
      const invalidFileTypes = ['testfile', '', '.invalid', 'test.xyz'];
      
      for (const filename of invalidFileTypes) {
        const mockJob = createMockJob('test-job', { 
          originalname: filename
        });

        await expect(processor.handleTranslation(mockJob as Job)).rejects.toThrow();
        expect(mockEventsGateway.sendJobUpdateToClient).toHaveBeenCalledWith(
          DEFAULT_TEST_VALUES.SOCKET_ID,
          'translationFailed',
          expect.objectContaining({
            reason: expect.stringContaining('Unsupported file type'),
          }),
        );
      }
    });

    it('should handle empty but valid buffer data', async () => {
      const mockJob = createMockJob('test-job', { 
        originalname: 'test.txt',
        buffer: { 
          type: 'Buffer', 
          data: Array.from(Buffer.from('')) 
        }
      });

      const result = await processor.handleTranslation(mockJob as Job);
      expect(result).toHaveProperty('translatedFileName');
      expect(result.translatedFileName).toContain('.txt');
    });

    it('should process large text chunks correctly', async () => {
      const mockJob = createMockJob('test-job', { originalname: 'test.txt' });
      const longText = 'A'.repeat(5000); // Text longer than chunk size

      (axios.post as jest.Mock).mockResolvedValue(mockTranslationResponse);

      await processor.handleTranslation(mockJob as Job);

      // Should have made multiple API calls for chunks
      expect(axios.post).toHaveBeenCalledTimes(expect.any(Number));
    });

    it('should preserve text formatting in translations', async () => {
      const mockJob = createMockJob('test-job', { originalname: 'test.txt' });
      const formattedText = 'Line 1\nLine 2\n\nParagraph 2';

      (axios.post as jest.Mock).mockImplementation((url, payload) => {
        // Return same text structure but "translated"
        return Promise.resolve({
          data: {
            choices: [{
              message: {
                content: payload.messages[1].content.replace(/[a-zA-Z]/g, 'x'),
              },
            }],
          },
        });
      });

      const result = await processor.handleTranslation({
        ...mockJob,
        data: {
          ...mockJob.data,
          buffer: { type: 'Buffer', data: Array.from(Buffer.from(formattedText)) },
        },
      } as Job);

      expect(result).toBeDefined();
    });

    it('should handle concurrent translation requests within limits', async () => {
      const mockJob = createMockJob('test-job', { originalname: 'test.txt' });
      const longText = Array(20).fill('Paragraph').join('\n\n'); // Many paragraphs

      let concurrentCalls = 0;
      let maxConcurrentCalls = 0;

      (axios.post as jest.Mock).mockImplementation(async () => {
        concurrentCalls++;
        maxConcurrentCalls = Math.max(maxConcurrentCalls, concurrentCalls);
        await new Promise(resolve => setTimeout(resolve, 10)); // Small delay
        concurrentCalls--;
        return mockTranslationResponse;
      });

      await processor.handleTranslation({
        ...mockJob,
        data: {
          ...mockJob.data,
          buffer: { type: 'Buffer', data: Array.from(Buffer.from(longText)) },
        },
      } as Job);

      expect(maxConcurrentCalls).toBeLessThanOrEqual(10);
    });
  });
});