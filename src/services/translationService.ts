import dotenv from "dotenv";

dotenv.config();

const DEEPL_API_KEY = process.env.DEEPL_API_KEY || "";
const DEEPL_API_URL = "https://api-free.deepl.com/v2/translate";

export interface TranslationResult {
  text: string;
  detectedSourceLanguage?: string;
}

interface DeepLTranslation {
  text: string;
  detected_source_language?: string;
}

interface DeepLResponse {
  translations: DeepLTranslation[];
}

/**
 * Translate text using DeepL API
 * @param text - Text to translate
 * @param targetLang - Target language code (default: ES for Spanish)
 * @returns Translation result
 */
export async function translate(
  text: string,
  targetLang: string = "ES",
): Promise<TranslationResult> {
  if (!DEEPL_API_KEY) {
    throw new Error("DeepL API key not configured");
  }

  if (!text || text.trim().length === 0) {
    throw new Error("Text is required for translation");
  }

  const response = await fetch(DEEPL_API_URL, {
    method: "POST",
    headers: {
      Authorization: `DeepL-Auth-Key ${DEEPL_API_KEY}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      text: text,
      target_lang: targetLang,
    }).toString(),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`DeepL API error: ${response.status} - ${errorText}`);
  }

  const data = (await response.json()) as DeepLResponse;

  if (!data.translations || data.translations.length === 0) {
    throw new Error("No translation returned from DeepL");
  }

  return {
    text: data.translations[0].text,
    detectedSourceLanguage: data.translations[0].detected_source_language,
  };
}
