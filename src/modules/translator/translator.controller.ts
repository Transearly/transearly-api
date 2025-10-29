import { 
  Controller, 
  Get, 
  Post, 
  Body, 
  Param, 
  UseInterceptors, 
  UploadedFile, 
  Res, 
  HttpException, 
  HttpStatus, 
  PayloadTooLargeException, 
  BadRequestException,
  Query,
  ParseBoolPipe
} from '@nestjs/common';
import { TranslatorService } from './translator.service';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBody, ApiConsumes, ApiOperation } from '@nestjs/swagger';
import { createReadStream, statSync, unlinkSync } from 'fs';
import e, { Response } from 'express';
import * as path from 'path';
import { ConfigService } from '@nestjs/config';
import { EventsGateway } from '../events/events.gateway';

@Controller('translator')
export class TranslatorController {
  constructor(
    private readonly translationService: TranslatorService,
    private readonly configService: ConfigService,
    private readonly eventsGateway: EventsGateway
  ) {}

  @Post('upload')
  @ApiConsumes('multipart/form-data')
  @ApiOperation({ summary: 'Upload a document for translation' })
  @ApiBody({
    schema: {
      type: 'object',
      properties: { 
        file: { type: 'string', format: 'binary' },
        targetLanguage: { type: 'string', example: 'Vietnamese' },
        isUserPremium: { type: 'boolean', example: 'false'},
        socketId: { type: 'string', example: 'unique_socket_id_12345' }
      },
    },
  })
  @UseInterceptors(FileInterceptor('file'))
  async uploadPdf(
    @UploadedFile() file: Express.Multer.File, 
    @Body('targetLanguage') targetLanguage: string = 'Vietnamese',
    @Body('isUserPremium', ParseBoolPipe) isUserPremium: boolean = false,
    @Body('socketId') socketId: string,
  ) {
    if (!socketId) throw new HttpException('Socket ID is required.', HttpStatus.BAD_REQUEST);
    const isLimitEnabled = this.configService.get<string>('UPLOAD_LIMIT_ENABLED') === 'true';
    const limitKb = this.configService.get<number>('UPLOAD_LIMIT_KB') ?? 10;
    const limitBytes =  limitKb * 1024;

    const allowedMimeTypes = [
      'application/pdf',  
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 
      'text/plain',   
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    ];

  if (!allowedMimeTypes.includes(file.mimetype)) {
    this.eventsGateway.sendJobUpdateToClient(socketId, 'translationFailed', {
        jobId: null, 
        status: 'failed',
        reason: `File is too large. Limit: ${limitKb}KB.`,
      });
      
    throw new BadRequestException(
      `Unsupported file type. Only PDF, DOCX, TXT, XLSX, PPTX are allowed.`
    );
  }

    if (isLimitEnabled && !isUserPremium && file.size > limitBytes) {
      this.eventsGateway.sendJobUpdateToClient(socketId, 'translationFailed', {
        jobId: null, 
        status: 'failed',
        reason: `File is too large. Limit: ${limitKb}KB.`,
      });
      
      throw new PayloadTooLargeException(
        `File upload failed. Free users are limited to ${limitKb}KB.`
      );
    }

    const job = await this.translationService.startTranslationJob(file, targetLanguage, socketId, isUserPremium);
    return {
      message: 'File received. Translation started.',
      jobId: job.id,
      targetLanguage: targetLanguage
    };
  }

  @Get('status/:jobId')
  async getJobStatus(@Param('jobId') jobId: string) {
    return this.translationService.getJobStatus(jobId);
  }


  // Download translated file
  @Get('download/:fileName')
  downloadFile(@Param('fileName') fileName: string, @Res() res: Response) {
      if (!fileName || fileName.includes('..')) {
        throw new HttpException(
          'Invalid filename.', 
          HttpStatus.BAD_REQUEST
        );
      }
      const filePath = path.join(process.cwd(), 'translated-files', fileName);

      try {
        statSync(filePath);
      } catch (error) {
        throw new HttpException(
          'File not found.', 
          HttpStatus.NOT_FOUND
        );
      }

      const fileExtension = path.extname(fileName).toLowerCase();
      let contentType = '';

      if (fileExtension === '.pdf') {
        contentType = 'application/pdf';
      } else if (fileExtension === '.docx') {
        contentType = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
      } else if (fileExtension === '.xlsx') { 
        contentType = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
      } else if (fileExtension === '.csv') {
        contentType = 'text/csv';
      } else if (fileExtension === '.txt') {
        contentType = 'text/plain';
      } else if (fileExtension === '.pptx') {
        contentType = 'application/vnd.openxmlformats-officedocument.presentationml.presentation';
      } else {
        throw new HttpException('Unsupported file type for download.', HttpStatus.BAD_REQUEST);
      }

      const fileStream = createReadStream(filePath);

      res.setHeader('Content-Type', contentType);
      res.setHeader('Content-Disposition', `attachment; filename=${fileName}`);
      
      fileStream.pipe(res);
      res.on('close', () => {
      try {
          unlinkSync(filePath);
      } catch (err) {
          console.error(`Error deleting file ${fileName}:`, err);
        }
    });
  }

  // Translate text directly
  @Post('text')
  @ApiOperation({ summary: 'Translate text directly' })
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        text: { type: 'string', example: 'Hello, how are you?' },
        targetLanguage: { type: 'string', example: 'Vietnamese' },
      },
      required: ['text'],
    },
  })
  async translateText(
    @Body('text') text: string,
    @Body('targetLanguage') targetLanguage = 'Vietnamese',
  ) {
    if (!text || !text.trim()) {
      throw new HttpException('Text is required.', HttpStatus.BAD_REQUEST);
    }

    try {
      const translated = await this.translationService.translateTextDirect(
        text,
        targetLanguage,
      );
      return {
        success: true,
        targetLanguage,
        translatedText: translated,
      };
    } catch (error) {
      throw new HttpException(
        `Translation failed: ${error.message}`,
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Post('image')
  @UseInterceptors(FileInterceptor('file'))
  @ApiOperation({ summary: 'Translate text in an image directly with bounding boxes' })
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        file: { type: 'string', format: 'binary' },
        targetLanguage: { type: 'string', example: 'Vietnamese' },
      },
    },
  })
  async translateImageWithAI(
    @UploadedFile() file: Express.Multer.File,
    @Body('targetLanguage') targetLanguage = 'Vietnamese',
  ) {
    if (!file) {
      throw new HttpException('Image file is required', HttpStatus.BAD_REQUEST);
    }

    try {
      const result = await this.translationService.translateImageDirect(
        file,
        targetLanguage,
      );
      return {
        success: true,
        targetLanguage,
        segments: result.segments,
      };
    } catch (error) {
      throw new HttpException(
        `AI image translation failed: ${error.message}`,
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }
}

