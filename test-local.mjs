import { exec } from "child_process";
import { promisify } from "util";
import * as fs from "fs";
import * as path from "path";
import { config } from "dotenv";

const execAsync = promisify(exec);

async function testVideoSummary() {
  try {
    config();

    console.log("🎬 Starting local video summary test...\n");

    const videoUrl = process.argv[2] || "https://www.youtube.com/watch?v=dQw4w9WgXcQ";
    const youtubeApiKey = process.env.YOUTUBE_API_KEY;
    const mistralApiKey = process.env.MISTRAL_API_KEY;

    if (!youtubeApiKey) throw new Error("YOUTUBE_API_KEY is not set");
    if (!mistralApiKey) throw new Error("MISTRAL_API_KEY is not set");

    const videoIdMatch = videoUrl.match(/(?:youtube\.com\/watch\?v=|youtu\.be\/)([^&\n?#]+)/);
    if (!videoIdMatch) throw new Error("Invalid YouTube URL");
    const videoId = videoIdMatch[1];

    console.log(`✅ Video ID: ${videoId}`);

    // Get video metadata
    console.log("📥 Fetching video metadata...");
    const metadataUrl = `https://www.googleapis.com/youtube/v3/videos?id=${videoId}&key=${youtubeApiKey}&part=snippet,contentDetails`;
    const metadataResponse = await fetch(metadataUrl);
    const metadataData = await metadataResponse.json();

    if (!metadataData.items || metadataData.items.length === 0) {
      throw new Error("Video not found");
    }

    const title = metadataData.items[0].snippet.title;
    const description = metadataData.items[0].snippet.description;

    console.log(`✅ Title: ${title}`);
    console.log(`✅ Description: ${description.substring(0, 100)}...`);

    // Get transcript
    console.log("\n📥 Fetching transcript...");
    const ytdlpPath = "C:\\Users\\HP\\AppData\\Local\\Packages\\PythonSoftwareFoundation.Python.3.12_qbz5n2kfra8p0\\LocalCache\\local-packages\\Python312\\Scripts\\yt-dlp.exe";

    try {
      await execAsync(
        `"${ytdlpPath}" --write-auto-sub --sub-lang en --skip-download -o "%(id)s" "${videoId}"`
      );

      const subFile = `${videoId}.en.vtt`;
      let transcript = "";

      if (fs.existsSync(subFile)) {
        transcript = fs.readFileSync(subFile, "utf-8");
        transcript = transcript
          .replace(/WEBVTT\n\n/, "")
          .replace(/^\d{2}:\d{2}:\d{2}\.\d{3} --> \d{2}:\d{2}:\d{2}\.\d{3}\n/gm, "")
          .replace(/\n\n/g, " ");
        fs.unlinkSync(subFile);
      }

      console.log(`✅ Transcript retrieved: ${transcript.substring(0, 100)}...`);

      // Download video for frame extraction
      console.log("\n📥 Downloading video for frame analysis...");
      await execAsync(
        `"${ytdlpPath}" -f "best[ext=mp4]" -o "${videoId}.mp4" "https://www.youtube.com/watch?v=${videoId}"`
      );
      console.log(`✅ Video downloaded`);

      // Extract frames every 15 seconds
      console.log("\n🖼️  Extracting frames every 15 seconds...");
      const framesDir = `frames-${videoId}`;
      if (!fs.existsSync(framesDir)) {
        fs.mkdirSync(framesDir, { recursive: true });
      }

      await execAsync(
        `"C:\\ffmpeg\\bin\\ffmpeg.exe" -i "${videoId}.mp4" -vf "fps=1/15" "${framesDir}/frame-%03d.jpg" -loglevel error`
      );

      const frameFiles = fs.readdirSync(framesDir).filter(f => f.startsWith("frame-")).sort();
      console.log(`✅ Extracted ${frameFiles.length} frames`);

      // Analyze frames for infographics
      console.log("\n🔍 Analyzing frames for infographics...");
      const infographicFrames = [];

      for (let i = 0; i < Math.min(frameFiles.length, 5); i++) {
        const framePath = path.join(framesDir, frameFiles[i]);
        const frameData = fs.readFileSync(framePath);
        const base64Frame = frameData.toString("base64");
        const timestamp = i * 15;

        try {
          const analysisResponse = await fetch(
            "https://api.mistral.ai/v1/chat/completions",
            {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${mistralApiKey}`,
              },
              body: JSON.stringify({
                model: "pixtral-12b-2409",
                messages: [
                  {
                    role: "user",
                    content: [
                      {
                        type: "text",
                        text: `Analyze this video frame at ${timestamp}s.
                        Is this an infographic, diagram, chart, or process flow?
                        If yes, describe it briefly (1-2 sentences). If no, just say "no infographic".
                        Format: START_ANALYSIS [yes/no] DESCRIPTION [description] END_ANALYSIS`,
                      },
                      {
                        type: "image_url",
                        image_url: `data:image/jpeg;base64,${base64Frame}`,
                      },
                    ],
                  },
                ],
              }),
            }
          );

          const analysisData = await analysisResponse.json();
          const analysis = analysisData.choices[0].message.content;

          if (analysis.includes("yes")) {
            console.log(`✅ Frame ${i} at ${timestamp}s: Infographic detected`);
            infographicFrames.push({
              timestamp,
              index: i,
              description: analysis.split("DESCRIPTION")[1]?.split("END_ANALYSIS")[0]?.trim() || "Infographic",
              path: framePath,
            });
          }
        } catch (error) {
          console.log(`⚠️  Frame ${i} analysis skipped: ${error.message}`);
        }
      }

      // Summarize transcript with Mistral
      console.log("\n🤖 Summarizing with Mistral...");
      const mistralResponse = await fetch(
        "https://api.mistral.ai/v1/chat/completions",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${mistralApiKey}`,
          },
          body: JSON.stringify({
            model: "mistral-small-latest",
            messages: [
              {
                role: "user",
                content: `Summarize the following video transcript into a nested bulleted list.
Each main topic should be a top-level bullet, with key points as sub-bullets.
Keep each point to 1-2 sentences maximum.

Transcript:
${transcript}

Format the output as a clean bulleted markdown list.`,
              },
            ],
          }),
        }
      );

      const mistralData = await mistralResponse.json();
      const summary = mistralData.choices[0].message.content;

      // Generate Mermaid diagrams from transcript
      console.log("\n📊 Generating Mermaid diagrams from content...");
      const diagramResponse = await fetch(
        "https://api.mistral.ai/v1/chat/completions",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${mistralApiKey}`,
          },
          body: JSON.stringify({
            model: "mistral-small-latest",
            messages: [
              {
                role: "user",
                content: `Based on this video transcript, create 1-2 Mermaid diagrams that visualize the key concepts or processes.
Choose the most appropriate diagram type (flowchart, graph, mindmap, etc.).
Provide ONLY the Mermaid code, no explanation.

Transcript excerpt:
${transcript.substring(0, 2000)}...

Format each diagram as:
\`\`\`mermaid
[diagram code]
\`\`\``,
              },
            ],
          }),
        }
      );

      const diagramData = await diagramResponse.json();
      const diagrams = diagramData.choices[0].message.content;

      console.log("✅ Diagrams generated!");

      // Output full report
      console.log("\n" + "=".repeat(50));
      console.log(`# ${title}\n`);
      console.log("## Summary\n");
      console.log(summary);

      if (infographicFrames.length > 0) {
        console.log("\n## Visual Content from Video\n");
        infographicFrames.forEach((frame, idx) => {
          console.log(`### Screenshot at ${frame.timestamp}s`);
          console.log(`${frame.description}\n`);
          console.log(`*[Frame ${frame.index + 1}]*\n`);
        });
      }

      console.log("\n## Concept Diagrams\n");
      console.log(diagrams);

      console.log("\n" + "=".repeat(50));

      // Cleanup
      fs.unlinkSync(`${videoId}.mp4`);
      frameFiles.forEach(f => fs.unlinkSync(path.join(framesDir, f)));
      fs.rmdirSync(framesDir);

    } catch (error) {
      console.error("❌ Error:", error.message);
      throw error;
    }

  } catch (error) {
    console.error("\n❌ Fatal Error:", error.message);
    process.exit(1);
  }
}

testVideoSummary();
