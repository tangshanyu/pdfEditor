import { GoogleGenAI } from "@google/genai";
import { RedactionRect } from "../types";

export const detectSensitiveData = async (
  imageBase64: string,
  pageIndex: number,
  pageWidth: number,
  pageHeight: number
): Promise<RedactionRect[]> => {
  const apiKey = process.env.API_KEY;
  if (!apiKey) throw new Error("API Key 未設定");

  const ai = new GoogleGenAI({ apiKey });

  const prompt = `
    Analyze this image of a document page.
    Detect all: Human Faces, Phone Numbers, Email Addresses, ID numbers.
    
    Return a raw JSON object with this structure:
    {
      "boxes": [
        { "ymin": 0, "xmin": 0, "ymax": 1000, "xmax": 1000, "label": "face" }
      ]
    }
    
    Rules:
    1. Coordinates must be normalized (0-1000).
    2. ymin is top edge, ymax is bottom edge (visual top-down).
    3. Return only JSON, no markdown formatting.
    4. If nothing found, return {"boxes": []}.
  `;

  try {
    const response = await ai.models.generateContent({
      model: "gemini-2.5-flash-image",
      contents: {
        parts: [
          { inlineData: { mimeType: "image/jpeg", data: imageBase64 } },
          { text: prompt }
        ]
      }
    });

    const text = response.text || "{}";
    const cleanText = text.replace(/```json|```/g, '').trim();
    
    const data = JSON.parse(cleanText);
    const boxes = data.boxes || [];

    return boxes.map((box: any) => {
      // Normalize 1000 -> PDF Points
      const x = (box.xmin / 1000) * pageWidth;
      const w = ((box.xmax - box.xmin) / 1000) * pageWidth;
      const h = ((box.ymax - box.ymin) / 1000) * pageHeight;
      
      // Convert Top-Down (AI) to Bottom-Up (PDF)
      // AI ymax is the visual bottom. 
      // PDF y (bottom-left corner) = pageHeight - AI_ymax_pixels
      const y = pageHeight - ((box.ymax / 1000) * pageHeight);

      return {
        id: Math.random().toString(36).slice(2),
        pageIndex,
        x,
        y,
        width: w,
        height: h
      };
    });
  } catch (error) {
    console.error("AI Detection failed:", error);
    throw new Error("AI 分析失敗，請稍後再試");
  }
};