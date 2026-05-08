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
 * Strips diacritics and normalizes Alifs, Yaas, and Hehs
 */
function normalizeArabic(text: string): string {
  if (!text) return "";
  return text
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
    You are the "ULTRA-ADVANCED AI Search Engine" for finding driver records.
    TARGET QUERY: "${query}"

    SEARCH STRATEGY:
    1. SMARTER ARABIC MATCHING: Use semantic matching for Arabic names. Ignore Alif variation (أ/ا/إ), Taa Marbouta (ة/ه), and Yaa (ي/ى).
    2. KEYWORD SPOTTING: Look closely for characters that match parts of "${query}".
    3. COLUMN DETECTION: This is a tabular list. The ID is usually 10 digits. The name is usually multiple Arabic words.
    4. PARTIAL MATCHING: If the query is "Ali", match "Ali Ahmed" or "Mohamed Ali".
    5. DATA EXTRACTION: If you find a matching row, extract ALL columns.

    DATA SOURCE (RELEVANT PAGES ONLY):
    ${JSON.stringify(finalCandidatePages)}

    RESPONSE REQUIREMENTS:
    - found: true ONLY if you are highly confident, false otherwise.
    - idType: "رقم إقامة", "رقم حدود", or "هوية وطنية".
    - pageNumber: Use the exact pageNumber from the source object.
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
