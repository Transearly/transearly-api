import { Process, Processor } from "@nestjs/bull";
import { Job } from "bull";
import { PDFLoader } from "@langchain/community/document_loaders/fs/pdf";
import { RecursiveCharacterTextSplitter } from 'langchain/text_splitter';
import { PDFDocument, PDFFont, rgb } from 'pdf-lib';
import { Paragraph, TextRun, Document, Packer } from 'docx';
import { stringify } from 'csv-stringify/sync';
import { parse } from 'csv-parse/sync';
import { fontMap } from "../../configs/fonts.config";
import { EventsGateway } from "../events/events.gateway";
import pLimit from "p-limit"; 
import axios from 'axios';
import * as ExcelJS from 'exceljs';
import * as fontkit from '@pdf-lib/fontkit';
import * as mammoth from 'mammoth';
import * as fs from 'fs/promises';
import * as path from 'path';

@Processor('translation-queue')
export class TranslatorProcessor {
    constructor(
        private readonly eventsGateway: EventsGateway
    ) {}

    @Process({concurrency: 5})
    async handleTranslation(job: Job<{ 
        buffer: { type: 'Buffer', data: number[] }; 
        originalname: string;
        targetLanguage: string;
        socketId: string;
        isUserPremium: boolean;
    }>) {

        try {
            const fileBuffer = Buffer.from(job.data.buffer.data);
            const fileExtension = path.extname(job.data.originalname).toLowerCase();
            const targetLanguage = job.data.targetLanguage || 'Vietnamese';

            let outputBuffer: Buffer;

            if (fileExtension === '.pptx') {
                // Luồng riêng cho PPTX
                const translatedSlides = await this.processPptx(fileBuffer, targetLanguage, job.id);
                console.log(`[Job ${job.id}] Translation completed. Now creating PPTX file...`);
                outputBuffer = await this.createPptx(translatedSlides);
            
            } else if (fileExtension === '.xlsx' || fileExtension === '.xls') {
                // Luồng riêng cho XLSX
                outputBuffer = await this.processAndCreateXlsx(fileBuffer, targetLanguage, job.id);
                console.log(`[Job ${job.id}] Translation and Excel file creation completed.`);

            } else {
                let translatedText: string;
                if (fileExtension === '.pdf') {
                    translatedText = await this.processPdf(fileBuffer, targetLanguage, job.id);
                } else if (fileExtension === '.docx') {
                    translatedText = await this.processDocx(fileBuffer, targetLanguage, job.id);
                } else if (fileExtension === '.csv') {
                    translatedText = await this.processCsv(fileBuffer, targetLanguage, job.id);
                } else if (fileExtension === '.txt') {
                    translatedText = await this.processTxt(fileBuffer, targetLanguage, job.id);
                } else {
                    throw new Error(`Unsupported file type: ${fileExtension}`);
                }

                console.log(`[Job ${job.id}] Translation completed. Now creating output file...`);

                switch (fileExtension) {
                    case '.pdf':
                        outputBuffer = await this.createPdf(translatedText, targetLanguage);
                        break;
                    case '.docx':
                        outputBuffer = await this.createDocx(translatedText);
                        break;
                    case '.csv':
                        outputBuffer = await this.createCsv(translatedText);
                        break;
                    case '.txt':
                        outputBuffer = await this.createTxt(translatedText);
                        break;
                }
            }
            
            if (!outputBuffer) {
                throw new Error(`No output buffer was generated for ${fileExtension}.`);
            }

            // --- PHẦN LƯU FILE VÀ GỬI THÔNG BÁO (GIỮ NGUYÊN) ---
            const outputDir = path.join(process.cwd(), 'translated-files');
            await fs.mkdir(outputDir, { recursive: true });
            const outputFileName = `translated-${job.id}-${Date.now()}${fileExtension}`;
            await fs.writeFile(path.join(outputDir, outputFileName), outputBuffer);
            
            this.eventsGateway.sendJobUpdateToClient(job.data.socketId, 'translationComplete', {
                jobId: job.id,
                status: 'completed',
                fileName: outputFileName,
            });

            return { translatedFileName: outputFileName };

        } catch (error) {
        console.error(`[Job ${job.id}] Failed with error:`, error);
         this.eventsGateway.sendJobUpdateToClient(job.data.socketId, 'translationFailed', {
            jobId: job.id,
            status: 'failed',
            reason: error.message,
        });
        throw error;
        }
    }

