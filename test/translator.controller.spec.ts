import { Test, TestingModule } from '@nestjs/testing';
import { TranslatorController } from '../src/modules/translator/translator.controller';
import { TranslatorService } from '../src/modules/translator/translator.service';
import { ConfigService } from '@nestjs/config';
import { EventsGateway } from '../src/modules/events/events.gateway';
import { HttpException, HttpStatus, PayloadTooLargeException, BadRequestException } from '@nestjs/common';
import { Response } from 'express';
import * as fs from 'fs';

describe('TranslatorController', () => {
  let controller: TranslatorController;
  let translatorService: TranslatorService;
  let configService: ConfigService;
  let eventsGateway: EventsGateway;

  // Mock services
  const mockTranslatorService = {
    startTranslationJob: jest.fn(),
    getJobStatus: jest.fn(),
    translateTextDirect: jest.fn(),
    translateImageDirect: jest.fn(),
  };

  const mockConfigService = {
    get: jest.fn(),
  };

  const mockEventsGateway = {
    sendJobUpdateToClient: jest.fn(),
  };

  // Mock file data
  const createMockFile = (
    mimetype: string,
    size: number,
    originalname: string = 'test.pdf',
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

  // Mock image file data for image translation tests
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
    buffer: Buffer.from('mock image content data'),
    stream: {} as any,
    destination: '',
    filename: '',
    path: '',
  });

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [TranslatorController],
      providers: [
        {
          provide: TranslatorService,
          useValue: mockTranslatorService,
        },
        {
          provide: ConfigService,
          useValue: mockConfigService,
        },
        {
          provide: EventsGateway,
          useValue: mockEventsGateway,
        },
      ],
    }).compile();

    controller = module.get<TranslatorController>(TranslatorController);
    translatorService = module.get<TranslatorService>(TranslatorService);
    configService = module.get<ConfigService>(ConfigService);
    eventsGateway = module.get<EventsGateway>(EventsGateway);

    // Clear all mocks before each test
    jest.clearAllMocks();
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });

  describe('uploadPdf', () => {
    const mockSocketId = 'socket-123';
    const mockTargetLanguage = 'Vietnamese';
    const mockJobId = 'job-456';

    beforeEach(() => {
      mockConfigService.get
        .mockReturnValueOnce('true') // UPLOAD_LIMIT_ENABLED
        .mockReturnValueOnce(10); // UPLOAD_LIMIT_KB
    });

    it('should throw error if socketId is missing', async () => {
      const file = createMockFile('application/pdf', 5000);

      await expect(
        controller.uploadPdf(file, mockTargetLanguage, false, '' as any),
      ).rejects.toThrow(
        new HttpException('Socket ID is required.', HttpStatus.BAD_REQUEST),
      );
    });

    it('should throw BadRequestException for unsupported file type', async () => {
      const file = createMockFile('image/jpeg', 5000);

      await expect(
        controller.uploadPdf(file, mockTargetLanguage, false, mockSocketId),
      ).rejects.toThrow(BadRequestException);

      expect(mockEventsGateway.sendJobUpdateToClient).toHaveBeenCalledWith(
        mockSocketId,
        'translationFailed',
        expect.objectContaining({
          jobId: null,
          status: 'failed',
          reason: `File is too large. Limit: 10KB.`,
        }),
      );
    });

    it('should accept PDF files', async () => {
      const file = createMockFile('application/pdf', 5000);
      mockTranslatorService.startTranslationJob.mockResolvedValue({ id: mockJobId });

      const result = await controller.uploadPdf(
        file,
        mockTargetLanguage,
        false,
        mockSocketId,
      );

      expect(result).toEqual({
        message: 'File received. Translation started.',
        jobId: mockJobId,
        targetLanguage: mockTargetLanguage,
      });
    });

    it('should accept DOCX files', async () => {
      const file = createMockFile(
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        5000,
        'test.docx',
      );
      mockTranslatorService.startTranslationJob.mockResolvedValue({ id: mockJobId });

      const result = await controller.uploadPdf(
        file,
        mockTargetLanguage,
        false,
        mockSocketId,
      );

      expect(result.jobId).toBe(mockJobId);
    });

    it('should accept TXT files', async () => {
      const file = createMockFile('text/plain', 5000, 'test.txt');
      mockTranslatorService.startTranslationJob.mockResolvedValue({ id: mockJobId });

      const result = await controller.uploadPdf(
        file,
        mockTargetLanguage,
        false,
        mockSocketId,
      );

      expect(result.jobId).toBe(mockJobId);
    });

    it('should accept XLSX files', async () => {
      const file = createMockFile(
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        5000,
        'test.xlsx',
      );
      mockTranslatorService.startTranslationJob.mockResolvedValue({ id: mockJobId });

      const result = await controller.uploadPdf(
        file,
        mockTargetLanguage,
        false,
        mockSocketId,
      );

      expect(result.jobId).toBe(mockJobId);
    });

    it('should accept PPTX files', async () => {
      const file = createMockFile(
        'application/vnd.openxmlformats-officedocument.presentationml.presentation',
        5000,
        'test.pptx',
      );
      mockTranslatorService.startTranslationJob.mockResolvedValue({ id: mockJobId });

      const result = await controller.uploadPdf(
        file,
        mockTargetLanguage,
        false,
        mockSocketId,
      );

      expect(result.jobId).toBe(mockJobId);
    });

    it('should throw PayloadTooLargeException for non-premium users with large files', async () => {
      const file = createMockFile('application/pdf', 15000); // 15KB > 10KB limit

      await expect(
        controller.uploadPdf(file, mockTargetLanguage, false, mockSocketId),
      ).rejects.toThrow(PayloadTooLargeException);

      expect(mockEventsGateway.sendJobUpdateToClient).toHaveBeenCalledWith(
        mockSocketId,
        'translationFailed',
        expect.objectContaining({
          status: 'failed',
          reason: 'File is too large. Limit: 10KB.',
        }),
      );
    });

    it('should allow premium users to upload large files', async () => {
      const file = createMockFile('application/pdf', 15000); // 15KB > 10KB limit
      mockTranslatorService.startTranslationJob.mockResolvedValue({ id: mockJobId });

      const result = await controller.uploadPdf(
        file,
        mockTargetLanguage,
        true, // Premium user
        mockSocketId,
      );

      expect(result.jobId).toBe(mockJobId);
      expect(mockTranslatorService.startTranslationJob).toHaveBeenCalledWith(
        file,
        mockTargetLanguage,
        mockSocketId,
        true,
      );
    });

    it('should not enforce size limit when limit is disabled', async () => {
      mockConfigService.get
        .mockReset()
        .mockReturnValueOnce('false') // UPLOAD_LIMIT_ENABLED = false
        .mockReturnValueOnce(10); // UPLOAD_LIMIT_KB

      const file = createMockFile('application/pdf', 15000);
      mockTranslatorService.startTranslationJob.mockResolvedValue({ id: mockJobId });

      const result = await controller.uploadPdf(
        file,
        mockTargetLanguage,
        false,
        mockSocketId,
      );

      expect(result.jobId).toBe(mockJobId);
    });

    it('should use default target language if not provided', async () => {
      const file = createMockFile('application/pdf', 5000);
      mockTranslatorService.startTranslationJob.mockResolvedValue({ id: mockJobId });

      const result = await controller.uploadPdf(file, undefined, false, mockSocketId);

      expect(mockTranslatorService.startTranslationJob).toHaveBeenCalledWith(
        file,
        'Vietnamese', // Default language should be used when undefined is passed
        mockSocketId,
        false,
      );
      expect(result.targetLanguage).toBe('Vietnamese');
    });

    it('should pass custom target language to service', async () => {
      const file = createMockFile('application/pdf', 5000);
      const customLanguage = 'Spanish';
      mockTranslatorService.startTranslationJob.mockResolvedValue({ id: mockJobId });

      await controller.uploadPdf(file, customLanguage, false, mockSocketId);

      expect(mockTranslatorService.startTranslationJob).toHaveBeenCalledWith(
        file,
        customLanguage,
        mockSocketId,
        false,
      );
    });
  });

  describe('getJobStatus', () => {
    it('should return job status for valid jobId', async () => {
      const mockJobId = 'job-123';
      const mockStatus = {
        status: 'completed',
        result: { translatedFileName: 'translated-file.pdf' },
      };

      mockTranslatorService.getJobStatus.mockResolvedValue(mockStatus);

      const result = await controller.getJobStatus(mockJobId);

      expect(result).toEqual(mockStatus);
      expect(mockTranslatorService.getJobStatus).toHaveBeenCalledWith(mockJobId);
    });

    it('should return not_found status for non-existent job', async () => {
      const mockJobId = 'non-existent-job';
      mockTranslatorService.getJobStatus.mockResolvedValue({ status: 'not_found' });

      const result = await controller.getJobStatus(mockJobId);

      expect(result.status).toBe('not_found');
    });

    it('should return processing status for in-progress job', async () => {
      const mockJobId = 'job-processing';
      mockTranslatorService.getJobStatus.mockResolvedValue({ status: 'processing' });

      const result = await controller.getJobStatus(mockJobId);

      expect(result.status).toBe('processing');
    });

    it('should return failed status with reason', async () => {
      const mockJobId = 'job-failed';
      const mockStatus = {
        status: 'failed',
        reason: 'Translation API error',
      };

      mockTranslatorService.getJobStatus.mockResolvedValue(mockStatus);

      const result = await controller.getJobStatus(mockJobId);

      expect(result).toEqual(mockStatus);
    });
  });

  describe('translateText', () => {
    it('should translate text successfully', async () => {
      const mockText = 'Hello, how are you?';
      const mockTargetLanguage = 'Vietnamese';
      const mockTranslatedText = 'Xin chào, bạn khỏe không?';

      mockTranslatorService.translateTextDirect.mockResolvedValue(mockTranslatedText);

      const result = await controller.translateText(mockText, mockTargetLanguage);

      expect(result).toEqual({
        success: true,
        targetLanguage: mockTargetLanguage,
        translatedText: mockTranslatedText,
      });

      expect(mockTranslatorService.translateTextDirect).toHaveBeenCalledWith(
        mockText,
        mockTargetLanguage,
      );
    });

    it('should use default target language when not provided', async () => {
      const mockText = 'Hello, world!';
      const mockTranslatedText = 'Xin chào thế giới!';

      mockTranslatorService.translateTextDirect.mockResolvedValue(mockTranslatedText);

      const result = await controller.translateText(mockText);

      expect(result.targetLanguage).toBe('Vietnamese');
      expect(mockTranslatorService.translateTextDirect).toHaveBeenCalledWith(
        mockText,
        'Vietnamese',
      );
    });

    it('should throw error for empty text', async () => {
      await expect(
        controller.translateText(''),
      ).rejects.toThrow(
        new HttpException('Text is required.', HttpStatus.BAD_REQUEST),
      );

      await expect(
        controller.translateText('   '), // Only whitespace
      ).rejects.toThrow(
        new HttpException('Text is required.', HttpStatus.BAD_REQUEST),
      );
    });

    it('should throw error for missing text', async () => {
      await expect(
        controller.translateText(undefined as any),
      ).rejects.toThrow(
        new HttpException('Text is required.', HttpStatus.BAD_REQUEST),
      );

      await expect(
        controller.translateText(null as any),
      ).rejects.toThrow(
        new HttpException('Text is required.', HttpStatus.BAD_REQUEST),
      );
    });

    it('should handle translation service errors', async () => {
      const mockText = 'Hello, world!';
      const errorMessage = 'API configuration missing';

      mockTranslatorService.translateTextDirect.mockRejectedValue(
        new Error(errorMessage),
      );

      await expect(
        controller.translateText(mockText, 'Spanish'),
      ).rejects.toThrow(
        new HttpException(
          `Translation failed: ${errorMessage}`,
          HttpStatus.INTERNAL_SERVER_ERROR,
        ),
      );
    });

    it('should handle different target languages', async () => {
      const mockText = 'Good morning';
      const languages = ['Spanish', 'French', 'German', 'Japanese'];

      for (const language of languages) {
        const mockTranslatedText = `Translated to ${language}`;
        mockTranslatorService.translateTextDirect.mockResolvedValue(mockTranslatedText);

        const result = await controller.translateText(mockText, language);

        expect(result.targetLanguage).toBe(language);
        expect(result.translatedText).toBe(mockTranslatedText);
        expect(mockTranslatorService.translateTextDirect).toHaveBeenCalledWith(
          mockText,
          language,
        );
      }
    });

    it('should handle long text input', async () => {
      const longText = 'Lorem ipsum '.repeat(1000); // Very long text
      const mockTranslatedText = 'Translated long text';

      mockTranslatorService.translateTextDirect.mockResolvedValue(mockTranslatedText);

      const result = await controller.translateText(longText, 'Vietnamese');

      expect(result.translatedText).toBe(mockTranslatedText);
      expect(mockTranslatorService.translateTextDirect).toHaveBeenCalledWith(
        longText,
        'Vietnamese',
      );
    });

    it('should handle special characters and emojis', async () => {
      const textWithSpecialChars = 'Hello! 😀 How are you? ¿Cómo estás?';
      const mockTranslatedText = 'Translated special text';

      mockTranslatorService.translateTextDirect.mockResolvedValue(mockTranslatedText);

      const result = await controller.translateText(textWithSpecialChars, 'Spanish');

      expect(result.translatedText).toBe(mockTranslatedText);
      expect(mockTranslatorService.translateTextDirect).toHaveBeenCalledWith(
        textWithSpecialChars,
        'Spanish',
      );
    });

    it('should trim whitespace from input text', async () => {
      const textWithWhitespace = '  Hello, world!  ';
      const mockTranslatedText = 'Hola, mundo!';

      mockTranslatorService.translateTextDirect.mockResolvedValue(mockTranslatedText);

      const result = await controller.translateText(textWithWhitespace, 'Spanish');

      expect(result.translatedText).toBe(mockTranslatedText);
      // Should still call service with original text (trimming is done during validation)
      expect(mockTranslatorService.translateTextDirect).toHaveBeenCalledWith(
        textWithWhitespace,
        'Spanish',
      );
    });
  });

  describe('translateImageWithAI', () => {
    it('should translate image successfully', async () => {
      const mockImageFile = createMockImageFile('image/jpeg', 5000, 'test.jpg');
      const mockTargetLanguage = 'Vietnamese';
      const mockTranslatedText = 'Translated text from image';

      mockTranslatorService.translateImageDirect.mockResolvedValue(mockTranslatedText);

      const result = await controller.translateImageWithAI(mockImageFile, mockTargetLanguage);

      expect(result).toEqual({
        success: true,
        targetLanguage: mockTargetLanguage,
        translatedText: mockTranslatedText,
      });

      expect(mockTranslatorService.translateImageDirect).toHaveBeenCalledWith(
        mockImageFile,
        mockTargetLanguage,
      );
    });

    it('should use default target language when not provided', async () => {
      const mockImageFile = createMockImageFile('image/png', 3000, 'test.png');
      const mockTranslatedText = 'Default language translation';

      mockTranslatorService.translateImageDirect.mockResolvedValue(mockTranslatedText);

      const result = await controller.translateImageWithAI(mockImageFile);

      expect(result.targetLanguage).toBe('Vietnamese');
      expect(mockTranslatorService.translateImageDirect).toHaveBeenCalledWith(
        mockImageFile,
        'Vietnamese',
      );
    });

    it('should throw error when no file is provided', async () => {
      await expect(
        controller.translateImageWithAI(undefined as any, 'Vietnamese'),
      ).rejects.toThrow(
        new HttpException('Image file is required', HttpStatus.BAD_REQUEST),
      );

      expect(mockTranslatorService.translateImageDirect).not.toHaveBeenCalled();
    });

    it('should handle different image formats', async () => {
      const imageFormats = [
        { mimetype: 'image/jpeg', filename: 'test.jpg' },
        { mimetype: 'image/png', filename: 'test.png' },
        { mimetype: 'image/gif', filename: 'test.gif' },
        { mimetype: 'image/webp', filename: 'test.webp' },
        { mimetype: 'image/bmp', filename: 'test.bmp' },
      ];

      for (const format of imageFormats) {
        const mockImageFile = createMockImageFile(format.mimetype, 4000, format.filename);
        const mockTranslatedText = `Translated from ${format.filename}`;

        mockTranslatorService.translateImageDirect.mockResolvedValue(mockTranslatedText);

        const result = await controller.translateImageWithAI(mockImageFile, 'Spanish');

        expect(result.translatedText).toBe(mockTranslatedText);
        expect(mockTranslatorService.translateImageDirect).toHaveBeenCalledWith(
          mockImageFile,
          'Spanish',
        );
      }
    });

    it('should handle translation service errors', async () => {
      const mockImageFile = createMockImageFile();
      const errorMessage = 'AI vision model unavailable';

      mockTranslatorService.translateImageDirect.mockRejectedValue(
        new Error(errorMessage),
      );

      await expect(
        controller.translateImageWithAI(mockImageFile, 'French'),
      ).rejects.toThrow(
        new HttpException(
          `AI image translation failed: ${errorMessage}`,
          HttpStatus.INTERNAL_SERVER_ERROR,
        ),
      );
    });

    it('should handle large image files', async () => {
      const largeImageFile = createMockImageFile('image/jpeg', 10 * 1024 * 1024, 'large.jpg'); // 10MB
      const mockTranslatedText = 'Translation from large image';

      mockTranslatorService.translateImageDirect.mockResolvedValue(mockTranslatedText);

      const result = await controller.translateImageWithAI(largeImageFile, 'German');

      expect(result.translatedText).toBe(mockTranslatedText);
      expect(mockTranslatorService.translateImageDirect).toHaveBeenCalledWith(
        largeImageFile,
        'German',
      );
    });

    it('should handle different target languages', async () => {
      const mockImageFile = createMockImageFile();
      const languages = ['Spanish', 'French', 'German', 'Japanese', 'Korean'];

      for (const language of languages) {
        const mockTranslatedText = `Translation in ${language}`;
        mockTranslatorService.translateImageDirect.mockResolvedValue(mockTranslatedText);

        const result = await controller.translateImageWithAI(mockImageFile, language);

        expect(result.targetLanguage).toBe(language);
        expect(result.translatedText).toBe(mockTranslatedText);
        expect(mockTranslatorService.translateImageDirect).toHaveBeenCalledWith(
          mockImageFile,
          language,
        );
      }
    });

    it('should handle API timeout errors', async () => {
      const mockImageFile = createMockImageFile();
      const timeoutError = new Error('Request timeout');

      mockTranslatorService.translateImageDirect.mockRejectedValue(timeoutError);

      await expect(
        controller.translateImageWithAI(mockImageFile, 'Vietnamese'),
      ).rejects.toThrow(
        new HttpException(
          'AI image translation failed: Request timeout',
          HttpStatus.INTERNAL_SERVER_ERROR,
        ),
      );
    });

    it('should handle empty translation results gracefully', async () => {
      const mockImageFile = createMockImageFile();
      
      mockTranslatorService.translateImageDirect.mockRejectedValue(
        new Error('Invalid or empty AI response.')
      );

      await expect(
        controller.translateImageWithAI(mockImageFile, 'Vietnamese'),
      ).rejects.toThrow(
        new HttpException(
          'AI image translation failed: Invalid or empty AI response.',
          HttpStatus.INTERNAL_SERVER_ERROR,
        ),
      );
    });
  });

  describe('downloadFile', () => {
    let mockResponse: Partial<Response>;

    beforeEach(() => {
      mockResponse = {
        setHeader: jest.fn(),
        on: jest.fn(),
      } as any;
    });

    it('should throw error for invalid filename with path traversal', () => {
      expect(() =>
        controller.downloadFile('../../../etc/passwd', mockResponse as Response),
      ).toThrow(
        new HttpException('Invalid filename.', HttpStatus.BAD_REQUEST),
      );
    });

    it('should throw error for empty filename', () => {
      expect(() =>
        controller.downloadFile('', mockResponse as Response),
      ).toThrow(
        new HttpException('Invalid filename.', HttpStatus.BAD_REQUEST),
      );
    });

    it('should throw error for non-existent file', () => {
      jest.spyOn(fs, 'statSync').mockImplementation(() => {
        throw new Error('File not found');
      });

      expect(() =>
        controller.downloadFile('nonexistent.pdf', mockResponse as Response),
      ).toThrow(
        new HttpException('File not found.', HttpStatus.NOT_FOUND),
      );
    });

    it('should set correct content type for PDF files', () => {
      const fileName = 'test.pdf';
      jest.spyOn(fs, 'statSync').mockReturnValue({} as any);
      jest.spyOn(fs, 'createReadStream').mockReturnValue({
        pipe: jest.fn(),
      } as any);

      controller.downloadFile(fileName, mockResponse as Response);

      expect(mockResponse.setHeader).toHaveBeenCalledWith(
        'Content-Type',
        'application/pdf',
      );
      expect(mockResponse.setHeader).toHaveBeenCalledWith(
        'Content-Disposition',
        `attachment; filename=${fileName}`,
      );
    });

    it('should set correct content type for DOCX files', () => {
      const fileName = 'test.docx';
      jest.spyOn(fs, 'statSync').mockReturnValue({} as any);
      jest.spyOn(fs, 'createReadStream').mockReturnValue({
        pipe: jest.fn(),
      } as any);

      controller.downloadFile(fileName, mockResponse as Response);

      expect(mockResponse.setHeader).toHaveBeenCalledWith(
        'Content-Type',
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      );
    });

    it('should set correct content type for XLSX files', () => {
      const fileName = 'test.xlsx';
      jest.spyOn(fs, 'statSync').mockReturnValue({} as any);
      jest.spyOn(fs, 'createReadStream').mockReturnValue({
        pipe: jest.fn(),
      } as any);

      controller.downloadFile(fileName, mockResponse as Response);

      expect(mockResponse.setHeader).toHaveBeenCalledWith(
        'Content-Type',
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      );
    });

    it('should set correct content type for CSV files', () => {
      const fileName = 'test.csv';
      jest.spyOn(fs, 'statSync').mockReturnValue({} as any);
      jest.spyOn(fs, 'createReadStream').mockReturnValue({
        pipe: jest.fn(),
      } as any);

      controller.downloadFile(fileName, mockResponse as Response);

      expect(mockResponse.setHeader).toHaveBeenCalledWith(
        'Content-Type',
        'text/csv',
      );
    });

    it('should set correct content type for TXT files', () => {
      const fileName = 'test.txt';
      jest.spyOn(fs, 'statSync').mockReturnValue({} as any);
      jest.spyOn(fs, 'createReadStream').mockReturnValue({
        pipe: jest.fn(),
      } as any);

      controller.downloadFile(fileName, mockResponse as Response);

      expect(mockResponse.setHeader).toHaveBeenCalledWith(
        'Content-Type',
        'text/plain',
      );
    });

    it('should set correct content type for PPTX files', () => {
      const fileName = 'test.pptx';
      jest.spyOn(fs, 'statSync').mockReturnValue({} as any);
      jest.spyOn(fs, 'createReadStream').mockReturnValue({
        pipe: jest.fn(),
      } as any);

      controller.downloadFile(fileName, mockResponse as Response);

      expect(mockResponse.setHeader).toHaveBeenCalledWith(
        'Content-Type',
        'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      );
    });

    it('should throw error for unsupported file types', () => {
      const fileName = 'test.exe';
      jest.spyOn(fs, 'statSync').mockReturnValue({} as any);

      expect(() =>
        controller.downloadFile(fileName, mockResponse as Response),
      ).toThrow(
        new HttpException(
          'Unsupported file type for download.',
          HttpStatus.BAD_REQUEST,
        ),
      );
    });

    it('should pipe file stream to response', () => {
      const fileName = 'test.pdf';
      const mockStream = {
        pipe: jest.fn(),
      };

      jest.spyOn(fs, 'statSync').mockReturnValue({} as any);
      jest.spyOn(fs, 'createReadStream').mockReturnValue(mockStream as any);

      controller.downloadFile(fileName, mockResponse as Response);

      expect(mockStream.pipe).toHaveBeenCalledWith(mockResponse);
    });
  });
});
