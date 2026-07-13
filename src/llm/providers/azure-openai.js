import { OpenAI } from 'openai';
import dotenv from 'dotenv';
dotenv.config();

const isConfigured = Boolean(
  process.env.AZURE_OPENAI_API_KEY &&
  process.env.AZURE_OPENAI_ENDPOINT &&
  process.env.AZURE_OPENAI_DEPLOYMENT_NAME
);

const client = isConfigured ? new OpenAI({
  apiKey: process.env.AZURE_OPENAI_API_KEY,
  baseURL: `${process.env.AZURE_OPENAI_ENDPOINT}/openai/deployments/${process.env.AZURE_OPENAI_DEPLOYMENT_NAME}`,
  defaultQuery: { 'api-version': '2023-12-01-preview' },
  defaultHeaders: { 'api-key': process.env.AZURE_OPENAI_API_KEY }
}) : null;

export const callAzureOpenAI = async (prompt, systemPrompt, isJson = false) => {
  if (!client) throw new Error("Azure OpenAI not configured");

  const response = await client.chat.completions.create({
    model: process.env.AZURE_OPENAI_DEPLOYMENT_NAME || 'gpt-35-turbo',
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: prompt }
    ],
    response_format: isJson ? { type: 'json_object' } : undefined,
    temperature: 0.3,
  });

  return response.choices[0].message.content;
};