    private async translateChunk(
        text: string, 
        index: number, 
        targetLanguage: string,
    ): Promise<string> {
        try {
            const apiUrl = process.env.OPENROUTER_BASE_URL;
            const apiKey = process.env.OPENROUTER_API_KEY;
            const model =  process.env.OPENROUTER_MODEL;
            
            const referer = process.env.OPENROUTER_REFERER || 'http://localhost:5010';
            const appName = process.env.OPENROUTER_APP_NAME || 'Transearly Service';

            if (!apiUrl || !apiKey || !model) {
                throw new Error("API URL, Key, or Model is not configured in .env file.");
            }

            const systemPrompt = [
                'You are a professional translation engine.',
                `Translate the user content to ${targetLanguage}.`, 
                'Preserve semantic meaning, line breaks, markdown, and basic formatting.',
                'Do not add commentary. Output only the translated content.'
            ].join(' ');

            const payload = {
                model: model,
                messages: [
                    {
                        role: 'system',
                        content: systemPrompt
                    },
                    {
                        role: 'user',
                        content: text
                    }
                ],
                temperature: 0 
            };
            
            const headers = {
                'Authorization': `Bearer ${apiKey}`,
                'Content-Type': 'application/json',
                'HTTP-Referer': referer,
                'X-Title': appName
            };

            const response = await axios.post(apiUrl, payload, { headers });

            const translatedContent = response.data?.choices?.[0]?.message?.content;
            if (!translatedContent) {
                throw new Error('Invalid API response structure from proxy.');
            }
            return translatedContent.toString();

        } catch (e) {
            console.error(`Error translating chunk ${index}:`, e.response?.data || e.message);
            return `[Error translating this chunk: ${text.substring(0, 50)}...]`;
        }
    }
  
    private async processPdf(fileBuffer: Buffer, targetLanguage: string, jobId: string | number): Promise<string> {
        const uint8Array = new Uint8Array(fileBuffer);
        const blob = new Blob([uint8Array]);
        const loader = new PDFLoader(blob);
        const docs = await loader.load();
        const fullText = docs.map(d => d.pageContent).join('\n\n');
        
        return this.chunkAndTranslateText(fullText, targetLanguage, jobId);
    }

    private async processDocx(fileBuffer: Buffer, targetLanguage: string, jobId: string | number): Promise<string> {
        const { value } = await mammoth.extractRawText({ buffer: fileBuffer });
        return this.chunkAndTranslateText(value, targetLanguage, jobId);
    }

    private async processAndCreateXlsx(
        fileBuffer: Buffer,
        targetLanguage: string,
        jobId: string | number
        ): Promise<Buffer> {
        const workbook = new ExcelJS.Workbook();
        await workbook.xlsx.load(fileBuffer as any);

        const textsToTranslate: { text: string; cell: ExcelJS.Cell }[] = [];

        // 1️⃣ Thu thập text để dịch
        workbook.eachSheet((ws) => {
            ws.eachRow((row) => {
            row.eachCell((cell) => {
                let text = '';
                const val = cell.value;

                if (val && typeof val === 'object' && 'richText' in val) {
                text = (val as ExcelJS.CellRichTextValue).richText.map(rt => rt.text).join('');
                } else if (typeof val === 'string' || typeof val === 'number') {
                text = val.toString();
                }

                if (text.trim()) textsToTranslate.push({ text, cell });
            });
            });
        });

        console.log(`[Job ${jobId}] Found ${textsToTranslate.length} text cells.`);

        if (!textsToTranslate.length) return fileBuffer;

        // 2️⃣ Dịch duy nhất
        const uniqueTexts = [...new Set(textsToTranslate.map(t => t.text))];
        const limit = pLimit(10);
        const translatedUniqueTexts = await Promise.all(
            uniqueTexts.map((text, i) => limit(() => this.translateChunk(text, i, targetLanguage)))
        );

        const map = new Map<string, string>();
        uniqueTexts.forEach((o, i) => map.set(o, translatedUniqueTexts[i]));

        // 3️⃣ Ghi đè nội dung dịch TRỰC TIẾP lên workbook gốc
        for (const { text, cell } of textsToTranslate) {
            const translated = map.get(text);
            if (!translated) continue;

            const val = cell.value;
            if (val && typeof val === 'object' && 'richText' in val) {
            const originalRich = (val as ExcelJS.CellRichTextValue).richText;
            // Gộp thành 1 đoạn text dịch chung, giữ font đầu tiên
            cell.value = {
                richText: [{
                font: originalRich[0]?.font,
                text: translated,
                }],
            };
            } else {
            cell.value = translated;
            }
        }

        // 4️⃣ Xuất lại file
        const buf = await workbook.xlsx.writeBuffer();
        return Buffer.from(buf);
    }


