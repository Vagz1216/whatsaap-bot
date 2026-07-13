import fetch from 'node-fetch';
import dotenv from 'dotenv';
dotenv.config();

export const callOpenRouter = async (prompt, systemPrompt, isJson = false, model = 'meta-llama/llama-4-scout:free') => {
  if (!process.env.OPENROUTER_API_KEY) throw new Error("OpenRouter not configured");

  const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${process.env.OPENROUTER_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model,
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
  return data.choices[0]?.message?.content;
};
