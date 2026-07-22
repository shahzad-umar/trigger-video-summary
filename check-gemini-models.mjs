import { GoogleGenerativeAI } from "@google/generative-ai";
import { config } from "dotenv";

config();

async function checkModels() {
  try {
    const geminiApiKey = process.env.GEMINI_API_KEY;
    if (!geminiApiKey) throw new Error("GEMINI_API_KEY not set");

    const genAI = new GoogleGenerativeAI(geminiApiKey);

    console.log("Checking available Gemini models...\n");

    // List of models to check
    const modelsToCheck = [
      "gemini-1.5-flash",
      "gemini-1.5-pro",
      "gemini-2.0-flash",
      "gemini-pro",
      "gemini-pro-vision",
    ];

    for (const modelName of modelsToCheck) {
      try {
        console.log(`Testing ${modelName}...`);
        const model = genAI.getGenerativeModel({ model: modelName });
        const response = await model.generateContent("Hi");
        console.log(`✅ ${modelName} - AVAILABLE\n`);
      } catch (error) {
        console.log(`❌ ${modelName} - NOT AVAILABLE`);
        console.log(`   Error: ${error.message}\n`);
      }
    }

  } catch (error) {
    console.error("Error:", error.message);
  }
}

checkModels();
