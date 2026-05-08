import { GoogleGenAI, Type } from "@google/genai";

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY || "" });

export interface DriverData {
  fullName: string;
  idNumber: string;
  idType: "رقم إقامة" | "رقم حدود" | "هوية وطنية";
  expiryDate: string;
  found: boolean;
  pageNumber?: number;
}

/**
 * Normalizes Arabic text for more flexible matching
 */
function normalizeArabic(text: string): string {
  if (!text) return "";
  
  // Convert Eastern Arabic digits to standard
  const easternDigits = ["٠", "١", "٢", "٣", "٤", "٥", "٦", "٧", "٨", "٩"];
  let normalized = text;
  for (let i = 0; i < 10; i++) {
    normalized = normalized.replace(new RegExp(easternDigits[i], "g"), i.toString());
  }

  return normalized
    .replace(/[\u064B-\u0652]/g, "") // Strip Tashkeel
    .replace(/[أإآ]/g, "ا")
    .replace(/ة/g, "ه")
    .replace(/ى/g, "ي")
    .trim()
    .toLowerCase();
}

export async function findDriverInText(query: string, pages: { text: string; pageNumber: number }[]): Promise<DriverData> {
  const normalizedQuery = normalizeArabic(query);
  const queryParts = normalizedQuery.split(/\s+/).filter(part => part.length >= 2); 
  
  // STEP 1: KEYWORD FILTERING (PRE-SEARCH)
  // This turns a potential "blind" search into a targeted one.
  console.log(`Analyzing ${pages.length} pages for keywords related to: "${query}"`);
  
  const scoredPages = pages.map(page => {
    const normalizedPageText = normalizeArabic(page.text);
    let score = 0;
    
    // Direct match for numerical IDs is extremely high priority
    if (/^\d+$/.test(query) && normalizedPageText.includes(query)) {
      score += 200;
    }
    
    // Check for each part of the query (names, partial IDs)
    queryParts.forEach(part => {
      if (normalizedPageText.includes(part)) {
        score += part.length * 5; // Long parts give more score
      }
    });

    return { ...page, score };
  }).filter(page => page.score > 0);

  // If no direct matches, maybe it's OCR errors, so let's try a fallback
  let finalCandidatePages: { text: string; pageNumber: number; score?: number }[] = scoredPages;
  if (scoredPages.length === 0) {
    console.warn("No direct keyword matches. Broadening search to first 20 pages as fallback.");
    finalCandidatePages = pages.slice(0, 20);
  } else {
    // Sort by relevance and take top 15 pages
    finalCandidatePages = [...scoredPages]
      .sort((a, b) => b.score - a.score)
      .slice(0, 15);
  }

  const prompt = `
    You are the "ULTRA-ADVANCED AI Search Engine" optimized for Arabic tabular PDF records.
    TARGET QUERY: "${query}"

    SEARCH STRATEGY & RULES:
    1. ARABIC SEMANTIC MATCHING: Normalize all Arabic text. Ali/أحمد matches احمد/علي. Look for name components.
    2. KEYWORD & PARTIALS: If the query is numeric (ID), look for it precisely, but also account for missing digits or OCR digit mapping (e.g., ٧ to 7).
    3. TABULAR SCANNING: The data is in a row-based format. Identify rows where either the Name or the ID matches the query.
    4. CONFIDENCE: Only return found:true if you can clearly identify a record matching ${query}. 
    5. DATA COMPLETENESS: If a record is found, you MUST attempt to fill all fields from the surrounding row data.

    SEARCH CONTEXT (RELEVANT DATA HIGHLIGHTS):
    ${JSON.stringify(finalCandidatePages)}

    RESPONSE FORMAT (JSON ONLY):
    {
      "fullName": "Name from record",
      "idNumber": "10-digit ID",
      "idType": "رقم إقامة | رقم حدود | هوية وطنية",
      "expiryDate": "Date from record (Format: YYYY/MM/DD)",
      "pageNumber": [Exact page number where found],
      "found": true/false
    }
  `;

  try {
    const response = await ai.models.generateContent({
      model: "gemini-3-flash-preview", 
      contents: prompt,
      config: {
        responseMimeType: "application/json",
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            fullName: { type: Type.STRING },
            idNumber: { type: Type.STRING },
            idType: { type: Type.STRING, enum: ["رقم إقامة", "رقم حدود", "هوية وطنية"] },
            expiryDate: { type: Type.STRING },
            pageNumber: { type: Type.NUMBER },
            found: { type: Type.BOOLEAN }
          },
          required: ["found"]
        }
      }
    });

    const jsonStr = response.text?.trim();
    if (!jsonStr) {
      return { found: false } as DriverData;
    }
    
    const result = JSON.parse(jsonStr);
    console.log("Ultra-Search Feedback:", result.found ? `FOUND: ${result.fullName}` : "NOT FOUND");
    return result;
  } catch (error) {
    console.error("Advanced Search Engine Critical Failure:", error);
    return { found: false } as DriverData;
  }
}
