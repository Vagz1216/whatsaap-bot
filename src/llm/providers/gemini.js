import { GoogleGenerativeAI } from '@google/generative-ai';
import dotenv from 'dotenv';
dotenv.config();

const genAI = process.env.GEMINI_API_KEY ? new GoogleGenerativeAI(process.env.GEMINI_API_KEY) : null;

export const callGemini = async (prompt, systemPrompt, isJson = false, modelName = 'gemini-2.5-flash-lite', credential = {}) => {
  const client = credential.api_key ? new GoogleGenerativeAI(credential.api_key) : genAI;
  if (!client) throw new Error("Gemini not configured");

  const model = client.getGenerativeModel({
    model: credential.default_model || modelName,
    systemInstruction: systemPrompt,
    generationConfig: isJson ? { responseMimeType: "application/json" } : {},
  });

  const result = await model.generateContent(prompt);
  return result.response.text();
};
