import { OpenAI } from 'openai';
import dotenv from 'dotenv';
dotenv.config();

export const callOpenAICompatible = async (prompt, systemPrompt, isJson = false, model = 'gpt-4o-mini', credential = {}) => {
  const apiKey = credential.api_key || process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OpenAI-compatible provider not configured");

  const client = new OpenAI({
    apiKey,
    baseURL: credential.base_url || process.env.OPENAI_BASE_URL || undefined
  });

  const response = await client.chat.completions.create({
    model: credential.default_model || model,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: prompt }
    ],
    response_format: isJson ? { type: 'json_object' } : undefined,
    temperature: 0.3,
  });

  const text = response.choices[0]?.message?.content;
  if (credential.__return_metadata) {
    return {
      text,
      model: credential.default_model || model,
      usage: response.usage || null,
      raw: response
    };
  }
  return text;
};
