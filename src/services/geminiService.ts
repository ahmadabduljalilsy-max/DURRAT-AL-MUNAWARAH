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

export async function findDriverInText(query: string, pages: { text: string; pageNumber: number }[]): Promise<DriverData> {
  const prompt = `
    You are the "Excellent Search Agent" for Durrat Al-Munawwarah. 
    Your mission: Find the driver matching the search query: "${query}" in the provided OCR data.

    STRATEGY FOR EXCELLENT SEARCH:
    1. ARABIC NORMALIZATION: Be smart about Arabic variants (e.g., "أ" vs "ا", "ة" vs "ه", "ى" vs "ي"). If the user types "احمد" it should match "أحمد".
    2. FUZZY MATCHING: Treat the search query as fragments. If the query is "محمد علي", look for any record containing both/either intelligently.
    3. ID PRIORITY: If the query is numeric, prioritize searching the "رقم الهوية" column.
    4. DATA EXTRACTION: Extract the full official name, ID number, type (إقامة, حدود, or هوية وطنية), and expiry date if available.
    5. PAGE TRACKING: Accurately identify the page number where this specific driver's record exists.

    DATA SOURCE (JSON Pages):
    ${(() => {
      const json = JSON.stringify(pages);
      console.log("Sending data to Gemini, total JSON size:", json.length, "chars. Truncating to 300k if needed.");
      return json.substring(0, 300000);
    })()}

    RESPONSE REQUIREMENTS:
    - If found, set found: true and fill all fields.
    - If not found, set found: false.
    - Use the exact idType enum values: "رقم إقامة", "رقم حدود", or "هوية وطنية".
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
      console.warn("Empty response from Gemini");
      return { found: false } as DriverData;
    }
    
    const result = JSON.parse(jsonStr);
    console.log("Search Result for query:", query, "=>", result.found ? "FOUND" : "NOT_FOUND");
    return result;
  } catch (error) {
    console.error("Gemini Search Execution Error:", error);
    // If it's a context overflow or similar, maybe returning something else would help, but for now we just fail gracefully
    return { found: false } as DriverData;
  }
}
