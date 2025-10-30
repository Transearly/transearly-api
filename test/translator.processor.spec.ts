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

// Mock p-limit to avoid ES module import issues
jest.mock('p-limit', () => {
  return {
    __esModule: true,
    default: jest.fn((concurrency: number) => {
      return (fn: () => Promise<any>) => fn();
    }),
  };
});

// Mock jszip and pptxgenjs for PPTX processing
jest.mock('jszip', () => ({
  __esModule: true,
  loadAsync: jest.fn(),
}));

jest.mock('pptxgenjs', () => {
  return jest.fn().mockImplementation(() => ({
    addSlide: jest.fn().mockReturnValue({
      addText: jest.fn(),
    }),
    write: jest.fn().mockResolvedValue(new ArrayBuffer(16)),
  }));
});

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
    // Setup path mocks with default behaviors
    (path.extname as jest.Mock).mockImplementation((filename: string) => {
      if (!filename || typeof filename !== 'string') return '';
      const match = filename.match(/\.[^.]+$/);
      return match ? match[0] : '';
    });
    (path.join as jest.Mock).mockImplementation((...args) => args.join('/'));

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
    // Preserve empty strings if explicitly provided (avoid falling back due to ||)
    const mergedData = {
      ...defaultData,
      ...overrides,
      // Ensure these specific fields are always strings if provided (allow empty string)
      originalname: (overrides.originalname !== undefined && overrides.originalname !== null)
        ? overrides.originalname.toString()
        : defaultData.originalname,
      targetLanguage: (overrides.targetLanguage !== undefined && overrides.targetLanguage !== null)
        ? overrides.targetLanguage.toString()
        : defaultData.targetLanguage,
      socketId: (overrides.socketId !== undefined && overrides.socketId !== null)
        ? overrides.socketId.toString()
        : defaultData.socketId
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
      
      // Mock path.extname for this specific test
      (path.extname as jest.Mock).mockReturnValue('.pdf');
      
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
      
      // Mock path.extname for this specific test
      (path.extname as jest.Mock).mockReturnValue('.docx');
      
      // Mock DOCX extraction
      (mammoth.extractRawText as jest.Mock).mockResolvedValue({
        value: 'DOCX content to translate',
      });

      // Mock translation API
      (axios.post as jest.Mock).mockResolvedValue(mockTranslationResponse);

      // Mock file system operations needed for output
      (path.join as jest.Mock).mockReturnValue('/test/path/translated-test-job.docx');
      (fs.mkdir as jest.Mock).mockResolvedValue(undefined);
      (fs.writeFile as jest.Mock).mockResolvedValue(undefined);

      const result = await processor.handleTranslation(mockJob as Job);

      expect(result).toHaveProperty('translatedFileName');
      expect(mockEventsGateway.sendJobUpdateToClient).toHaveBeenCalled();
    });

    it('should process XLSX files successfully', async () => {
      const mockJob = createMockJob('test-job', { originalname: 'test.xlsx' });
      
      // Mock path.extname for this specific test
      (path.extname as jest.Mock).mockReturnValue('.xlsx');
      
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

      // Mock file system operations needed for output
      (path.join as jest.Mock).mockReturnValue('/test/path/translated-test-job.xlsx');
      (fs.mkdir as jest.Mock).mockResolvedValue(undefined);
      (fs.writeFile as jest.Mock).mockResolvedValue(undefined);

      const result = await processor.handleTranslation(mockJob as Job);

      expect(result).toHaveProperty('translatedFileName');
      expect(mockEventsGateway.sendJobUpdateToClient).toHaveBeenCalled();
    });

    it('should process XLSX cells with richText values', async () => {
      const mockJob = createMockJob('test-job', { originalname: 'test.xlsx' });

      (path.extname as jest.Mock).mockReturnValue('.xlsx');

      const mockWorkbook = {
        xlsx: {
          load: jest.fn().mockResolvedValue(undefined),
          writeBuffer: jest.fn().mockResolvedValue(Buffer.from('out')),
        },
        eachSheet: jest.fn((callback) => {
          callback({
            eachRow: jest.fn((rowCallback) => {
              rowCallback({
                eachCell: jest.fn((cellCallback) => {
                  cellCallback({
                    value: {
                      richText: [
                        { text: 'Hello', font: { name: 'Calibri' } },
                        { text: ' ', font: { name: 'Calibri' } },
                        { text: 'World', font: { name: 'Calibri' } },
                      ],
                    },
                  });
                }),
              });
            }),
          });
        }),
      };

      (ExcelJS.Workbook as jest.Mock).mockImplementation(() => mockWorkbook);
      (axios.post as jest.Mock).mockResolvedValue(mockTranslationResponse);

      (path.join as jest.Mock).mockReturnValue('/test/path/translated-test-job.xlsx');
      (fs.mkdir as jest.Mock).mockResolvedValue(undefined);
      (fs.writeFile as jest.Mock).mockResolvedValue(undefined);

      const result = await processor.handleTranslation(mockJob as Job);
      expect(result).toHaveProperty('translatedFileName');
      expect(mockWorkbook.xlsx.writeBuffer).toHaveBeenCalled();
    });

    it('should process PPTX files successfully', async () => {
      const mockJob = createMockJob('test-job', { originalname: 'test.pptx' });
      (path.extname as jest.Mock).mockReturnValue('.pptx');

      // Mock temp file write/read
      (path.join as jest.Mock).mockReturnValue('D:/temp/temp-test-job.pptx');
      (fs.writeFile as jest.Mock).mockResolvedValue(undefined);
      (fs.readFile as jest.Mock).mockResolvedValue(Buffer.from('zip'));
      (fs.unlink as jest.Mock).mockResolvedValue(undefined);
      (fs.mkdir as jest.Mock).mockResolvedValue(undefined);

      // Mock JSZip to return one slide xml
      const jszipMock = jest.requireMock('jszip');
      jszipMock.loadAsync.mockResolvedValue({
        files: {
          'ppt/slides/slide1.xml': {
            async: jest.fn().mockResolvedValue('<a:t>Hello</a:t><a:t>World</a:t>'),
          },
        },
      });

      // Mock translation API
      (axios.post as jest.Mock).mockResolvedValue(mockTranslationResponse);

      const result = await processor.handleTranslation(mockJob as Job);
      expect(result).toHaveProperty('translatedFileName');
      expect(result.translatedFileName).toContain('.pptx');
    });

    it('should handle translation API errors gracefully', async () => {
      const mockJob = createMockJob('test-job', { originalname: 'test.txt' });

      // Force .txt path
      (path.extname as jest.Mock).mockReturnValue('.txt');

      // Translation API fails, but translateChunk catches and returns placeholder
      (axios.post as jest.Mock).mockRejectedValue(new Error('API Error'));

      const result = await processor.handleTranslation(mockJob as Job);
      expect(result).toHaveProperty('translatedFileName');
      // Should complete (not fail) despite API errors due to graceful fallback in translateChunk
      expect(mockEventsGateway.sendJobUpdateToClient).toHaveBeenCalledWith(
        'test-socket-id',
        'translationComplete',
        expect.any(Object),
      );
    });

    it('should handle missing environment variables', async () => {
      process.env.OPENROUTER_API_KEY = '';
      const mockJob = createMockJob('test-job', { originalname: 'test.txt' });

      // Force .txt path
      (path.extname as jest.Mock).mockReturnValue('.txt');

      const result = await processor.handleTranslation(mockJob as Job);
      expect(result).toHaveProperty('translatedFileName');
      // Should still complete due to translateChunk catching the error and returning placeholder
      expect(mockEventsGateway.sendJobUpdateToClient).toHaveBeenCalledWith(
        'test-socket-id',
        'translationComplete',
        expect.any(Object),
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
        // Force extname to the current ext
        (path.extname as jest.Mock).mockReturnValue(ext);

        // Build appropriate buffer per type
        const contentByExt: Record<string, Buffer> = {
          '.pdf': Buffer.from('PDF content'),
          '.docx': Buffer.from('DOCX content'),
          '.txt': Buffer.from('Plain text content'),
          '.csv': Buffer.from('name,age\nAlice,30\nBob,25'),
          '.xlsx': Buffer.from('xlsx-bytes'),
        };

        const mockJob = createMockJob('test-job', {
          originalname: `test${ext}`,
          buffer: { 
            type: 'Buffer', 
            data: Array.from(contentByExt[ext])
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
          // Common mocks for FS writes
          (path.join as jest.Mock).mockReturnValue(`/test/path/translated-test-job${ext}`);
          (fs.mkdir as jest.Mock).mockResolvedValue(undefined);
          (fs.writeFile as jest.Mock).mockResolvedValue(undefined);

          // Ensure translation API responds
          (axios.post as jest.Mock).mockResolvedValue(mockTranslationResponse);

          const result = await processor.handleTranslation(mockJob as Job);
          expect(result).toHaveProperty('translatedFileName');
          expect(result.translatedFileName).toContain(ext);
        } catch (error) {
          throw new Error(`Failed to process ${ext} file: ${(error as Error).message}`);
        }
      }
    });

    it('should handle invalid file types with proper error', async () => {
      const invalidFileTypes = ['testfile', '', '.invalid', 'test.xyz'];
      
      for (const filename of invalidFileTypes) {
        const mockJob = createMockJob('test-job', { 
          originalname: filename
        });

        // Ensure extname uses the provided filename faithfully
        (path.extname as jest.Mock).mockImplementation((fn: string) => {
          if (!fn || typeof fn !== 'string') return '';
          const m = fn.match(/\.[^.]+$/);
          return m ? m[0] : '';
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
      const longText = 'A'.repeat(10000); // Ensure > 2 chunks

      (axios.post as jest.Mock).mockClear();
      (axios.post as jest.Mock).mockResolvedValue(mockTranslationResponse);

      await processor.handleTranslation({
        ...mockJob,
        data: {
          ...mockJob.data,
          buffer: { type: 'Buffer', data: Array.from(Buffer.from(longText)) },
        },
      } as Job);

      // Should have made multiple API calls for chunks
      expect((axios.post as jest.Mock).mock.calls.length).toBeGreaterThan(1);
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

    it('should handle CSV files with minimal data', async () => {
      const mockJob = createMockJob('test-job', { originalname: 'test.csv' });
      const csvContent = 'name\nJohn'; // Minimal CSV with header and one row

      (path.extname as jest.Mock).mockReturnValue('.csv');
      (axios.post as jest.Mock).mockResolvedValue(mockTranslationResponse);
      (path.join as jest.Mock).mockReturnValue('/test/path/translated-test-job.csv');
      (fs.mkdir as jest.Mock).mockResolvedValue(undefined);
      (fs.writeFile as jest.Mock).mockResolvedValue(undefined);

      const result = await processor.handleTranslation({
        ...mockJob,
        data: {
          ...mockJob.data,
          buffer: { type: 'Buffer', data: Array.from(Buffer.from(csvContent)) },
        },
      } as Job);

      expect(result).toHaveProperty('translatedFileName');
      expect(result.translatedFileName).toContain('.csv');
    });

    it('should process CSV files successfully', async () => {
      const mockJob = createMockJob('test-job', { originalname: 'test.csv' });
      const csvContent = 'name,age\nAlice,30\nBob,25';

      (path.extname as jest.Mock).mockReturnValue('.csv');
      (axios.post as jest.Mock).mockResolvedValue(mockTranslationResponse);
      (path.join as jest.Mock).mockReturnValue('/test/path/translated-test-job.csv');
      (fs.mkdir as jest.Mock).mockResolvedValue(undefined);
      (fs.writeFile as jest.Mock).mockResolvedValue(undefined);

      const result = await processor.handleTranslation({
        ...mockJob,
        data: {
          ...mockJob.data,
          buffer: { type: 'Buffer', data: Array.from(Buffer.from(csvContent)) },
        },
      } as Job);

      expect(result).toHaveProperty('translatedFileName');
      expect(result.translatedFileName).toContain('.csv');
    });

    it('should handle XLSX with empty workbook', async () => {
      const mockJob = createMockJob('test-job', { originalname: 'test.xlsx' });

      (path.extname as jest.Mock).mockReturnValue('.xlsx');

      // Mock empty workbook
      const mockWorkbook = {
        xlsx: {
          load: jest.fn().mockResolvedValue(undefined),
          writeBuffer: jest.fn().mockResolvedValue(Buffer.from('empty')),
        },
        eachSheet: jest.fn((callback) => {
          // No sheets, callback never called
        }),
      };

      (ExcelJS.Workbook as jest.Mock).mockImplementation(() => mockWorkbook);
      (path.join as jest.Mock).mockReturnValue('/test/path/translated-test-job.xlsx');
      (fs.mkdir as jest.Mock).mockResolvedValue(undefined);
      (fs.writeFile as jest.Mock).mockResolvedValue(undefined);

      const result = await processor.handleTranslation(mockJob as Job);
      expect(result).toHaveProperty('translatedFileName');
    });

    it('should handle XLSX with cells containing numbers', async () => {
      const mockJob = createMockJob('test-job', { originalname: 'test.xlsx' });

      (path.extname as jest.Mock).mockReturnValue('.xlsx');

      const mockWorkbook = {
        xlsx: {
          load: jest.fn().mockResolvedValue(undefined),
          writeBuffer: jest.fn().mockResolvedValue(Buffer.from('output')),
        },
        eachSheet: jest.fn((callback) => {
          const mockSheet = {
            eachRow: jest.fn((rowCallback) => {
              const mockRow = {
                eachCell: jest.fn((cellCallback) => {
                  // Cell with number value
                  const mockCell = {
                    value: 42,
                  };
                  cellCallback(mockCell);

                  // Cell with string value
                  const mockCell2 = {
                    value: 'Text',
                  };
                  cellCallback(mockCell2);
                }),
              };
              rowCallback(mockRow);
            }),
          };
          callback(mockSheet);
        }),
      };

      (ExcelJS.Workbook as jest.Mock).mockImplementation(() => mockWorkbook);
      (axios.post as jest.Mock).mockResolvedValue(mockTranslationResponse);
      (path.join as jest.Mock).mockReturnValue('/test/path/translated-test-job.xlsx');
      (fs.mkdir as jest.Mock).mockResolvedValue(undefined);
      (fs.writeFile as jest.Mock).mockResolvedValue(undefined);

      const result = await processor.handleTranslation(mockJob as Job);
      expect(result).toHaveProperty('translatedFileName');
    });

    it('should handle PPTX with empty slides', async () => {
      const mockJob = createMockJob('test-job', { originalname: 'test.pptx' });
      (path.extname as jest.Mock).mockReturnValue('.pptx');

      (path.join as jest.Mock).mockReturnValue('D:/temp/temp-test-job.pptx');
      (fs.writeFile as jest.Mock).mockResolvedValue(undefined);
      (fs.readFile as jest.Mock).mockResolvedValue(Buffer.from('zip'));
      (fs.unlink as jest.Mock).mockResolvedValue(undefined);
      (fs.mkdir as jest.Mock).mockResolvedValue(undefined);

      const jszipMock = jest.requireMock('jszip');
      jszipMock.loadAsync.mockResolvedValue({
        files: {
          'ppt/slides/slide1.xml': {
            async: jest.fn().mockResolvedValue('<slide></slide>'), // No text tags
          },
        },
      });

      (axios.post as jest.Mock).mockResolvedValue(mockTranslationResponse);

      const result = await processor.handleTranslation(mockJob as Job);
      expect(result).toHaveProperty('translatedFileName');
      expect(result.translatedFileName).toContain('.pptx');
    });

    it('should handle PPTX with no slides', async () => {
      const mockJob = createMockJob('test-job', { originalname: 'test.pptx' });
      (path.extname as jest.Mock).mockReturnValue('.pptx');

      (path.join as jest.Mock).mockReturnValue('D:/temp/temp-test-job.pptx');
      (fs.writeFile as jest.Mock).mockResolvedValue(undefined);
      (fs.readFile as jest.Mock).mockResolvedValue(Buffer.from('zip'));
      (fs.unlink as jest.Mock).mockResolvedValue(undefined);
      (fs.mkdir as jest.Mock).mockResolvedValue(undefined);

      const jszipMock = jest.requireMock('jszip');
      jszipMock.loadAsync.mockResolvedValue({
        files: {}, // No slides at all
      });

      const result = await processor.handleTranslation(mockJob as Job);
      expect(result).toHaveProperty('translatedFileName');
      expect(result.translatedFileName).toContain('.pptx');
    });

    it('should handle PPTX with multiple slides in correct order', async () => {
      const mockJob = createMockJob('test-job', { originalname: 'test.pptx' });
      (path.extname as jest.Mock).mockReturnValue('.pptx');

      (path.join as jest.Mock).mockReturnValue('D:/temp/temp-test-job.pptx');
      (fs.writeFile as jest.Mock).mockResolvedValue(undefined);
      (fs.readFile as jest.Mock).mockResolvedValue(Buffer.from('zip'));
      (fs.unlink as jest.Mock).mockResolvedValue(undefined);
      (fs.mkdir as jest.Mock).mockResolvedValue(undefined);

      const jszipMock = jest.requireMock('jszip');
      jszipMock.loadAsync.mockResolvedValue({
        files: {
          'ppt/slides/slide3.xml': {
            async: jest.fn().mockResolvedValue('<a:t>Slide 3</a:t>'),
          },
          'ppt/slides/slide1.xml': {
            async: jest.fn().mockResolvedValue('<a:t>Slide 1</a:t>'),
          },
          'ppt/slides/slide2.xml': {
            async: jest.fn().mockResolvedValue('<a:t>Slide 2</a:t>'),
          },
        },
      });

      (axios.post as jest.Mock).mockResolvedValue(mockTranslationResponse);

      const result = await processor.handleTranslation(mockJob as Job);
      expect(result).toHaveProperty('translatedFileName');
      expect(result.translatedFileName).toContain('.pptx');
    });

    it('should handle wrapText with newline characters', async () => {
      const mockJob = createMockJob('test-job', { originalname: 'test.pdf' });
      const textWithNewlines = 'Line 1\nLine 2\nLine 3';

      (path.extname as jest.Mock).mockReturnValue('.pdf');

      const mockPDFLoader = jest.requireMock('@langchain/community/document_loaders/fs/pdf');
      mockPDFLoader.PDFLoader.mockImplementation(() => ({
        load: jest.fn().mockResolvedValue([{ pageContent: textWithNewlines }]),
      }));

      (axios.post as jest.Mock).mockResolvedValue(mockTranslationResponse);

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

      (path.join as jest.Mock).mockReturnValue('/test/path');
      (fs.mkdir as jest.Mock).mockResolvedValue(undefined);
      (fs.writeFile as jest.Mock).mockResolvedValue(undefined);

      const result = await processor.handleTranslation(mockJob as Job);
      expect(result).toHaveProperty('translatedFileName');
    });

    it('should handle wrapText with long words exceeding maxWidth', async () => {
      const mockJob = createMockJob('test-job', { originalname: 'test.pdf' });
      const longWord = 'A'.repeat(100); // Very long word

      (path.extname as jest.Mock).mockReturnValue('.pdf');

      const mockPDFLoader = jest.requireMock('@langchain/community/document_loaders/fs/pdf');
      mockPDFLoader.PDFLoader.mockImplementation(() => ({
        load: jest.fn().mockResolvedValue([{ pageContent: longWord }]),
      }));

      (axios.post as jest.Mock).mockResolvedValue(mockTranslationResponse);

      (PDFDocument.create as jest.Mock).mockResolvedValue({
        registerFontkit: jest.fn(),
        addPage: jest.fn().mockReturnValue({
          getSize: jest.fn().mockReturnValue({ width: 612, height: 792 }),
          drawText: jest.fn(),
        }),
        embedFont: jest.fn().mockResolvedValue({
          widthOfTextAtSize: jest.fn().mockReturnValue(500), // Wide text
        }),
        save: jest.fn().mockResolvedValue(new Uint8Array([1, 2, 3])),
      });

      (path.join as jest.Mock).mockReturnValue('/test/path');
      (fs.mkdir as jest.Mock).mockResolvedValue(undefined);
      (fs.writeFile as jest.Mock).mockResolvedValue(undefined);

      const result = await processor.handleTranslation(mockJob as Job);
      expect(result).toHaveProperty('translatedFileName');
    });

    it('should handle PDF with multiple pages', async () => {
      const mockJob = createMockJob('test-job', { originalname: 'test.pdf' });
      // Create enough lines to exceed one page (792 height / 16.5 line height = ~48 lines per page)
      const longText = Array(200).fill('This is a long line of text that will be repeated many times').join('\n');

      (path.extname as jest.Mock).mockReturnValue('.pdf');

      const mockPDFLoader = jest.requireMock('@langchain/community/document_loaders/fs/pdf');
      mockPDFLoader.PDFLoader.mockImplementation(() => ({
        load: jest.fn().mockResolvedValue([{ pageContent: longText }]),
      }));

      (axios.post as jest.Mock).mockResolvedValue(mockTranslationResponse);

      let pageCount = 0;
      (PDFDocument.create as jest.Mock).mockResolvedValue({
        registerFontkit: jest.fn(),
        addPage: jest.fn().mockImplementation(() => {
          pageCount++;
          return {
            getSize: jest.fn().mockReturnValue({ width: 612, height: 792 }),
            drawText: jest.fn(),
          };
        }),
        embedFont: jest.fn().mockResolvedValue({
          widthOfTextAtSize: jest.fn().mockReturnValue(100),
        }),
        save: jest.fn().mockResolvedValue(new Uint8Array([1, 2, 3])),
      });

      (path.join as jest.Mock).mockReturnValue('/test/path');
      (fs.mkdir as jest.Mock).mockResolvedValue(undefined);
      (fs.writeFile as jest.Mock).mockResolvedValue(undefined);

      const result = await processor.handleTranslation(mockJob as Job);
      expect(result).toHaveProperty('translatedFileName');
      expect(pageCount).toBeGreaterThanOrEqual(1); // Should create at least one page
    });

    it('should use default target language when not provided', async () => {
      const mockJob = createMockJob('test-job', { 
        originalname: 'test.txt',
        targetLanguage: undefined as any, // No target language
      });

      (path.extname as jest.Mock).mockReturnValue('.txt');
      (axios.post as jest.Mock).mockResolvedValue(mockTranslationResponse);
      (path.join as jest.Mock).mockReturnValue('/test/path');
      (fs.mkdir as jest.Mock).mockResolvedValue(undefined);
      (fs.writeFile as jest.Mock).mockResolvedValue(undefined);

      const result = await processor.handleTranslation(mockJob as Job);
      expect(result).toHaveProperty('translatedFileName');
    });

    it('should handle translateChunk with missing API response content', async () => {
      const mockJob = createMockJob('test-job', { originalname: 'test.txt' });

      (path.extname as jest.Mock).mockReturnValue('.txt');
      (axios.post as jest.Mock).mockResolvedValue({
        data: {
          choices: [{
            message: {
              content: null, // Missing content
            },
          }],
        },
      });
      (path.join as jest.Mock).mockReturnValue('/test/path');
      (fs.mkdir as jest.Mock).mockResolvedValue(undefined);
      (fs.writeFile as jest.Mock).mockResolvedValue(undefined);

      // Should complete successfully with error placeholder in translated content
      const result = await processor.handleTranslation(mockJob as Job);
      expect(result).toHaveProperty('translatedFileName');
      expect(result.translatedFileName).toContain('.txt');
    });

    it('should handle translateChunk with invalid API response structure', async () => {
      const mockJob = createMockJob('test-job', { originalname: 'test.txt' });

      (path.extname as jest.Mock).mockReturnValue('.txt');
      (axios.post as jest.Mock).mockResolvedValue({
        data: {
          choices: null, // Invalid structure
        },
      });
      (path.join as jest.Mock).mockReturnValue('/test/path');
      (fs.mkdir as jest.Mock).mockResolvedValue(undefined);
      (fs.writeFile as jest.Mock).mockResolvedValue(undefined);

      // Should complete successfully with error placeholder in translated content
      const result = await processor.handleTranslation(mockJob as Job);
      expect(result).toHaveProperty('translatedFileName');
      expect(result.translatedFileName).toContain('.txt');
    });

    it('should handle DOCX with empty text content', async () => {
      const mockJob = createMockJob('test-job', { originalname: 'test.docx' });

      (path.extname as jest.Mock).mockReturnValue('.docx');
      (mammoth.extractRawText as jest.Mock).mockResolvedValue({
        value: '', // Empty content
      });
      (axios.post as jest.Mock).mockResolvedValue(mockTranslationResponse);
      (path.join as jest.Mock).mockReturnValue('/test/path/translated-test-job.docx');
      (fs.mkdir as jest.Mock).mockResolvedValue(undefined);
      (fs.writeFile as jest.Mock).mockResolvedValue(undefined);

      const result = await processor.handleTranslation(mockJob as Job);
      expect(result).toHaveProperty('translatedFileName');
    });

    it('should handle no output buffer generated error', async () => {
      const mockJob = createMockJob('test-job', { originalname: 'test.pdf' });

      (path.extname as jest.Mock).mockReturnValue('.pdf');

      const mockPDFLoader = jest.requireMock('@langchain/community/document_loaders/fs/pdf');
      mockPDFLoader.PDFLoader.mockImplementation(() => ({
        load: jest.fn().mockResolvedValue([{ pageContent: 'content' }]),
      }));

      (axios.post as jest.Mock).mockResolvedValue(mockTranslationResponse);

      // Mock createPdf to return null/undefined
      (PDFDocument.create as jest.Mock).mockResolvedValue({
        registerFontkit: jest.fn(),
        addPage: jest.fn().mockReturnValue({
          getSize: jest.fn().mockReturnValue({ width: 612, height: 792 }),
          drawText: jest.fn(),
        }),
        embedFont: jest.fn().mockResolvedValue({
          widthOfTextAtSize: jest.fn().mockReturnValue(100),
        }),
        save: jest.fn().mockResolvedValue(null), // Returns null instead of buffer
      });

      (path.join as jest.Mock).mockReturnValue('/test/path');
      (fs.mkdir as jest.Mock).mockResolvedValue(undefined);
      (fs.writeFile as jest.Mock).mockResolvedValue(undefined);

      // Expect error from Buffer.from() when receiving null
      await expect(processor.handleTranslation(mockJob as Job)).rejects.toThrow('The first argument must be of type string or an instance of Buffer');
    });

    it('should handle XLSX cells with empty or whitespace text', async () => {
      const mockJob = createMockJob('test-job', { originalname: 'test.xlsx' });

      (path.extname as jest.Mock).mockReturnValue('.xlsx');

      const mockWorkbook = {
        xlsx: {
          load: jest.fn().mockResolvedValue(undefined),
          writeBuffer: jest.fn().mockResolvedValue(Buffer.from('output')),
        },
        eachSheet: jest.fn((callback) => {
          const mockSheet = {
            eachRow: jest.fn((rowCallback) => {
              const mockRow = {
                eachCell: jest.fn((cellCallback) => {
                  // Cell with whitespace only
                  const mockCell1 = {
                    value: '   ',
                  };
                  cellCallback(mockCell1);

                  // Cell with empty string
                  const mockCell2 = {
                    value: '',
                  };
                  cellCallback(mockCell2);

                  // Cell with null/undefined
                  const mockCell3 = {
                    value: null,
                  };
                  cellCallback(mockCell3);
                }),
              };
              rowCallback(mockRow);
            }),
          };
          callback(mockSheet);
        }),
      };

      (ExcelJS.Workbook as jest.Mock).mockImplementation(() => mockWorkbook);
      (path.join as jest.Mock).mockReturnValue('/test/path/translated-test-job.xlsx');
      (fs.mkdir as jest.Mock).mockResolvedValue(undefined);
      (fs.writeFile as jest.Mock).mockResolvedValue(undefined);

      const result = await processor.handleTranslation(mockJob as Job);
      expect(result).toHaveProperty('translatedFileName');
    });
  });
});