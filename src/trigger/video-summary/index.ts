import { task } from "@trigger.dev/sdk";
import { exec } from "child_process";
import { promisify } from "util";
import * as fs from "fs";
import * as path from "path";
import { GoogleGenerativeAI } from "@google/generative-ai";

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

export const videoSummaryTask = task<VideoSummaryInput>({
  id: "video-summary",
  run: async (payload) => {
    const { videoUrl } = payload;

    // Validate environment variables
    const youtubeApiKey = process.env.YOUTUBE_API_KEY;
    const geminiApiKey = process.env.GEMINI_API_KEY;

    if (!youtubeApiKey) throw new Error("YOUTUBE_API_KEY is not set");
    if (!geminiApiKey) throw new Error("GEMINI_API_KEY is not set");

    // Initialize Gemini client
    const genAI = new GoogleGenerativeAI(geminiApiKey);
    const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

    // Extract video ID from YouTube URL
    const videoId = extractVideoId(videoUrl);
    if (!videoId) throw new Error("Invalid YouTube URL");

    console.log(`Processing video: ${videoId}`);

    // Step 1: Get video metadata
    const videoData = await getVideoMetadata(videoId, youtubeApiKey);
    const videoTitle = videoData.title;
    const videoDescription = videoData.description;

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

    // Step 4: Analyze frames with Gemini Vision
    const frameAnalyses: FrameAnalysis[] = [];
    for (let i = 0; i < frames.length; i++) {
      const frame = frames[i];
      const analysis = await analyzeFrame(model, frame.path, frame.timestamp);
      frameAnalyses.push(analysis);
      console.log(`Analyzed frame ${i + 1}/${frames.length}`);
    }

    // Step 5: Summarize transcript with Gemini
    const summary = await summarizeTranscript(model, transcript);

    // Step 6: Generate markdown output
    const markdown = generateMarkdown(
      videoTitle,
      summary,
      frameAnalyses,
      frames
    );

    console.log("\n=== VIDEO SUMMARY ===\n");
    console.log(markdown);

    // Cleanup
    await cleanup(videoPath);

    return {
      videoId,
      videoTitle,
      summary,
      frameCount: frames.length,
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
    const data = await response.json() as any;
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
    // Try to fetch captions using yt-dlp via exec
    const { stdout } = await execAsync(
      `yt-dlp --write-auto-sub --sub-lang en --skip-download -o "%(id)s" "${videoId}"`
    );

    // Read the subtitle file
    const subFile = `${videoId}.en.vtt`;
    if (fs.existsSync(subFile)) {
      let content = fs.readFileSync(subFile, "utf-8");
      // Remove VTT formatting
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
    // Extract frames every 15 seconds
    await execAsync(
      `ffmpeg -i "${videoPath}" -vf "fps=1/15" "${framesDir}/frame-%03d.jpg"`
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
  model: any,
  framePath: string,
  timestamp: number
): Promise<FrameAnalysis> {
  try {
    const imageData = fs.readFileSync(framePath);
    const base64Image = imageData.toString("base64");

    const response = await model.generateContent([
      {
        inlineData: {
          data: base64Image,
          mimeType: "image/jpeg",
        },
      },
      {
        text: `Analyze this frame from a video at timestamp ${timestamp}s.

        1. Is this an infographic, diagram, chart, or visual instruction? Answer yes or no.
        2. Briefly describe what you see (1-2 sentences).
        3. If it's an infographic/diagram, provide a Mermaid diagram representation.

        Format your response as:
        IS_INFOGRAPHIC: [yes/no]
        DESCRIPTION: [description]
        MERMAID: [optional mermaid code block if applicable]`,
      },
    ]);

    const text = response.response.text();
    const lines = text.split("\n");

    let isInfographic = false;
    let description = "";
    let mermaidDiagram: string | undefined;

    for (const line of lines) {
      if (line.startsWith("IS_INFOGRAPHIC:")) {
        isInfographic = line.includes("yes");
      } else if (line.startsWith("DESCRIPTION:")) {
        description = line.replace("DESCRIPTION:", "").trim();
      } else if (line.startsWith("MERMAID:")) {
        mermaidDiagram = line.replace("MERMAID:", "").trim();
      }
    }

    return {
      timestamp,
      isInfographic,
      description,
      mermaidDiagram,
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
  model: any,
  transcript: string
): Promise<string> {
  try {
    const response = await model.generateContent(`
    Summarize the following video transcript into a nested bulleted list.
    Each main topic should be a top-level bullet, with key points as sub-bullets.
    Keep each point to 1-2 sentences maximum.

    Transcript:
    ${transcript}

    Format the output as a clean bulleted markdown list.`);

    return response.response.text();
  } catch (error) {
    console.error("Error summarizing transcript:", error);
    throw new Error("Failed to summarize transcript");
  }
}

function generateMarkdown(
  title: string,
  summary: string,
  frameAnalyses: FrameAnalysis[],
  frames: Array<{ path: string; timestamp: number }>
): string {
  let markdown = `# ${title}\n\n`;

  markdown += `## Summary\n\n${summary}\n\n`;

  // Add visual content
  const infographics = frameAnalyses.filter((f) => f.isInfographic);
  if (infographics.length > 0) {
    markdown += `## Visual Content & Diagrams\n\n`;

    for (const infographic of infographics) {
      if (infographic.mermaidDiagram) {
        markdown += `### At ${infographic.timestamp}s\n\n`;
        markdown += `\`\`\`mermaid\n${infographic.mermaidDiagram}\n\`\`\`\n\n`;
        markdown += `${infographic.description}\n\n`;
      }
    }
  }

  // Add key frames
  const keyFrames = frameAnalyses
    .filter((f) => f.description && !f.isInfographic)
    .slice(0, 5);
  if (keyFrames.length > 0) {
    markdown += `## Key Moments\n\n`;

    for (const keyFrame of keyFrames) {
      const frameIndex = Math.floor(keyFrame.timestamp / 15);
      markdown += `**At ${keyFrame.timestamp}s:** ${keyFrame.description}\n\n`;
    }
  }

  return markdown;
}

async function cleanup(videoPath: string): Promise<void> {
  try {
    if (fs.existsSync(videoPath)) {
      fs.unlinkSync(videoPath);
    }
  } catch (error) {
    console.error("Error cleaning up:", error);
  }
}
