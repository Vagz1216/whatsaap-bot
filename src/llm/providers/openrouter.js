import fetch from 'node-fetch';
import dotenv from 'dotenv';
dotenv.config();

export const callOpenRouter = async (prompt, systemPrompt, isJson = false, model = 'meta-llama/llama-4-scout:free', credential = {}) => {
  const apiKey = credential.api_key || process.env.OPENROUTER_API_KEY;
  const baseUrl = credential.base_url || "https://openrouter.ai/api/v1";
  if (!apiKey) throw new Error("OpenRouter not configured");

  const response = await fetch(`${baseUrl.replace(/\/$/, '')}/chat/completions`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: credential.default_model || model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: prompt }
      ],
      response_format: isJson ? { type: 'json_object' } : undefined,
      temperature: 0.3
    })
  });

  if (!response.ok) {
    throw new Error(`OpenRouter API error: ${response.statusText}`);
  }

  const data = await response.json();
  const text = data.choices[0]?.message?.content;
  if (credential.__return_metadata) {
    return {
      text,
      model: credential.default_model || model,
      usage: data.usage || null,
      raw: data
    };
  }
  return text;
};
