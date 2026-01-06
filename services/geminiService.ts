import { GoogleGenAI, Type } from "@google/genai";
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
    
    // Schema definition for bounding boxes
    const responseSchema = {
      type: Type.OBJECT,
      properties: {
        boxes: {
          type: Type.ARRAY,
          items: {
            type: Type.OBJECT,
            properties: {
              ymin: { type: Type.INTEGER, description: "Top coordinate (0-1000)" },
              xmin: { type: Type.INTEGER, description: "Left coordinate (0-1000)" },
              ymax: { type: Type.INTEGER, description: "Bottom coordinate (0-1000)" },
              xmax: { type: Type.INTEGER, description: "Right coordinate (0-1000)" },
              label: { type: Type.STRING, description: "Type of sensitive data (face, email, name)" }
            },
            required: ["ymin", "xmin", "ymax", "xmax"]
          }
        }
      }
    };

    const prompt = `
      Analyze this image (a page from a PDF document).
      Identify all human faces, license plates, visible email addresses, and phone numbers.
      Return a list of bounding boxes for these sensitive areas.
      Coordinates should be normalized to a 0-1000 scale.
    `;

    const response = await ai.models.generateContent({
      model: "gemini-2.5-flash-image",
      contents: {
        parts: [
            { inlineData: { mimeType: "image/jpeg", data: imageBase64 } },
            { text: prompt }
        ]
      },
      config: {
        responseMimeType: "application/json",
        responseSchema: responseSchema,
        thinkingConfig: { thinkingBudget: 0 }
      }
    });

    const jsonText = response.text;
    if (!jsonText) return [];

    const result = JSON.parse(jsonText);
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