     private async processCsv(fileBuffer: Buffer, targetLanguage: string, jobId: string | number): Promise<string> {
        const records: any[] = parse(fileBuffer, {
            columns: true,
            skip_empty_lines: true,
        });

        const header = Object.keys(records[0]).join('|||');
        const rows = records.map(record => Object.values(record).join('|||'));
        const fullText = [header, ...rows].join('\n\n');

        return this.chunkAndTranslateText(fullText, targetLanguage, jobId);
    }

    private async processTxt(fileBuffer: Buffer, targetLanguage: string, jobId: string | number): Promise<string> {
        const fullText = fileBuffer.toString('utf-8');
        return this.chunkAndTranslateText(fullText, targetLanguage, jobId);
    }

    private async processPptx(
        fileBuffer: Buffer,
        targetLanguage: string,
        jobId: string | number
    ): Promise<{ slideIndex: number; translatedText: string }[]> {
        const tempFilePath = path.join(process.cwd(), `temp-${jobId}.pptx`);
        await fs.writeFile(tempFilePath, fileBuffer);

        const JSZip = require("jszip");
        const content = await fs.readFile(tempFilePath);
        const pptxZip = await JSZip.loadAsync(content);

        // Lấy danh sách file slide và sắp xếp theo thứ tự
        const slides = Object.keys(pptxZip.files)
            .filter((f) => /^ppt\/slides\/slide[0-9]+\.xml$/.test(f))
            .sort((a, b) => {
            const matchA = a.match(/[0-9]+/);
            const matchB = b.match(/[0-9]+/);
            const numA = matchA ? parseInt(matchA[0], 10) : 0;
            const numB = matchB ? parseInt(matchB[0], 10) : 0;
            return numA - numB;
            });

        const limit = pLimit(5);
        const translatedSlides = await Promise.all(
            slides.map(async (slidePath, index) => {
            const file = pptxZip.files[slidePath];
            if (!file) {
                return { slideIndex: index, translatedText: "" };
            }

            const xml = await file.async("text");

            // ✅ Ép kiểu rõ ràng cho matchAll()
            const matches = Array.from(xml.matchAll(/<a:t>(.*?)<\/a:t>/g)) as RegExpMatchArray[];

            const texts = matches.map((m) => (m[1] ? String(m[1]) : ""));
            const rawText = texts.join(" ").trim();

            if (!rawText) {
                return { slideIndex: index, translatedText: "" };
            }

            const translatedText = await limit(() =>
                this.chunkAndTranslateText(rawText, targetLanguage, `${jobId}-slide-${index}`)
            );

            return { slideIndex: index, translatedText };
            })
        );
        translatedSlides.sort((a, b) => a.slideIndex - b.slideIndex);
        await fs.unlink(tempFilePath).catch(() => {});
        return translatedSlides;
    }



    private async chunkAndTranslateText(text: string, targetLanguage: string, jobId: string | number): Promise<string> {
        const splitter = new RecursiveCharacterTextSplitter({ chunkSize: 4000, chunkOverlap: 200 });
        const chunks = await splitter.splitText(text);

        const limit = pLimit(10);
        const translatedChunks = await Promise.all(
            chunks.map((chunk, index) =>
                limit(() => this.translateChunk(chunk, index, targetLanguage))
            )
        );
        console.log(`[Job ${jobId}] Translated ${translatedChunks.length} chunks.`);
        return translatedChunks.join('\n\n');
    }

