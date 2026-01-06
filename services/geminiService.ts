import { GoogleGenAI } from "@google/genai";
import { RedactionRect } from "../types";

const initGenAI = () => {
  // Graceful fallback if API_KEY is missing/empty, allowing app to load without crashing
  const apiKey = process.env.API_KEY;
  if (!apiKey) throw new Error("請先設定 API Key (Please set API Key)");
  return new GoogleGenAI({ apiKey });
};

export const detectSensitiveData = async (
  imageBase64: string,
  pageIndex: number,
  pageWidth: number,
  pageHeight: number
): Promise<RedactionRect[]> => {
  try {
    const ai = initGenAI();
    
    // NOTE: gemini-2.5-flash-image does not support responseSchema or responseMimeType
    // We must ask for JSON in the prompt and parse the text manually.
    const prompt = `
      Analyze this image (a page from a PDF document).
      Identify all human faces, license plates, visible email addresses, and phone numbers.
      
      Return ONLY a raw JSON object (no markdown, no backticks) with the following structure:
      {
        "boxes": [
          {
            "ymin": 0, "xmin": 0, "ymax": 1000, "xmax": 1000,
            "label": "face"
          }
        ]
      }
      
      Coordinates must be normalized to a 0-1000 scale.
      ymin is the top edge, ymax is the bottom edge.
      If no sensitive data is found, return { "boxes": [] }.
    `;

    const response = await ai.models.generateContent({
      model: "gemini-2.5-flash-image",
      contents: {
        parts: [
            { inlineData: { mimeType: "image/jpeg", data: imageBase64 } },
            { text: prompt }
        ]
      },
      // Do not set responseSchema or responseMimeType for this model
    });

    let jsonText = response.text || "";
    
    // Clean up potential markdown formatting from the response
    jsonText = jsonText.replace(/```json/g, '').replace(/```/g, '').trim();

    if (!jsonText) return [];

    let result;
    try {
        result = JSON.parse(jsonText);
    } catch (e) {
        console.warn("Failed to parse JSON from AI response:", jsonText);
        return [];
    }
    
    const boxes = result.boxes || [];

    return boxes.map((box: any) => {
        // Convert normalized 0-1000 coordinates (Top-Left origin) to PDF Points (Bottom-Left origin)
        
        // 1. Calculate dimensions in Points
        const w = ((box.xmax - box.xmin) / 1000) * pageWidth;
        const h = ((box.ymax - box.ymin) / 1000) * pageHeight;
        
        // 2. Calculate X (Left is same in both systems)
        const x = (box.xmin / 1000) * pageWidth;
        
        // 3. Calculate Y (Convert Top-Down 'ymax' to Bottom-Up 'y')
        // box.ymax is the visual bottom edge (larger value in Top-Down).
        // Distance from bottom of page = pageHeight - ymax_pixels
        const y = pageHeight - ((box.ymax / 1000) * pageHeight);

        return {
            id: Math.random().toString(36).substr(2, 9),
            pageIndex,
            x,
            y,
            width: w,
            height: h
        };
    });

  } catch (error) {
    console.error("Gemini Detection Error:", error);
    if (error instanceof Error) {
        throw new Error(error.message); // Propagate error message to UI
    }
    return [];
  }
};