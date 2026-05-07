/**
 * PDF Text Extraction Service
 */
import * as pdfjs from 'pdfjs-dist';

// Use a reliable CDN for the worker that matches the installed version
// @ts-ignore
pdfjs.GlobalWorkerOptions.workerSrc = `https://unpkg.com/pdfjs-dist@${pdfjs.version}/build/pdf.worker.min.mjs`;

export interface PDFPage {
  text: string;
  pageNumber: number;
}

export async function extractPagesFromPDF(file: File, onProgress?: (progress: number) => void): Promise<PDFPage[]> {
  const arrayBuffer = await file.arrayBuffer();
  const pdf = await pdfjs.getDocument({ data: arrayBuffer }).promise;
  const pages: PDFPage[] = [];
  const totalPages = pdf.numPages;

  for (let i = 1; i <= totalPages; i++) {
    const page = await pdf.getPage(i);
    const textContent = await page.getTextContent();
    const pageText = textContent.items
      .map((item: any) => item.str)
      .join(' ');
    
    pages.push({
      text: pageText,
      pageNumber: i
    });

    if (onProgress) {
      onProgress(Math.round((i / totalPages) * 100));
    }
  }

  return pages;
}