    // --- CÁC HÀM TẠO FILE ĐẦU RA ---
    private async createPdf(text: string, targetLanguage: string): Promise<Buffer> {
        const pdfDoc = await PDFDocument.create();
        pdfDoc.registerFontkit(fontkit);

        const fontFileName = fontMap[targetLanguage] || fontMap['default'];
        const fontPath = path.join(__dirname, '..', '..', 'assets/fonts', fontFileName);

        const fontBytes = await fs.readFile(fontPath);
        const customFont = await pdfDoc.embedFont(fontBytes);

        // 3. Thiết lập các thông số layout
        let page = pdfDoc.addPage();
        const { width, height } = page.getSize();
        const fontSize = 11;
        const margin = 50;
        const lineHeight = fontSize * 1.5;
        let y = height - margin;

        const lines = this.wrapText(text, width - margin * 2, customFont, fontSize);

        for (const line of lines) {
            if (y < margin) {
                page = pdfDoc.addPage();
                y = height - margin;
            }

            page.drawText(line, {
                x: margin,
                y,
                font: customFont,
                size: fontSize,
                color: rgb(0, 0, 0),
            });

            y -= lineHeight;
        }

        const pdfBytes = await pdfDoc.save();
        return Buffer.from(pdfBytes);
    }

    private async createDocx(text: string): Promise<Buffer> {
        const paragraphs = text.split('\n\n').map(p => 
            new Paragraph({
                children: [new TextRun(p)],
            })
        );
        
        const doc = new Document({
            sections: [{
                properties: {},
                children: paragraphs,
            }],
        });

        return Packer.toBuffer(doc);
    }

     private async createCsv(translatedText: string): Promise<Buffer> {
        const lines = translatedText.split('\n\n');
        const headerLine = lines.shift();
        
        if (!headerLine) {
            return Buffer.from(''); 
        }

        const headers = headerLine.split('|||').map(h => h.trim());
        const records = lines.map(line => {
            const values = line.split('|||').map(v => v.trim());
            const record = {};
            headers.forEach((header, index) => {
                record[header] = values[index] || '';
            });
            return record;
        });

        const outputCsvString = stringify(records, { header: true, columns: headers });
        return Buffer.from(outputCsvString);
    }

    private async createTxt(translatedText: string): Promise<Buffer> {
        return Buffer.from(translatedText, 'utf-8');
    }

    private wrapText(text: string, maxWidth: number, font: PDFFont, fontSize: number): string[] {
        const words = text.replace(/\n/g, ' \n ').split(' ');
        const lines: string[] = [];
        let currentLine = '';

        for (const word of words) {
            if (word === '\n') {
                lines.push(currentLine);
                currentLine = '';
                continue;
            }

            const lineWithWord = currentLine === '' ? word : `${currentLine} ${word}`;
            const lineWidth = font.widthOfTextAtSize(lineWithWord, fontSize);

            if (lineWidth < maxWidth) {
                currentLine = lineWithWord;
            } else {
                lines.push(currentLine);
                currentLine = word;
            }
        }
        lines.push(currentLine);
        return lines;
    }

    private async createPptx(slideData: { slideIndex: number; translatedText: string }[]): Promise<Buffer> {
        const PptxGenJS = require("pptxgenjs");
        const pres = new PptxGenJS();

        if (slideData.length === 0) {
            pres.addSlide().addText("No content translated.");
        } else {
            slideData.forEach(({ slideIndex, translatedText }) => {
            const slide = pres.addSlide();
            slide.addText(translatedText || "(Empty Slide)", {
                x: 0.5, y: 0.5, w: "90%", h: "90%",
                fontSize: 18, align: "left", valign: "top",
            });
            slide.addText(`Slide ${slideIndex + 1}`, {
                x: 9.0, y: 6.5, fontSize: 12, color: "999999", align: "right",
            });
            });
        }

        const data = await pres.write({ outputType: "arraybuffer" });
        return Buffer.from(data as ArrayBuffer);
    }

}