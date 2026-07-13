import { Groq } from 'groq-sdk';
import dotenv from 'dotenv';
dotenv.config();

const groq = process.env.GROQ_API_KEY ? new Groq({ apiKey: process.env.GROQ_API_KEY }) : null;

export const callGroq = async (prompt, systemPrompt, isJson = false, model = 'llama-3.3-70b-versatile') => {
  if (!groq) throw new Error("Groq not configured");

  const response = await groq.chat.completions.create({
    model,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: prompt }
    ],
    response_format: isJson ? { type: 'json_object' } : undefined,
    temperature: 0.3,
  });

  return response.choices[0]?.message?.content;
};
