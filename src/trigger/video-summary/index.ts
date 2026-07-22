import { task } from "@trigger.dev/sdk";
import { exec } from "child_process";
import { promisify } from "util";
import * as fs from "fs";
import * as path from "path";

const execAsync = promisify(exec);

interface VideoSummaryInput {
  videoUrl: string;
}

interface FrameAnalysis {
  timestamp: number;
  isInfographic: boolean;
  description: string;
  mermaidDiagram?: string;
}

export const videoSummaryTask = task({
  id: "video-summary",
  run: async (payload: VideoSummaryInput) => {
    const { videoUrl } = payload;

    // Validate environment variables
    const youtubeApiKey = process.env.YOUTUBE_API_KEY;
    const mistralApiKey = process.env.MISTRAL_API_KEY;

    if (!youtubeApiKey) throw new Error("YOUTUBE_API_KEY is not set");
    if (!mistralApiKey) throw new Error("MISTRAL_API_KEY is not set");

    // Extract video ID from YouTube URL
    const videoId = extractVideoId(videoUrl);
    if (!videoId) throw new Error("Invalid YouTube URL");

    console.log(`Processing video: ${videoId}`);

    // Step 1: Get video metadata
    const videoData = await getVideoMetadata(videoId, youtubeApiKey);
    const videoTitle = videoData.title;

    console.log(`Video title: ${videoTitle}`);

    // Step 2: Get transcript
    const transcript = await getTranscript(videoId);
    if (!transcript) {
      throw new Error("Could not extract transcript from video");
    }

    console.log(`Transcript extracted: ${transcript.substring(0, 100)}...`);

    // Step 3: Download video and extract frames
    const videoPath = await downloadVideo(videoId);
    const frames = await extractFrames(videoPath, videoId);

    console.log(`Extracted ${frames.length} frames`);

    // Step 4: Analyze frames with Mistral Vision (sample first 10 frames)
    const frameAnalyses: FrameAnalysis[] = [];
    const framesToAnalyze = frames.slice(0, Math.min(10, frames.length));

    for (let i = 0; i < framesToAnalyze.length; i++) {
      const frame = framesToAnalyze[i];
      const analysis = await analyzeFrame(mistralApiKey, frame.path, frame.timestamp);
      frameAnalyses.push(analysis);
      console.log(`Analyzed frame ${i + 1}/${framesToAnalyze.length}`);
    }

    // Step 5: Summarize transcript with Mistral
    const summary = await summarizeTranscript(mistralApiKey, transcript);

    // Step 6: Generate Mermaid diagrams from transcript content
    const diagrams = await generateDiagrams(mistralApiKey, transcript);

    // Step 7: Generate markdown output
    const markdown = generateMarkdown(
      videoTitle,
      summary,
      frameAnalyses,
      diagrams
    );

    console.log("\n=== VIDEO SUMMARY ===\n");
    console.log(markdown);

    // Cleanup
    await cleanup(videoPath);
    await cleanupFrames(`frames-${videoId}`);

    return {
      videoId,
      videoTitle,
      summary,
      frameCount: frames.length,
      analyzedFrames: frameAnalyses.length,
      markdown,
    };
  },
});

