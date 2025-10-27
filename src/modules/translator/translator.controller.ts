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
import { ApiBody, ApiConsumes } from '@nestjs/swagger';
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
}
