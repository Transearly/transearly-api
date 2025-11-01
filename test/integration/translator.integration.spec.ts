import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import * as request from 'supertest';
import * as fs from 'fs';
import * as path from 'path';
import { TranslatorController } from '../../src/modules/translator/translator.controller';
import { TranslatorService } from '../../src/modules/translator/translator.service';
import { ConfigService } from '@nestjs/config';
import { EventsGateway } from '../../src/modules/events/events.gateway';

describe('TranslatorController (integration)', () => {
	let app: INestApplication;

	const mockService = {
		translateTextDirect: jest.fn(),
		translateImageDirect: jest.fn(),
		startTranslationJob: jest.fn(),
		getJobStatus: jest.fn(),
	} as unknown as jest.Mocked<TranslatorService>;

	const mockEvents = {
		sendJobUpdateToClient: jest.fn(),
	} as unknown as jest.Mocked<EventsGateway>;

	const mockConfig: Record<string, any> = {
		UPLOAD_LIMIT_ENABLED: 'false',
		UPLOAD_LIMIT_KB: 10,
	};

	const mockConfigService = {
		get: jest.fn((key: string) => mockConfig[key]),
	} as unknown as jest.Mocked<ConfigService>;

	beforeAll(async () => {
		const module: TestingModule = await Test.createTestingModule({
			controllers: [TranslatorController],
			providers: [
				{ provide: TranslatorService, useValue: mockService },
				{ provide: ConfigService, useValue: mockConfigService },
				{ provide: EventsGateway, useValue: mockEvents },
			],
		}).compile();

		app = module.createNestApplication();
		await app.init();
	});

	afterEach(() => {
		jest.clearAllMocks();
		mockConfig.UPLOAD_LIMIT_ENABLED = 'false';
		mockConfig.UPLOAD_LIMIT_KB = 10;
	});

	afterAll(async () => {
		await app.close();
	});

	describe('POST /translator/text', () => {
		it('translates text successfully', async () => {
			mockService.translateTextDirect = jest.fn().mockResolvedValue('Xin chào');

			await request(app.getHttpServer())
				.post('/translator/text')
				.send({ text: 'Hello', targetLanguage: 'Vietnamese' })
				.expect(201)
				.expect(({ body }) => {
					expect(body).toEqual({
						success: true,
						targetLanguage: 'Vietnamese',
						translatedText: 'Xin chào',
					});
					expect(mockService.translateTextDirect).toHaveBeenCalledWith('Hello', 'Vietnamese');
				});
		});

		it('returns 400 when text is missing', async () => {
			await request(app.getHttpServer())
				.post('/translator/text')
				.send({ text: '', targetLanguage: 'Vietnamese' })
				.expect(400);
		});

		it('returns 500 when service throws', async () => {
			mockService.translateTextDirect = jest.fn().mockRejectedValue(new Error('API down'));

			await request(app.getHttpServer())
				.post('/translator/text')
				.send({ text: 'Hello', targetLanguage: 'Vietnamese' })
				.expect(500)
				.expect(({ body }) => {
					expect(body.message).toContain('Translation failed: API down');
				});
		});
	});

	describe('POST /translator/upload', () => {
		const server = () => app.getHttpServer();

		const makeFile = (name: string, mimetype: string, size = 1024) => {
			const buffer = Buffer.alloc(size, 0x61);
			return { buffer, name, type: mimetype };
		};

		it('accepts PDF upload and enqueues job', async () => {
			const file = makeFile('sample.pdf', 'application/pdf');
			mockService.startTranslationJob = jest.fn().mockResolvedValue({ id: 'job-1' });

			await request(server())
				.post('/translator/upload')
				.field('targetLanguage', 'Vietnamese')
				.field('isUserPremium', 'false')
				.field('socketId', 'sock-1')
				.attach('file', file.buffer, { filename: file.name, contentType: file.type })
				.expect(201)
				.expect(({ body }) => {
					expect(body).toEqual({
						message: 'File received. Translation started.',
						jobId: 'job-1',
						targetLanguage: 'Vietnamese',
					});
					expect(mockService.startTranslationJob).toHaveBeenCalled();
				});
		});

		it('accepts DOCX upload and enqueues job', async () => {
			const file = makeFile(
				'sample.docx',
				'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
			);
			mockService.startTranslationJob = jest.fn().mockResolvedValue({ id: 'job-2' });

			await request(server())
				.post('/translator/upload')
				.field('targetLanguage', 'Vietnamese')
				.field('isUserPremium', 'true')
				.field('socketId', 'sock-2')
				.attach('file', file.buffer, { filename: file.name, contentType: file.type })
				.expect(201)
				.expect(({ body }) => {
					expect(body.jobId).toBe('job-2');
				});
		});

		it('rejects unsupported mime type with 400 and emits event', async () => {
			const file = makeFile('bad.xyz', 'application/octet-stream');

			await request(server())
				.post('/translator/upload')
				.field('targetLanguage', 'Vietnamese')
				.field('isUserPremium', 'false')
				.field('socketId', 'sock-3')
				.attach('file', file.buffer, { filename: file.name, contentType: file.type })
				.expect(400);

			expect(mockEvents.sendJobUpdateToClient).toHaveBeenCalledWith('sock-3', 'translationFailed', expect.any(Object));
		});

		it('enforces size limit for non-premium users', async () => {
			mockConfig.UPLOAD_LIMIT_ENABLED = 'true';
			mockConfig.UPLOAD_LIMIT_KB = 1; // 1 KB

			const bigFile = makeFile('big.pdf', 'application/pdf', 2048);

			await request(server())
				.post('/translator/upload')
				.field('targetLanguage', 'Vietnamese')
				.field('isUserPremium', 'false')
				.field('socketId', 'sock-4')
				.attach('file', bigFile.buffer, { filename: bigFile.name, contentType: bigFile.type })
				.expect(413);

			expect(mockEvents.sendJobUpdateToClient).toHaveBeenCalledWith('sock-4', 'translationFailed', expect.any(Object));
		});

		it('requires socketId', async () => {
			const file = makeFile('sample.pdf', 'application/pdf');

			await request(server())
				.post('/translator/upload')
				.field('targetLanguage', 'Vietnamese')
				.field('isUserPremium', 'false')
				// missing socketId
				.attach('file', file.buffer, { filename: file.name, contentType: file.type })
				.expect(400);
		});

			it('full flow (mocked): upload -> status(completed) -> download', async () => {
				const file = makeFile('flow.pdf', 'application/pdf');
				const jobId = 'job-flow-1';
				const outputName = 'flow-output.pdf';
				const dir = path.join(process.cwd(), 'translated-files');
				const outPath = path.join(dir, outputName);

				// Upload returns a job id
				mockService.startTranslationJob = jest.fn().mockResolvedValue({ id: jobId });

				await request(server())
					.post('/translator/upload')
					.field('targetLanguage', 'Vietnamese')
					.field('isUserPremium', 'false')
					.field('socketId', 'sock-flow')
					.attach('file', file.buffer, { filename: file.name, contentType: file.type })
					.expect(201)
					.expect(({ body }) => {
						expect(body.jobId).toBe(jobId);
					});

				// Status returns completed
				mockService.getJobStatus = jest.fn().mockResolvedValue({
					status: 'completed',
					result: { fileName: outputName },
				});

				await request(server())
					.get(`/translator/status/${jobId}`)
					.expect(200)
					.expect(({ body }) => {
						expect(body.status).toBe('completed');
					});

				// Simulate processor output file so download can succeed
				fs.mkdirSync(dir, { recursive: true });
				fs.writeFileSync(outPath, Buffer.from('%PDF-mock'));

				await request(server())
					.get(`/translator/download/${outputName}`)
					.expect(200)
					.expect('Content-Type', /application\/pdf/)
					.expect('Content-Disposition', `attachment; filename=${outputName}`);

				await new Promise((r) => setTimeout(r, 10));
				expect(fs.existsSync(outPath)).toBe(false);
			});

					it('full flow (mocked): DOCX upload -> status(completed) -> download', async () => {
						const file = makeFile(
							'flow.docx',
							'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
						);
						const jobId = 'job-flow-docx-1';
						const outputName = 'flow-output.docx';
						const dir = path.join(process.cwd(), 'translated-files');
						const outPath = path.join(dir, outputName);

						mockService.startTranslationJob = jest.fn().mockResolvedValue({ id: jobId });

						await request(server())
							.post('/translator/upload')
							.field('targetLanguage', 'Vietnamese')
							.field('isUserPremium', 'true')
							.field('socketId', 'sock-flow-docx')
							.attach('file', file.buffer, { filename: file.name, contentType: file.type })
							.expect(201)
							.expect(({ body }) => {
								expect(body.jobId).toBe(jobId);
							});

						mockService.getJobStatus = jest.fn().mockResolvedValue({
							status: 'completed',
							result: { fileName: outputName },
						});

						await request(server())
							.get(`/translator/status/${jobId}`)
							.expect(200)
							.expect(({ body }) => {
								expect(body.status).toBe('completed');
							});

						fs.mkdirSync(dir, { recursive: true });
						fs.writeFileSync(outPath, Buffer.from('PK\u0003\u0004')); // DOCX is a zip; just a stub

						await request(server())
							.get(`/translator/download/${outputName}`)
							.expect(200)
							.expect('Content-Type', /application\/vnd\.openxmlformats-officedocument\.wordprocessingml\.document/)
							.expect('Content-Disposition', `attachment; filename=${outputName}`);

						await new Promise((r) => setTimeout(r, 10));
						expect(fs.existsSync(outPath)).toBe(false);
					});
	});

	describe('POST /translator/image', () => {
		it('translates image and returns segments', async () => {
			const buffer = Buffer.from('image-bytes');
			mockService.translateImageDirect = jest.fn().mockResolvedValue({
				segments: [
					{ position: { x: 1, y: 2, width: 3, height: 4 }, original: 'Hi', translated: 'Xin chào' },
				],
			});

			await request(app.getHttpServer())
				.post('/translator/image')
				.field('targetLanguage', 'Vietnamese')
				.attach('file', buffer, { filename: 'img.png', contentType: 'image/png' })
				.expect(201)
				.expect(({ body }) => {
					expect(body.success).toBe(true);
					expect(body.segments).toHaveLength(1);
					expect(mockService.translateImageDirect).toHaveBeenCalled();
				});
		});

		it('returns 400 when image file is missing', async () => {
			await request(app.getHttpServer())
				.post('/translator/image')
				.field('targetLanguage', 'Vietnamese')
				.expect(400);
		});

			it('full flow (mocked): image -> translated segments returned', async () => {
				const buffer = Buffer.from('image-bytes');
				const segments = [
					{ position: { x: 5, y: 5, width: 10, height: 5 }, original: 'Title', translated: 'Tiêu đề' },
					{ position: { x: 10, y: 20, width: 30, height: 10 }, original: 'Hello', translated: 'Xin chào' },
				];
				mockService.translateImageDirect = jest.fn().mockResolvedValue({ segments });

				await request(app.getHttpServer())
					.post('/translator/image')
					.field('targetLanguage', 'Vietnamese')
					.attach('file', buffer, { filename: 'img.png', contentType: 'image/png' })
					.expect(201)
					.expect(({ body }) => {
						expect(body.success).toBe(true);
						expect(body.segments).toHaveLength(2);
						expect(body.segments[1].translated).toBe('Xin chào');
					});
			});
	});

	describe('GET /translator/status/:jobId', () => {
		it('returns completed status', async () => {
			mockService.getJobStatus = jest.fn().mockResolvedValue({ status: 'completed', result: { file: 'out.pdf' } });

			await request(app.getHttpServer())
				.get('/translator/status/job-123')
				.expect(200)
				.expect(({ body }) => {
					expect(body.status).toBe('completed');
				});
		});

		it('returns not_found status', async () => {
			mockService.getJobStatus = jest.fn().mockResolvedValue({ status: 'not_found' });

			await request(app.getHttpServer())
				.get('/translator/status/missing')
				.expect(200)
				.expect(({ body }) => expect(body.status).toBe('not_found'));
		});
	});

	describe('GET /translator/download/:fileName', () => {
		const dir = path.join(process.cwd(), 'translated-files');
		const writeFile = (name: string, content: Buffer) => {
			fs.mkdirSync(dir, { recursive: true });
			fs.writeFileSync(path.join(dir, name), content);
		};

		it('downloads PDF and deletes after response', async () => {
			const name = 'out.pdf';
			const content = Buffer.from('%PDF-1.4');
			const fullPath = path.join(dir, name);
			writeFile(name, content);

			await request(app.getHttpServer())
				.get(`/translator/download/${name}`)
				.expect(200)
				.expect('Content-Type', /application\/pdf/)
				.expect('Content-Disposition', `attachment; filename=${name}`)
				.expect((res) => {
					// file should have been streamed; after response, controller attempts deletion
				});

			// wait a tick to allow close handler
			await new Promise((r) => setTimeout(r, 10));
			expect(fs.existsSync(fullPath)).toBe(false);
		});

		it('rejects unsupported extension', async () => {
			const name = 'weird.xyz';
			const fullPath = path.join(dir, name);
			writeFile(name, Buffer.from('data'));

			await request(app.getHttpServer())
				.get(`/translator/download/${name}`)
				.expect(400);

			// cleanup
			if (fs.existsSync(fullPath)) fs.unlinkSync(fullPath);
		});

		it('returns 404 for missing file', async () => {
			await request(app.getHttpServer())
				.get('/translator/download/missing.pdf')
				.expect(404);
		});

		it('guards against path traversal', async () => {
			await request(app.getHttpServer())
				.get('/translator/download/../secret.pdf')
				.expect(404);
		});
	});

		describe('POST /translator/audio', () => {
			const makeAudio = (name: string, mimetype: string, size = 2048) => {
				const buffer = Buffer.alloc(size, 0x62);
				return { buffer, name, type: mimetype };
			};

			it('transcribes and translates audio successfully', async () => {
				const audio = makeAudio('voice.mp3', 'audio/mpeg');
				const mockResult = {
					success: true,
					originalText: 'Hello world',
					translatedText: 'Xin chào thế giới',
					audioDetails: { duration: 12, detectedLanguage: 'en-US', primaryLanguage: 'en-US' },
				};
				mockService.translateAudioDirect = jest.fn().mockResolvedValue(mockResult);

				await request(app.getHttpServer())
					.post('/translator/audio')
					.field('sourceLanguage', 'en')
					.field('targetLanguage', 'Vietnamese')
					.attach('file', audio.buffer, { filename: audio.name, contentType: audio.type })
					.expect(201)
					.expect(({ body }) => {
						expect(body).toEqual(mockResult);
						expect(mockService.translateAudioDirect).toHaveBeenCalled();
					});
			});

			it('returns 400 when audio file is missing', async () => {
				await request(app.getHttpServer())
					.post('/translator/audio')
					.field('sourceLanguage', 'auto')
					.field('targetLanguage', 'Vietnamese')
					.expect(400);
			});

			it('rejects unsupported audio mime types', async () => {
				const audio = makeAudio('voice.bin', 'application/octet-stream');

				await request(app.getHttpServer())
					.post('/translator/audio')
					.field('sourceLanguage', 'auto')
					.field('targetLanguage', 'Vietnamese')
					.attach('file', audio.buffer, { filename: audio.name, contentType: audio.type })
					.expect(400);
			});

			it('returns 500 when service throws', async () => {
				const audio = makeAudio('voice.wav', 'audio/wav');
				mockService.translateAudioDirect = jest.fn().mockRejectedValue(new Error('Speech API down'));

				await request(app.getHttpServer())
					.post('/translator/audio')
					.field('sourceLanguage', 'auto')
					.field('targetLanguage', 'Vietnamese')
					.attach('file', audio.buffer, { filename: audio.name, contentType: audio.type })
					.expect(500)
					.expect(({ body }) => {
						expect(body.message).toContain('Audio translation failed: Speech API down');
					});
			});

						it('full flow (mocked): audio -> transcription + translation JSON', async () => {
						const audio = makeAudio('voice.ogg', 'audio/ogg');
						const mockResult = {
							success: true,
							originalText: 'Good morning',
							translatedText: 'Chào buổi sáng',
							audioDetails: { duration: 8, detectedLanguage: 'en-US', primaryLanguage: 'en-US' },
						};
						mockService.translateAudioDirect = jest.fn().mockResolvedValue(mockResult);

						await request(app.getHttpServer())
							.post('/translator/audio')
							.field('sourceLanguage', 'en')
							.field('targetLanguage', 'Vietnamese')
							.attach('file', audio.buffer, { filename: audio.name, contentType: audio.type })
							.expect(201)
							.expect(({ body }) => {
								expect(body).toEqual(mockResult);
									expect(mockService.translateAudioDirect).toHaveBeenCalledWith(
										expect.objectContaining({
											originalname: 'voice.ogg',
											mimetype: 'audio/ogg',
											buffer: expect.any(Buffer),
										}),
										'en',
										'Vietnamese',
									);
							});
					});
		});
});