function extractVideoId(url: string): string | null {
  const patterns = [
    /(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/)([^&\n?#]+)/,
  ];

  for (const pattern of patterns) {
    const match = url.match(pattern);
    if (match) return match[1];
  }

  return null;
}

async function getVideoMetadata(
  videoId: string,
  apiKey: string
): Promise<{ title: string; description: string; duration: string }> {
  const url = `https://www.googleapis.com/youtube/v3/videos?id=${videoId}&key=${apiKey}&part=snippet,contentDetails`;

  try {
    const response = await fetch(url);
    const data = (await response.json()) as any;
    const items = data.items;

    if (!items || items.length === 0) {
      throw new Error("Video not found");
    }

    const snippet = items[0].snippet;
    return {
      title: snippet.title,
      description: snippet.description,
      duration: items[0].contentDetails.duration,
    };
  } catch (error) {
    console.error("Error fetching video metadata:", error);
    throw new Error("Failed to fetch video metadata");
  }
}

async function getTranscript(videoId: string): Promise<string> {
  try {
    await execAsync(
      `yt-dlp --write-auto-sub --sub-lang en --skip-download -o "%(id)s" "${videoId}"`
    );

    const subFile = `${videoId}.en.vtt`;
    if (fs.existsSync(subFile)) {
      let content = fs.readFileSync(subFile, "utf-8");
      content = content
        .replace(/WEBVTT\n\n/, "")
        .replace(/^\d{2}:\d{2}:\d{2}\.\d{3} --> \d{2}:\d{2}:\d{2}\.\d{3}\n/gm, "")
        .replace(/\n\n/g, " ");
      fs.unlinkSync(subFile);
      return content;
    }

    return "";
  } catch (error) {
    console.error("Error fetching transcript:", error);
    return "";
  }
}

async function downloadVideo(videoId: string): Promise<string> {
  const videoPath = `/tmp/${videoId}.mp4`;

  try {
    await execAsync(
      `yt-dlp -f "best[ext=mp4]" -o "${videoPath}" "https://www.youtube.com/watch?v=${videoId}"`
    );
    console.log(`Downloaded video to ${videoPath}`);
    return videoPath;
  } catch (error) {
    console.error("Error downloading video:", error);
    throw new Error("Failed to download video");
  }
}

async function extractFrames(
  videoPath: string,
  videoId: string
): Promise<Array<{ path: string; timestamp: number }>> {
  const framesDir = `/tmp/frames-${videoId}`;

  if (!fs.existsSync(framesDir)) {
    fs.mkdirSync(framesDir, { recursive: true });
  }

  try {
    await execAsync(
      `ffmpeg -i "${videoPath}" -vf "fps=1/15" "${framesDir}/frame-%03d.jpg" -loglevel error`
    );

    const files = fs.readdirSync(framesDir).sort();
    const frames = files.map((file, index) => ({
      path: path.join(framesDir, file),
      timestamp: index * 15,
    }));

    console.log(`Extracted ${frames.length} frames`);
    return frames;
  } catch (error) {
    console.error("Error extracting frames:", error);
    return [];
  }
}

async function analyzeFrame(
  mistralApiKey: string,
  framePath: string,
  timestamp: number
): Promise<FrameAnalysis> {
  try {
    const imageData = fs.readFileSync(framePath);
    const base64Image = imageData.toString("base64");

    const response = await fetch("https://api.mistral.ai/v1/chat/completions", {
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
Format: IS_INFOGRAPHIC: [yes/no] | DESCRIPTION: [description]`,
              },
              {
                type: "image_url",
                image_url: `data:image/jpeg;base64,${base64Image}`,
              },
            ],
          },
        ],
      }),
    });

    const data = (await response.json()) as any;
    const text = data.choices[0].message.content;

    let isInfographic = false;
    let description = "";

    if (text.includes("yes")) {
      isInfographic = true;
      const descStart = text.indexOf("DESCRIPTION:") + 12;
      description = text.substring(descStart).trim().split("\n")[0];
    }

    return {
      timestamp,
      isInfographic,
      description,
    };
  } catch (error) {
    console.error(`Error analyzing frame at ${timestamp}s:`, error);
    return {
      timestamp,
      isInfographic: false,
      description: "Could not analyze frame",
    };
  }
}

async function summarizeTranscript(
  mistralApiKey: string,
  transcript: string
): Promise<string> {
  try {
    const response = await fetch("https://api.mistral.ai/v1/chat/completions", {
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
    });

    const data = (await response.json()) as any;
    return data.choices[0].message.content;
  } catch (error) {
    console.error("Error summarizing transcript:", error);
    throw new Error("Failed to summarize transcript");
  }
}

async function generateDiagrams(
  mistralApiKey: string,
  transcript: string
): Promise<string> {
  try {
    const response = await fetch("https://api.mistral.ai/v1/chat/completions", {
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
Provide ONLY the Mermaid code blocks, no explanation.

Transcript excerpt:
${transcript.substring(0, 2000)}...

Format each diagram as:
\`\`\`mermaid
[diagram code]
\`\`\``,
          },
        ],
      }),
    });

    const data = (await response.json()) as any;
    return data.choices[0].message.content;
  } catch (error) {
    console.error("Error generating diagrams:", error);
    return "";
  }
}

function generateMarkdown(
  title: string,
  summary: string,
  frameAnalyses: FrameAnalysis[],
  diagrams: string
): string {
  let markdown = `# ${title}\n\n`;

  markdown += `## Summary\n\n${summary}\n\n`;

  // Add visual content
  const infographics = frameAnalyses.filter((f) => f.isInfographic);
  if (infographics.length > 0) {
    markdown += `## Visual Content from Video\n\n`;

    for (const infographic of infographics) {
      markdown += `### Screenshot at ${infographic.timestamp}s\n`;
      markdown += `${infographic.description}\n\n`;
    }
  }

  // Add generated diagrams
  if (diagrams && diagrams.trim().length > 0) {
    markdown += `## Concept Diagrams\n\n${diagrams}\n\n`;
  }

  return markdown;
}

async function cleanup(videoPath: string): Promise<void> {
  try {
    if (fs.existsSync(videoPath)) {
      fs.unlinkSync(videoPath);
    }
  } catch (error) {
    console.error("Error cleaning up video:", error);
  }
}

async function cleanupFrames(framesDir: string): Promise<void> {
  try {
    if (fs.existsSync(framesDir)) {
      const files = fs.readdirSync(framesDir);
      for (const file of files) {
        fs.unlinkSync(path.join(framesDir, file));
      }
      fs.rmdirSync(framesDir);
    }
  } catch (error) {
    console.error("Error cleaning up frames:", error);
  }
}
